import { describe, expect, it } from "vitest";
import { createAnthropicProvider, type FetchLike } from "../src/index.js";

type RecordedFetchCall = {
  input: string | URL;
  init?: RequestInit;
  body?: unknown;
};

function createRecordingFetch(handler: (call: RecordedFetchCall) => Response | Promise<Response>) {
  const calls: RecordedFetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call = { input, init, body };
    calls.push(call);
    return handler(call);
  };

  return { calls, fetch };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

function textResponse(value: string, init: ResponseInit = {}): Response {
  return new Response(value, init);
}

function expectObject(value: unknown, label = "value"): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function expectHeader(init: RequestInit | undefined, key: string): string | undefined {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([headerKey]) => headerKey.toLowerCase() === key.toLowerCase())?.[1];
  }
  return (headers as Record<string, string | undefined> | undefined)?.[key];
}

const apiKey = "sk-ant-test-secret123456";
const genericApiKey = "anthropic-provider-token-secret-123456";
const model = "claude-sonnet-4-5";

describe("Anthropic provider", () => {
  it("validates credentials by retrieving the configured model", async () => {
    const { calls, fetch } = createRecordingFetch(() => jsonResponse({ id: model }, { status: 200 }));
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    await expect(provider.validateCredentials()).resolves.toMatchObject({
      ok: true,
      providerId: "anthropic"
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://api.anthropic.com/v1/models/claude-sonnet-4-5");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(expectHeader(calls[0]?.init, "anthropic-version")).toBe("2023-06-01");
    expect(expectHeader(calls[0]?.init, "x-api-key")).toBe(apiKey);
  });

  it.each([401, 403, 404] as const)("returns sanitized recoverable credential validation errors for %s", async (status) => {
    const { fetch } = createRecordingFetch(() =>
      jsonResponse({
        type: "error",
        error: {
          type: "authentication_error",
          message: `Invalid x-api-key ${apiKey}`
        }
      }, { status, statusText: `HTTP ${status}` })
    );
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    const result = await provider.validateCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`credential validation failed (${status})`);
      expect(result.reason).toContain("sk-[redacted]");
      expect(result.reason).not.toContain(apiKey);
      expect(result.recoverable).toBe(true);
    }
  });

  it("redacts non-sk keys and fetch exceptions", async () => {
    const validationFetch = createRecordingFetch(() =>
      jsonResponse({
        type: "error",
        error: {
          type: "authentication_error",
          message: `Invalid x-api-key ${genericApiKey}`
        }
      }, { status: 401, statusText: "Unauthorized" })
    ).fetch;
    const validationProvider = createAnthropicProvider({
      apiKey: genericApiKey,
      fetch: validationFetch,
      model
    });

    const validation = await validationProvider.validateCredentials();

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toContain("[redacted]");
      expect(validation.reason).not.toContain(genericApiKey);
    }

    const throwingFetch: FetchLike = async () => {
      throw new Error(`Network failed for ${genericApiKey}`);
    };
    const completionProvider = createAnthropicProvider({
      apiKey: genericApiKey,
      fetch: throwingFetch,
      model
    });

    await expect(completionProvider.complete({
      input: {},
      prompt: "Review",
      runId: "run-fetch-error",
      stage: "review"
    })).rejects.toThrow("Network failed for [redacted]");
  });

  it("requests forced Messages API tool output and parses build source writes", async () => {
    const controller = new AbortController();
    const { calls, fetch } = createRecordingFetch(() =>
      jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_build",
            name: "htmlslide_build_output",
            input: {
              filesChanged: ["slides/001-title.html"],
              slidesChanged: ["slides/001-title.html"],
              notesChanged: ["notes/001-title.md"],
              themeChanged: ["theme/theme.css"],
              sourceWrites: [
                {
                  path: "slides/001-title.html",
                  content: "<section class=\"slide\" data-slide-id=\"001-title\"></section>\n"
                }
              ]
            }
          }
        ],
        usage: {
          input_tokens: 101,
          output_tokens: 37
        }
      }, { status: 200 })
    );
    const provider = createAnthropicProvider({ apiKey, fetch, maxTokens: 4096, model });

    const response = await provider.complete({
      input: {
        title: "Quarterly Review"
      },
      metadata: {
        source: "test"
      },
      prompt: "Build the deck source.",
      runId: "run-provider-build",
      signal: controller.signal,
      stage: "build"
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(expectHeader(calls[0]?.init, "anthropic-version")).toBe("2023-06-01");
    expect(expectHeader(calls[0]?.init, "x-api-key")).toBe(apiKey);

    const body = expectObject(calls[0]?.body, "message body");
    expect(body.model).toBe(model);
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBeTypeOf("string");
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "htmlslide_build_output"
    });
    const tools = body.tools;
    expect(Array.isArray(tools)).toBe(true);
    const tool = expectObject((tools as unknown[])[0], "tool");
    expect(tool.name).toBe("htmlslide_build_output");
    expect(tool.strict).toBe(true);
    const schema = expectObject(tool.input_schema, "input schema");
    const properties = expectObject(schema.properties, "schema.properties");
    expect(properties.sourceWrites).toBeDefined();
    expect(schema.required).toContain("sourceWrites");

    const messages = body.messages;
    expect(Array.isArray(messages)).toBe(true);
    const userMessage = expectObject((messages as unknown[])[0], "user message");
    const userInput = expectObject(JSON.parse(userMessage.content as string), "user message content");
    expect(userInput.stage).toBe("build");
    expect(userInput.metadata).toEqual({ source: "test" });

    expect(response.output).toEqual({
      filesChanged: ["slides/001-title.html"],
      slidesChanged: ["slides/001-title.html"],
      notesChanged: ["notes/001-title.md"],
      themeChanged: ["theme/theme.css"],
      sourceWrites: [
        {
          path: "slides/001-title.html",
          content: "<section class=\"slide\" data-slide-id=\"001-title\"></section>\n"
        }
      ]
    });
    expect(response.usage).toEqual({
      inputTokens: 101,
      outputTokens: 37,
      totalTokens: 138
    });
  });

  it("throws sanitized completion errors without leaking the API key", async () => {
    const { fetch } = createRecordingFetch(() =>
      jsonResponse({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: `Request failed for ${apiKey}`
        }
      }, { status: 429, statusText: "Too Many Requests" })
    );
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    try {
      await provider.complete({
        input: {},
        prompt: "Build",
        runId: "run-provider-error",
        stage: "build"
      });
      throw new Error("Expected provider.complete to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("sk-[redacted]");
      expect(message).not.toContain(apiKey);
    }
  });

  it("propagates abort signals and rejects when the request is aborted", async () => {
    const controller = new AbortController();
    const { calls, fetch } = createRecordingFetch((call) => {
      const signal = call.init?.signal;
      expect(signal).toBe(controller.signal);
      if (!signal) {
        throw new Error("Expected fetch signal");
      }

      return new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    });
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    const pending = provider.complete({
      input: {},
      prompt: "Review",
      runId: "run-aborted",
      signal: controller.signal,
      stage: "review"
    });
    controller.abort();

    await expect(pending).rejects.toThrow("Anthropic provider request failed: The operation was aborted.");
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("sanitizes timeout-like fetch rejections", async () => {
    const timeoutFetch: FetchLike = async () => {
      throw new DOMException(`The operation timed out for ${apiKey}`, "TimeoutError");
    };
    const provider = createAnthropicProvider({ apiKey, fetch: timeoutFetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Review",
      runId: "run-timeout",
      stage: "review"
    })).rejects.toThrow("Anthropic provider request failed: The operation timed out for sk-[redacted]");
  });

  it("rejects missing or malformed tool use content", async () => {
    const missingToolFetch = createRecordingFetch(() =>
      jsonResponse({
        content: [
          {
            type: "text",
            text: "No tool call."
          }
        ]
      }, { status: 200 })
    ).fetch;
    const missingToolProvider = createAnthropicProvider({ apiKey, fetch: missingToolFetch, model });

    await expect(missingToolProvider.complete({
      input: {},
      prompt: "Build",
      runId: "run-missing-tool",
      stage: "build"
    })).rejects.toThrow("returned no htmlslide_build_output tool_use content");

    const malformedInputFetch = createRecordingFetch(() =>
      jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_bad",
            name: "htmlslide_build_output",
            input: "not-object"
          }
        ]
      }, { status: 200 })
    ).fetch;
    const malformedInputProvider = createAnthropicProvider({ apiKey, fetch: malformedInputFetch, model });

    await expect(malformedInputProvider.complete({
      input: {},
      prompt: "Build",
      runId: "run-malformed-tool-input",
      stage: "build"
    })).rejects.toThrow("tool input must be a JSON object");
  });

  it("requires build and repair outputs to include source writes", async () => {
    const { fetch } = createRecordingFetch((call) => {
      const body = expectObject(call.body, "message body");
      const messages = body.messages;
      expect(Array.isArray(messages)).toBe(true);
      const userMessage = expectObject((messages as unknown[])[0], "user message");
      const userInput = expectObject(JSON.parse(userMessage.content as string), "user input");
      const stage = userInput.stage;
      const input = stage === "repair"
        ? {
            attempt: 1,
            filesChanged: [],
            issuesAddressed: []
          }
        : {
            filesChanged: [],
            slidesChanged: [],
            notesChanged: [],
            themeChanged: []
          };

      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_missing_writes",
            name: `htmlslide_${stage}_output`,
            input
          }
        ]
      }, { status: 200 });
    });
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Build",
      runId: "run-provider-missing-writes",
      stage: "build"
    })).rejects.toThrow("Expected sourceWrites to be an array.");

    await expect(provider.complete({
      input: {},
      prompt: "Repair",
      runId: "run-provider-missing-repair-writes",
      stage: "repair"
    })).rejects.toThrow("Expected sourceWrites to be an array.");
  });

  it("rejects unsafe source writes before returning provider output", async () => {
    const { fetch } = createRecordingFetch(() =>
      jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_unsafe",
            name: "htmlslide_build_output",
            input: {
              filesChanged: ["exports/deck.html"],
              slidesChanged: [],
              notesChanged: [],
              themeChanged: [],
              sourceWrites: [
                {
                  path: "exports/deck.html",
                  content: "<!doctype html>\n"
                }
              ]
            }
          }
        ]
      }, { status: 200 })
    );
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Build",
      runId: "run-unsafe-writes",
      stage: "build"
    })).rejects.toThrow("Refusing to write non-source path");
  });

  it("uses the response status text when the provider returns an empty error body", async () => {
    const { fetch } = createRecordingFetch(() => textResponse("", { status: 500, statusText: "Internal Error" }));
    const provider = createAnthropicProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Review",
      runId: "run-empty-error",
      stage: "review"
    })).rejects.toThrow("Internal Error");
  });
});
