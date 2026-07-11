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
  NormalizedBrief,
  VisualDirectionSet
} from "../types.js";

export function coerceStageOutput(stage: AgentRunStage, output: JsonObject): unknown {
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
        slides: expectNonEmptyArray(output, "slides").map((slide, index) => {
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
        directions: expectNonEmptyArray(output, "directions").map((direction, index) => {
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

export function schemaForStage(stage: AgentRunStage): JsonObject {
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
        }), true)
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
        }), true),
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

export function systemPromptForStage(stage: AgentRunStage): string {
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

export function stageSchemaName(stage: AgentRunStage): string {
  return `${stage.replace(/[^A-Za-z0-9_-]/gu, "_")}_output`;
}

export function parseJsonObject(value: string, label: string): JsonObject {
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

export function parseOptionalJson(value: string): unknown {
  if (value.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function extractErrorMessage(value: unknown, secrets: readonly string[] = []): string | undefined {
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

export function sanitizeProviderText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, "sk-[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "github_pat_[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "gh_[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/gu, "glpat-[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "xox-[redacted]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/gu, "npm_[redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "AWS_[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "AIza[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret)=([^\s"'&]+)/giu, "$1=[redacted]");

  for (const secret of secrets) {
    const trimmedSecret = secret.trim();
    if (trimmedSecret.length < 6) {
      continue;
    }
    sanitized = sanitized.replace(new RegExp(escapeRegExp(trimmedSecret), "gu"), "[redacted]");
  }

  return sanitized;
}

export function errorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceWritesSchema(): JsonObject {
  return arraySchema(objectSchema({
    path: stringSchema(),
    content: stringSchema()
  }));
}

function objectSchema(properties: Record<string, JsonObject>): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
}

function arraySchema(items: JsonObject, nonEmpty = false): JsonObject {
  return {
    type: "array",
    items,
    ...(nonEmpty ? { minItems: 1 } : {})
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

function expectNonEmptyArray(record: JsonObject, key: string): unknown[] {
  const value = expectArray(record, key);
  if (value.length === 0) {
    throw new Error(`Expected ${key} to contain at least one item.`);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
