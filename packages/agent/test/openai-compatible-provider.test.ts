import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider, type FetchLike } from "../src/index.js";

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

const apiKey = "sk-test-secret123456";
const genericApiKey = "provider-token-secret-123456";
const model = "gpt-test-htmlslide";

describe("OpenAI-compatible provider", () => {
  it("validates credentials by retrieving the configured model", async () => {
    const { calls, fetch } = createRecordingFetch(() => jsonResponse({ id: model }, { status: 200 }));
    const provider = createOpenAICompatibleProvider({
      apiKey,
      baseUrl: "https://example.test/v1/",
      fetch,
      model
    });

    await expect(provider.validateCredentials()).resolves.toMatchObject({
      ok: true,
      providerId: "openai-compatible"
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://example.test/v1/models/gpt-test-htmlslide");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(expectHeader(calls[0]?.init, "authorization")).toBe(`Bearer ${apiKey}`);
  });

  it("returns sanitized credential validation errors", async () => {
    const { fetch } = createRecordingFetch(() =>
      jsonResponse({
        error: {
          message: `Invalid token Bearer ${apiKey}`
        }
      }, { status: 401, statusText: "Unauthorized" })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

    const result = await provider.validateCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Bearer [redacted]");
      expect(result.reason).not.toContain(apiKey);
      expect(result.recoverable).toBe(true);
    }
  });

  it("redacts non-sk compatible keys and fetch exceptions", async () => {
    const validationFetch = createRecordingFetch(() =>
      jsonResponse({
        error: {
          message: `Invalid token ${genericApiKey}`
        }
      }, { status: 401, statusText: "Unauthorized" })
    ).fetch;
    const validationProvider = createOpenAICompatibleProvider({
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
    const completionProvider = createOpenAICompatibleProvider({
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

  it("requests Chat Completions structured outputs and parses build source writes", async () => {
    const controller = new AbortController();
    const { calls, fetch } = createRecordingFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
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
              })
            }
          }
        ],
        usage: {
          prompt_tokens: 101,
          completion_tokens: 37,
          total_tokens: 138
        }
      }, { status: 200 })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model, temperature: 0.1 });

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
    expect(String(calls[0]?.input)).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.signal).toBe(controller.signal);

    const body = expectObject(calls[0]?.body, "chat completion body");
    expect(body.model).toBe(model);
    expect(body.store).toBe(false);
    expect(body.temperature).toBe(0.1);
    const responseFormat = expectObject(body.response_format, "response_format");
    expect(responseFormat.type).toBe("json_schema");
    const jsonSchema = expectObject(responseFormat.json_schema, "json_schema");
    expect(jsonSchema.strict).toBe(true);
    const schema = expectObject(jsonSchema.schema, "schema");
    const properties = expectObject(schema.properties, "schema.properties");
    expect(properties.sourceWrites).toBeDefined();
    const required = schema.required;
    expect(Array.isArray(required)).toBe(true);
    expect(required).toContain("sourceWrites");

    const messages = body.messages;
    expect(Array.isArray(messages)).toBe(true);
    const userMessage = expectObject((messages as unknown[])[1], "user message");
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
        error: {
          message: `Request failed for ${apiKey}`
        }
      }, { status: 429, statusText: "Too Many Requests" })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

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

  it("rejects malformed structured message content", async () => {
    const { fetch } = createRecordingFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: "{not-json"
            }
          }
        ]
      }, { status: 200 })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Build",
      runId: "run-provider-malformed",
      stage: "build"
    })).rejects.toThrow("was not valid JSON");
  });

  it("requires build and repair outputs to include source writes", async () => {
    const { fetch } = createRecordingFetch((call) => {
      const body = expectObject(call.body, "completion body");
      const messages = body.messages;
      expect(Array.isArray(messages)).toBe(true);
      const userMessage = expectObject((messages as unknown[])[1], "user message");
      const userInput = expectObject(JSON.parse(userMessage.content as string), "user input");
      const content = userInput.stage === "repair"
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
        choices: [
          {
            message: {
              content: JSON.stringify(content)
            }
          }
        ]
      }, { status: 200 });
    });
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

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
        choices: [
          {
            message: {
              content: JSON.stringify({
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
              })
            }
          }
        ]
      }, { status: 200 })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Build",
      runId: "run-unsafe-writes",
      stage: "build"
    })).rejects.toThrow("Refusing to write non-source path");
  });

  it("uses nullable schema entries for optional output fields", async () => {
    const { calls, fetch } = createRecordingFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "passed",
                summary: {
                  errors: 0,
                  warnings: 0,
                  info: 1
                },
                issues: [
                  {
                    severity: "info",
                    type: "note",
                    message: "No issues.",
                    path: null,
                    slideId: null,
                    suggestedFix: null
                  }
                ]
              })
            }
          }
        ]
      }, { status: 200 })
    );
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

    const response = await provider.complete({
      input: {},
      prompt: "Check",
      runId: "run-nullable-check",
      stage: "check"
    });

    const body = expectObject(calls[0]?.body, "chat completion body");
    const responseFormat = expectObject(body.response_format, "response_format");
    const jsonSchema = expectObject(responseFormat.json_schema, "json_schema");
    const schema = expectObject(jsonSchema.schema, "schema");
    const properties = expectObject(schema.properties, "schema.properties");
    const issues = expectObject(properties.issues, "issues schema");
    const items = expectObject(issues.items, "issue items schema");
    const issueProperties = expectObject(items.properties, "issue properties");
    expect(expectObject(issueProperties.path, "path schema").type).toEqual(["string", "null"]);
    expect(expectObject(issueProperties.slideId, "slideId schema").type).toEqual(["string", "null"]);
    expect(expectObject(issueProperties.suggestedFix, "suggestedFix schema").type).toEqual(["string", "null"]);

    expect(response.output).toMatchObject({
      status: "passed",
      summary: {
        errors: 0,
        warnings: 0,
        info: 1
      }
    });
    const output = response.output as {
      issues: Array<{
        path?: string;
        slideId?: string;
        suggestedFix?: string;
      }>;
    };
    expect(output.issues[0]?.path).toBeUndefined();
    expect(output.issues[0]?.slideId).toBeUndefined();
    expect(output.issues[0]?.suggestedFix).toBeUndefined();
  });

  it("uses the response status text when the provider returns an empty error body", async () => {
    const { fetch } = createRecordingFetch(() => textResponse("", { status: 500, statusText: "Internal Error" }));
    const provider = createOpenAICompatibleProvider({ apiKey, fetch, model });

    await expect(provider.complete({
      input: {},
      prompt: "Review",
      runId: "run-empty-error",
      stage: "review"
    })).rejects.toThrow("Internal Error");
  });
});
