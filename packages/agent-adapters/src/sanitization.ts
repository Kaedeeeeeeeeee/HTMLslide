import type { CommandOutputChunk, RenderedCommand } from "./types.js";

const SENSITIVE_NAME_PATTERN = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|password|private[_-]?key|secret|token)/iu;
const SENSITIVE_OPTION_PATTERN = /^--?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|private[-_]?key|secret|token)$/iu;
const BEARER_PATTERN = /(Bearer\s+)[^\s"'`,;]+/giu;
const ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|private[_-]?key|secret|token)\s*[:=]\s*)(["']?)(?!Bearer\b)([^\s"'`,;]+)/giu;
const FLAG_ASSIGNMENT_PATTERN = /((?:--?)(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|private[-_]?key|secret|token)\s+)([^\s"'`,;]+)/giu;
const COMMON_TOKEN_PATTERN = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})\b/gu;

export function collectSensitiveValues(
  ...records: Array<Readonly<Record<string, string | undefined>> | undefined>
): string[] {
  const values = new Set<string>();

  for (const record of records) {
    if (record === undefined) {
      continue;
    }

    for (const [name, value] of Object.entries(record)) {
      const trimmed = value?.trim();
      if (SENSITIVE_NAME_PATTERN.test(name) && trimmed !== undefined && trimmed.length >= 4) {
        values.add(trimmed);
      }
    }
  }

  return [...values].sort((left, right) => right.length - left.length);
}

/** Values explicitly handed to a child process are secrets unless proven otherwise. */
export function collectProvidedValues(
  record: Readonly<Record<string, string | undefined>> | undefined
): string[] {
  if (record === undefined) {
    return [];
  }

  return Object.values(record)
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

export function sanitizeAgentAdapterText(
  value: string | undefined,
  sensitiveValues: readonly string[] = []
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let sanitized = value;
  for (const secret of sensitiveValues) {
    sanitized = sanitized.split(secret).join("[redacted]");
  }

  return sanitized
    .replace(COMMON_TOKEN_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(ASSIGNMENT_PATTERN, "$1$2[redacted]$2")
    .replace(FLAG_ASSIGNMENT_PATTERN, "$1[redacted]");
}

export function sanitizeRenderedCommand(
  command: RenderedCommand | undefined,
  sensitiveValues: readonly string[] = []
): RenderedCommand | undefined {
  if (command === undefined) {
    return undefined;
  }

  return {
    command: sanitizeAgentAdapterText(command.command, sensitiveValues) ?? "",
    args: command.args.map((argument, index) => {
      const previous = command.args[index - 1];
      if (previous !== undefined && SENSITIVE_OPTION_PATTERN.test(previous)) {
        return "[redacted]";
      }
      return sanitizeAgentAdapterText(argument, sensitiveValues) ?? "";
    })
  };
}

export function sanitizeCommandOutputChunk(
  chunk: CommandOutputChunk,
  sensitiveValues: readonly string[] = []
): CommandOutputChunk {
  return {
    stream: chunk.stream,
    text: sanitizeAgentAdapterText(chunk.text, sensitiveValues) ?? ""
  };
}

export function createCommandOutputRedactor(sensitiveValues: readonly string[] = []): {
  push(chunk: CommandOutputChunk): CommandOutputChunk;
  flush(): CommandOutputChunk[];
} {
  const maxSecretLength = sensitiveValues.reduce(
    (maximum, secret) => Math.max(maximum, secret.length),
    0
  );
  const pendingByStream = new Map<CommandOutputChunk["stream"], string>();

  return {
    push(chunk): CommandOutputChunk {
      if (maxSecretLength === 0) {
        return sanitizeCommandOutputChunk(chunk, sensitiveValues);
      }

      const pending = pendingByStream.get(chunk.stream) ?? "";
      const combined = `${pending}${chunk.text}`;
      const safeCutoff = safeOutputCutoff(combined, sensitiveValues);
      const safeText = sanitizeAgentAdapterText(combined.slice(0, safeCutoff), sensitiveValues) ?? "";
      pendingByStream.set(chunk.stream, combined.slice(safeCutoff));

      return {
        stream: chunk.stream,
        text: safeText
      };
    },
    flush(): CommandOutputChunk[] {
      const flushed: CommandOutputChunk[] = [];
      for (const [stream, pending] of pendingByStream) {
        if (pending.length > 0) {
          flushed.push({
            stream,
            text: sanitizeAgentAdapterText(pending, sensitiveValues) ?? ""
          });
        }
      }
      pendingByStream.clear();
      return flushed;
    }
  };
}

function safeOutputCutoff(value: string, sensitiveValues: readonly string[]): number {
  let safeCutoff = value.length;

  for (const secret of sensitiveValues) {
    const maximumPartialLength = Math.min(secret.length - 1, safeCutoff);
    for (let partialLength = maximumPartialLength; partialLength > 0; partialLength -= 1) {
      if (value.endsWith(secret.slice(0, partialLength))) {
        safeCutoff = Math.min(safeCutoff, value.length - partialLength);
        break;
      }
    }
  }

  return safeCutoff;
}
