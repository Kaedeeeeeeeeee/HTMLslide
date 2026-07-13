import type { AgentRunErrorInfo, AgentRunStage } from "./types.js";
import { sanitizeProviderText } from "./providers/provider-utils.js";

export class AgentRunCancelledError extends Error {
  readonly stage?: AgentRunStage;

  constructor(message = "Agent run was cancelled.", stage?: AgentRunStage) {
    super(message);
    this.name = "AgentRunCancelledError";
    this.stage = stage;
  }
}

export class AgentRunFailureError extends Error {
  readonly info: AgentRunErrorInfo;

  constructor(info: AgentRunErrorInfo) {
    super(info.message);
    this.name = "AgentRunFailureError";
    this.info = info;
  }
}

export class AgentRunTimeoutError extends Error {
  readonly stage?: AgentRunStage;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, stage?: AgentRunStage) {
    super(`Agent run timed out after ${timeoutMs}ms.`);
    this.name = "AgentRunTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export const isCancellationError = (error: unknown): boolean =>
  error instanceof AgentRunCancelledError ||
  (error instanceof Error && (error.name === "AbortError" || error.name === "AgentRunCancelledError"));

export const errorMessage = (error: unknown): string =>
  sanitizeProviderText(error instanceof Error ? error.message : String(error)).slice(0, 512);
