export const AGENT_ADAPTER_FAILURE_TYPES = [
  "agent-not-installed",
  "not-authenticated",
  "subscription-unavailable",
  "command-failed",
  "user-denied-permission",
  "forbidden-file-write",
  "check-still-failing",
  "run-timeout",
  "cancelled",
  "project-boundary-violation",
  "template-render-error"
] as const;

export type AgentAdapterFailureType = (typeof AGENT_ADAPTER_FAILURE_TYPES)[number];

export interface AgentAdapterFailure {
  readonly type: AgentAdapterFailureType;
  readonly message: string;
  readonly remediation: string;
  readonly detail?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly path?: string;
}

export interface AgentAdapterFailureDefaults {
  readonly message: string;
  readonly remediation: string;
}

export const AGENT_ADAPTER_FAILURE_GUIDANCE = {
  "agent-not-installed": {
    message: "The external agent command is not installed or is not on PATH.",
    remediation: "Install the agent CLI, reopen HTMLslide, then run detection again."
  },
  "not-authenticated": {
    message: "The external agent CLI is installed but is not authenticated.",
    remediation: "Log in with the agent CLI, then reconnect it from HTMLslide."
  },
  "subscription-unavailable": {
    message: "The agent account or API subscription is unavailable.",
    remediation: "Switch AI engine, use API key mode, or resolve account access with the provider."
  },
  "command-failed": {
    message: "The external agent command exited with a failure.",
    remediation: "Open Developer Console, inspect the command logs, then copy a repair prompt if needed."
  },
  "user-denied-permission": {
    message: "The external agent stopped because the user denied a requested permission.",
    remediation: "Review the permission request, then rerun with the required project-scoped access."
  },
  "forbidden-file-write": {
    message: "The external agent reported a write outside the HTMLslide project.",
    remediation: "Revert the checkpoint, inspect the reported path, and rerun with project-scoped instructions."
  },
  "check-still-failing": {
    message: "The agent run completed, but htmlslide check still reports errors.",
    remediation: "Copy the check report into a repair prompt or switch AI engine for a repair pass."
  },
  "run-timeout": {
    message: "The external agent run exceeded the configured timeout.",
    remediation: "Increase the timeout, simplify the request, or cancel and retry with a smaller task."
  },
  cancelled: {
    message: "The external agent run was cancelled.",
    remediation: "Start a new run when you are ready to continue."
  },
  "project-boundary-violation": {
    message: "The agent command references a path outside the HTMLslide project.",
    remediation: "Choose a project-local prompt, manifest, or output path and rerun the command."
  },
  "template-render-error": {
    message: "The agent command template could not be rendered.",
    remediation: "Fix the command template placeholders and retry the connection test."
  }
} as const satisfies Record<AgentAdapterFailureType, AgentAdapterFailureDefaults>;

export function createAgentAdapterFailure(
  type: AgentAdapterFailureType,
  overrides: Partial<Omit<AgentAdapterFailure, "type">> = {}
): AgentAdapterFailure {
  const defaults = AGENT_ADAPTER_FAILURE_GUIDANCE[type];

  return {
    type,
    message: overrides.message ?? defaults.message,
    remediation: overrides.remediation ?? defaults.remediation,
    detail: overrides.detail,
    command: overrides.command,
    exitCode: overrides.exitCode,
    path: overrides.path
  };
}

export class AgentAdapterFailureError extends Error {
  readonly failure: AgentAdapterFailure;

  constructor(failure: AgentAdapterFailure) {
    super(failure.message);
    this.name = "AgentAdapterFailureError";
    this.failure = failure;
  }
}

export function toAgentAdapterFailure(error: unknown): AgentAdapterFailure {
  if (error instanceof AgentAdapterFailureError) {
    return error.failure;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return createAgentAdapterFailure("command-failed", { detail });
}
