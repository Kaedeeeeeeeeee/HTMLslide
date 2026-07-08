import type {
  JsonObject,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  TokenUsage
} from "../types.js";
import type { FetchLike } from "./openai-compatible.js";
import {
  coerceStageOutput,
  errorMessageFrom,
  extractErrorMessage,
  isRecord,
  parseOptionalJson,
  sanitizeProviderText,
  schemaForStage,
  stageSchemaName,
  systemPromptForStage
} from "./provider-utils.js";

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  id?: string;
  label?: string;
  maxTokens?: number;
};

type AnthropicMessageResponse = {
  content?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

const anthropicVersion = "2023-06-01";
const defaultBaseUrl = "https://api.anthropic.com/v1";

export class AnthropicModelProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;

  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #maxTokens: number;
  readonly #model: string;

  constructor(options: AnthropicProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("Anthropic API key is required.");
    }

    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("Anthropic model is required.");
    }

    this.id = options.id ?? "anthropic";
    this.label = options.label ?? "Anthropic provider";
    this.#apiKey = apiKey;
    if (options.fetch) {
      this.#fetch = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      this.#fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("A fetch implementation is required for the Anthropic provider.");
    }
    this.#maxTokens = options.maxTokens ?? 8192;
    this.#model = model;
  }

  async validateCredentials() {
    const response = await this.#fetchJson("GET", `/models/${encodeURIComponent(this.#model)}`);
    if (response.ok) {
      return {
        ok: true as const,
        providerId: this.id,
        message: `${this.label} credentials can access ${this.#model}.`
      };
    }

    return {
      ok: false as const,
      providerId: this.id,
      reason: `${this.label} credential validation failed (${response.status}): ${response.message}`,
      recoverable: response.status === 401 || response.status === 403 || response.status === 404
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const toolName = `htmlslide_${stageSchemaName(request.stage)}`;
    const response = await this.#fetchJson("POST", "/messages", {
      max_tokens: this.#maxTokens,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            runId: request.runId,
            stage: request.stage,
            prompt: request.prompt,
            input: request.input,
            metadata: request.metadata ?? {}
          }, null, 2)
        }
      ],
      model: this.#model,
      system: systemPromptForStage(request.stage),
      tool_choice: {
        type: "tool",
        name: toolName
      },
      tools: [
        {
          name: toolName,
          description: `Return the structured HTMLslide ${request.stage} output. Use only the fields in the input schema and include complete sourceWrites for build and repair stages.`,
          input_schema: schemaForStage(request.stage),
          strict: true
        }
      ]
    }, request.signal);

    if (!response.ok) {
      throw new Error(`${this.label} completion failed (${response.status}): ${response.message}`);
    }

    const completion = asAnthropicMessageResponse(response.json);
    const input = toolInputFrom(completion, toolName, this.label);
    const output = coerceStageOutput(request.stage, input);

    return {
      content: `${this.label} returned structured ${request.stage} output.`,
      output,
      metadata: {
        model: this.#model,
        providerId: this.id,
        stage: request.stage
      },
      usage: tokenUsageFrom(completion.usage)
    };
  }

  async #fetchJson(
    method: "GET" | "POST",
    pathname: string,
    body?: JsonObject,
    signal?: AbortSignal
  ): Promise<{
    ok: boolean;
    status: number;
    json?: unknown;
    message: string;
  }> {
    let response: Response;
    try {
      response = await this.#fetch(`${defaultBaseUrl}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "anthropic-version": anthropicVersion,
          "content-type": "application/json",
          "x-api-key": this.#apiKey
        },
        method,
        signal
      });
    } catch (error) {
      throw new Error(`${this.label} request failed: ${sanitizeProviderText(errorMessageFrom(error), [this.#apiKey])}`);
    }

    const text = await response.text();
    const json = parseOptionalJson(text);
    const sanitizedText = sanitizeProviderText(text, [this.#apiKey]).trim();

    return {
      ok: response.ok,
      status: response.status,
      json,
      message: extractErrorMessage(json, [this.#apiKey]) ?? (sanitizedText.length > 0 ? sanitizedText : response.statusText)
    };
  }
}

export const createAnthropicProvider = (
  options: AnthropicProviderOptions
): AnthropicModelProvider => new AnthropicModelProvider(options);

function asAnthropicMessageResponse(value: unknown): AnthropicMessageResponse {
  if (!isRecord(value)) {
    throw new Error("Anthropic response must be a JSON object.");
  }
  return value as AnthropicMessageResponse;
}

function toolInputFrom(response: AnthropicMessageResponse, toolName: string, label: string): JsonObject {
  if (!Array.isArray(response.content)) {
    throw new Error(`${label} response content must be an array.`);
  }

  const toolUse = response.content.find((block) =>
    isRecord(block) && block.type === "tool_use" && block.name === toolName
  );
  if (!isRecord(toolUse)) {
    throw new Error(`${label} returned no ${toolName} tool_use content.`);
  }

  if (!isRecord(toolUse.input)) {
    throw new Error(`${label} ${toolName} tool input must be a JSON object.`);
  }

  return toolUse.input;
}

function tokenUsageFrom(usage: AnthropicMessageResponse["usage"]): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined
  };
}
