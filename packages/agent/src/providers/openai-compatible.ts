import { normalizeAgentSourceWrites, parseAgentSourceWrites } from "../source-writes.js";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentExportResult,
  AgentOutline,
  AgentRepairResult,
  AgentReviewResult,
  AgentRunStage,
  JsonObject,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  NormalizedBrief,
  TokenUsage,
  VisualDirectionSet
} from "../types.js";

export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
  id?: string;
  label?: string;
  temperature?: number;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const defaultBaseUrl = "https://api.openai.com/v1";

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #model: string;
  readonly #temperature: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("OpenAI-compatible API key is required.");
    }

    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("OpenAI-compatible model is required.");
    }

    this.id = options.id ?? "openai-compatible";
    this.label = options.label ?? "OpenAI-compatible provider";
    this.#apiKey = apiKey;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl);
    if (options.fetch) {
      this.#fetch = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      this.#fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("A fetch implementation is required for the OpenAI-compatible provider.");
    }
    this.#model = model;
    this.#temperature = options.temperature ?? 0.2;
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
    const schema = schemaForStage(request.stage);
    const response = await this.#fetchJson("POST", "/chat/completions", {
      model: this.#model,
      messages: [
        {
          role: "system",
          content: systemPromptForStage(request.stage)
        },
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
      response_format: {
        type: "json_schema",
        json_schema: {
          name: `htmlslide_${stageSchemaName(request.stage)}`,
          description: `Structured HTMLslide ${request.stage} output.`,
          strict: true,
          schema
        }
      },
      store: false,
      temperature: this.#temperature
    }, request.signal);

    if (!response.ok) {
      throw new Error(`${this.label} completion failed (${response.status}): ${response.message}`);
    }

    const completion = asChatCompletionResponse(response.json);
    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`${this.label} returned no structured message content.`);
    }

    const parsed = parseJsonObject(content, `${this.label} structured ${request.stage} output`);
    const output = coerceStageOutput(request.stage, parsed);

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
      response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json"
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

export const createOpenAICompatibleProvider = (
  options: OpenAICompatibleProviderOptions
): OpenAICompatibleModelProvider => new OpenAICompatibleModelProvider(options);

function coerceStageOutput(stage: AgentRunStage, output: JsonObject): unknown {
  switch (stage) {
    case "brief":
      return {
        title: expectString(output, "title"),
        brief: expectString(output, "brief"),
        language: expectString(output, "language"),
        audience: expectString(output, "audience"),
        durationMinutes: expectNumber(output, "durationMinutes")
      } satisfies NormalizedBrief;
    case "outline":
      return {
        title: expectString(output, "title"),
        language: expectString(output, "language"),
        audience: expectString(output, "audience"),
        durationMinutes: expectNumber(output, "durationMinutes"),
        slides: expectArray(output, "slides").map((slide, index) => {
          const record = expectRecord(slide, `slides[${index}]`);
          return {
            id: expectString(record, "id"),
            title: expectString(record, "title"),
            kind: expectEnum(record, "kind", [
              "title",
              "section",
              "content",
              "data",
              "image",
              "quote",
              "closing",
              "appendix",
              "custom"
            ]),
            goal: expectString(record, "goal")
          };
        })
      } satisfies AgentOutline;
    case "visual-direction":
      return {
        directions: expectArray(output, "directions").map((direction, index) => {
          const record = expectRecord(direction, `directions[${index}]`);
          return {
            id: expectString(record, "id"),
            label: expectString(record, "label"),
            rationale: expectString(record, "rationale"),
            sampleSlideIds: expectStringArray(record, "sampleSlideIds"),
            tokens: expectRecord(record.tokens, `directions[${index}].tokens`)
          };
        }),
        selectedDirectionId: expectOptionalString(output, "selectedDirectionId")
      } satisfies VisualDirectionSet;
    case "build":
      return {
        filesChanged: expectStringArray(output, "filesChanged"),
        slidesChanged: expectStringArray(output, "slidesChanged"),
        notesChanged: expectStringArray(output, "notesChanged"),
        themeChanged: expectStringArray(output, "themeChanged"),
        sourceWrites: normalizeAgentSourceWrites(parseAgentSourceWrites(expectArray(output, "sourceWrites")))
      } satisfies AgentBuildResult;
    case "check":
      {
        const summary = expectRecord(output.summary, "summary");

        return {
          status: expectEnum(output, "status", ["passed", "failed"]),
          summary: {
            errors: expectNumber(summary, "errors"),
            warnings: expectNumber(summary, "warnings"),
            info: expectNumber(summary, "info")
          },
          issues: expectArray(output, "issues").map((issue, index) => {
            const record = expectRecord(issue, `issues[${index}]`);
            return {
              severity: expectEnum(record, "severity", ["error", "warning", "info"]),
              type: expectString(record, "type"),
              message: expectString(record, "message"),
              path: expectOptionalString(record, "path"),
              slideId: expectOptionalString(record, "slideId"),
              suggestedFix: expectOptionalString(record, "suggestedFix")
            };
          })
        } satisfies AgentCheckResult;
      }
    case "repair":
      return {
        attempt: expectNumber(output, "attempt"),
        filesChanged: expectStringArray(output, "filesChanged"),
        issuesAddressed: expectStringArray(output, "issuesAddressed"),
        sourceWrites: normalizeAgentSourceWrites(parseAgentSourceWrites(expectArray(output, "sourceWrites")))
      } satisfies AgentRepairResult;
    case "export":
      return {
        artifacts: expectArray(output, "artifacts").map((artifact, index) => {
          const record = expectRecord(artifact, `artifacts[${index}]`);
          return {
            type: expectEnum(record, "type", ["pdf", "html", "deckpkg", "thumbnails", "speaker-notes"]),
            path: expectString(record, "path")
          };
        })
      } satisfies AgentExportResult;
    case "review":
      return {
        summary: expectString(output, "summary"),
        filesChanged: expectStringArray(output, "filesChanged"),
        issuesRemaining: expectNumber(output, "issuesRemaining"),
        nextActions: expectStringArray(output, "nextActions")
      } satisfies AgentReviewResult;
  }
}

function schemaForStage(stage: AgentRunStage): JsonObject {
  switch (stage) {
    case "brief":
      return objectSchema({
        title: stringSchema(),
        brief: stringSchema(),
        language: stringSchema(),
        audience: stringSchema(),
        durationMinutes: numberSchema()
      });
    case "outline":
      return objectSchema({
        title: stringSchema(),
        language: stringSchema(),
        audience: stringSchema(),
        durationMinutes: numberSchema(),
        slides: arraySchema(objectSchema({
          id: stringSchema(),
          title: stringSchema(),
          kind: stringSchema(),
          goal: stringSchema()
        }))
      });
    case "visual-direction":
      return objectSchema({
        directions: arraySchema(objectSchema({
          id: stringSchema(),
          label: stringSchema(),
          rationale: stringSchema(),
          sampleSlideIds: arraySchema(stringSchema()),
          tokens: objectSchema({
            background: stringSchema(),
            text: stringSchema(),
            accent: stringSchema()
          })
        })),
        selectedDirectionId: nullableStringSchema()
      });
    case "build":
      return objectSchema({
        filesChanged: arraySchema(stringSchema()),
        slidesChanged: arraySchema(stringSchema()),
        notesChanged: arraySchema(stringSchema()),
        themeChanged: arraySchema(stringSchema()),
        sourceWrites: sourceWritesSchema()
      });
    case "check":
      return objectSchema({
        status: enumSchema(["passed", "failed"]),
        summary: objectSchema({
          errors: numberSchema(),
          warnings: numberSchema(),
          info: numberSchema()
        }),
        issues: arraySchema(objectSchema({
          severity: enumSchema(["error", "warning", "info"]),
          type: stringSchema(),
          message: stringSchema(),
          path: nullableStringSchema(),
          slideId: nullableStringSchema(),
          suggestedFix: nullableStringSchema()
        }))
      });
    case "repair":
      return objectSchema({
        attempt: numberSchema(),
        filesChanged: arraySchema(stringSchema()),
        issuesAddressed: arraySchema(stringSchema()),
        sourceWrites: sourceWritesSchema()
      });
    case "export":
      return objectSchema({
        artifacts: arraySchema(objectSchema({
          type: enumSchema(["pdf", "html", "deckpkg", "thumbnails", "speaker-notes"]),
          path: stringSchema()
        }))
      });
    case "review":
      return objectSchema({
        summary: stringSchema(),
        filesChanged: arraySchema(stringSchema()),
        issuesRemaining: numberSchema(),
        nextActions: arraySchema(stringSchema())
      });
  }
}

function sourceWritesSchema(): JsonObject {
  return arraySchema(objectSchema({
    path: stringSchema(),
    content: stringSchema()
  }));
}

function systemPromptForStage(stage: AgentRunStage): string {
  return [
    "You are HTMLslide's BYOK provider adapter.",
    "Return JSON that strictly matches the supplied schema.",
    "Never include API keys, bearer tokens, or secrets.",
    "Deck source writes must target only deck.json, slides/, notes/, theme/, or assets/.",
    stage === "build" || stage === "repair"
      ? "For this stage, include complete sourceWrites entries with project-relative paths and file contents."
      : "For this stage, return structured planning or status data only."
  ].join(" ");
}

function objectSchema(properties: Record<string, JsonObject>): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
}

function arraySchema(items: JsonObject): JsonObject {
  return {
    type: "array",
    items
  };
}

function stringSchema(): JsonObject {
  return { type: "string" };
}

function nullableStringSchema(): JsonObject {
  return { type: ["string", "null"] };
}

function numberSchema(): JsonObject {
  return { type: "number" };
}

function enumSchema(values: string[]): JsonObject {
  return { type: "string", enum: values };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("OpenAI-compatible base URL is required.");
  }
  return trimmed.replace(/\/+$/u, "");
}

function stageSchemaName(stage: AgentRunStage): string {
  return `${stage.replace(/[^A-Za-z0-9_-]/gu, "_")}_output`;
}

function asChatCompletionResponse(value: unknown): ChatCompletionResponse {
  if (!isRecord(value)) {
    throw new Error("OpenAI-compatible response must be a JSON object.");
  }
  return value as ChatCompletionResponse;
}

function parseJsonObject(value: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseOptionalJson(value: string): unknown {
  if (value.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractErrorMessage(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const error = value.error;
  if (isRecord(error) && typeof error.message === "string") {
    return sanitizeProviderText(error.message, secrets);
  }

  if (typeof value.message === "string") {
    return sanitizeProviderText(value.message, secrets);
  }

  return undefined;
}

function sanitizeProviderText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, "sk-[redacted]");

  for (const secret of secrets) {
    const trimmedSecret = secret.trim();
    if (trimmedSecret.length < 6) {
      continue;
    }
    sanitized = sanitized.replace(new RegExp(escapeRegExp(trimmedSecret), "gu"), "[redacted]");
  }

  return sanitized;
}

function errorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function tokenUsageFrom(usage: ChatCompletionResponse["usage"]): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function expectString(record: JsonObject, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return value;
}

function expectOptionalString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string when present.`);
  }
  return value;
}

function expectNumber(record: JsonObject, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected ${key} to be a number.`);
  }
  return value;
}

function expectEnum<const TValue extends string>(
  record: JsonObject,
  key: string,
  values: readonly TValue[]
): TValue {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as TValue)) {
    throw new Error(`Expected ${key} to be one of: ${values.join(", ")}.`);
  }
  return value as TValue;
}

function expectArray(record: JsonObject, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an array.`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value;
}

function expectStringArray(record: JsonObject, key: string): string[] {
  const value = expectArray(record, key);
  if (!value.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${key} to be an array of strings.`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
