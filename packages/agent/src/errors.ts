import type { AgentRunErrorInfo, AgentRunStage } from "./types.js";

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

export const isCancellationError = (error: unknown): boolean =>
  error instanceof AgentRunCancelledError ||
  (error instanceof Error && (error.name === "AbortError" || error.name === "AgentRunCancelledError"));

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
