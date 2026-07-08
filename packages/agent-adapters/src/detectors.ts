import { createAgentAdapterFailure } from "./failures.js";
import type {
  AgentAdapterCapabilitySet,
  AgentAdapterDetectionResult,
  AgentAdapterKind,
  CommandResult,
  CommandRunner
} from "./types.js";
import { createCapabilitySet } from "./types.js";

export interface ExternalCliDetectorOptions {
  readonly runner: CommandRunner;
  readonly command?: string;
  readonly cwd?: string;
  readonly versionArgs?: readonly string[];
  readonly authArgs?: readonly string[];
}

const CLAUDE_CAPABILITIES = createCapabilitySet([
  "detectInstalled",
  "detectAuthenticated",
  "headlessRun",
  "streamLogs",
  "installSkills",
  "configureMCP",
  "openExternal",
  "cancelRun",
  "readDiff"
]);

const CODEX_CAPABILITIES = createCapabilitySet([
  "detectInstalled",
  "detectAuthenticated",
  "headlessRun",
  "streamLogs",
  "installSkills",
  "configureMCP",
  "openExternal",
  "cancelRun",
  "readDiff"
]);

export function claudeCliCapabilities(): AgentAdapterCapabilitySet {
  return { ...CLAUDE_CAPABILITIES };
}

export function codexCliCapabilities(): AgentAdapterCapabilitySet {
  return { ...CODEX_CAPABILITIES };
}

export async function detectClaudeCli(options: ExternalCliDetectorOptions): Promise<AgentAdapterDetectionResult> {
  return detectExternalCli({
    adapterId: "claude-code",
    adapterLabel: "Claude Code",
    kind: "claude-code",
    command: options.command ?? "claude",
    versionArgs: options.versionArgs ?? ["--version"],
    authArgs: options.authArgs ?? ["auth", "status"],
    cwd: options.cwd,
    runner: options.runner,
    capabilities: claudeCliCapabilities()
  });
}

export async function detectCodexCli(options: ExternalCliDetectorOptions): Promise<AgentAdapterDetectionResult> {
  return detectExternalCli({
    adapterId: "codex-cli",
    adapterLabel: "Codex CLI",
    kind: "codex-cli",
    command: options.command ?? "codex",
    versionArgs: options.versionArgs ?? ["--version"],
    authArgs: options.authArgs ?? ["auth", "status"],
    cwd: options.cwd,
    runner: options.runner,
    capabilities: codexCliCapabilities()
  });
}

interface DetectExternalCliOptions {
  readonly adapterId: string;
  readonly adapterLabel: string;
  readonly kind: AgentAdapterKind;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly authArgs: readonly string[];
  readonly cwd?: string;
  readonly runner: CommandRunner;
  readonly capabilities: AgentAdapterCapabilitySet;
}

async function detectExternalCli(options: DetectExternalCliOptions): Promise<AgentAdapterDetectionResult> {
  const cwd = options.cwd ?? process.cwd();
  const base = {
    id: options.adapterId,
    label: options.adapterLabel,
    kind: options.kind,
    capabilities: options.capabilities,
    command: options.command
  };

  const versionResult = await runDetectorCommand(options.runner, {
    command: options.command,
    args: options.versionArgs,
    cwd
  });

  if (versionResult.kind === "not-found") {
    return {
      ...base,
      status: "not-installed",
      installed: false,
      authenticated: false,
      failure: createAgentAdapterFailure("agent-not-installed", {
        command: options.command,
        detail: versionResult.detail
      })
    };
  }

  if (versionResult.result.exitCode !== 0) {
    return {
      ...base,
      status: "unavailable",
      installed: true,
      authenticated: false,
      raw: pickRaw(versionResult.result),
      failure: createAgentAdapterFailure("command-failed", {
        command: [options.command, ...options.versionArgs].join(" "),
        detail: versionResult.result.stderr || versionResult.result.stdout,
        exitCode: versionResult.result.exitCode
      })
    };
  }

  const authResult = await runDetectorCommand(options.runner, {
    command: options.command,
    args: options.authArgs,
    cwd
  });

  if (authResult.kind === "not-found") {
    return {
      ...base,
      status: "not-installed",
      installed: false,
      authenticated: false,
      failure: createAgentAdapterFailure("agent-not-installed", {
        command: options.command,
        detail: authResult.detail
      })
    };
  }

  const version = firstNonEmptyLine(versionResult.result.stdout) ?? firstNonEmptyLine(versionResult.result.stderr);

  if (authResult.result.exitCode !== 0) {
    return {
      ...base,
      status: "not-authenticated",
      installed: true,
      authenticated: false,
      version,
      raw: pickRaw(authResult.result),
      failure: createAgentAdapterFailure("not-authenticated", {
        command: [options.command, ...options.authArgs].join(" "),
        detail: authResult.result.stderr || authResult.result.stdout
      })
    };
  }

  return {
    ...base,
    status: "ready",
    installed: true,
    authenticated: true,
    version,
    raw: pickRaw(authResult.result)
  };
}

type DetectorCommandOutcome =
  | {
      readonly kind: "result";
      readonly result: CommandResult;
    }
  | {
      readonly kind: "not-found";
      readonly detail: string;
    };

async function runDetectorCommand(
  runner: CommandRunner,
  invocation: Parameters<CommandRunner>[0]
): Promise<DetectorCommandOutcome> {
  try {
    const result = await runner(invocation);
    if (isCommandNotFoundText(result.stderr)) {
      return {
        kind: "not-found",
        detail: result.stderr
      };
    }
    return {
      kind: "result",
      result
    };
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      return {
        kind: "not-found",
        detail: error instanceof Error ? error.message : String(error)
      };
    }

    throw error;
  }
}

function pickRaw(result: CommandResult): { stdout: string; stderr: string } {
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function firstNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function isCommandNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isCommandNotFoundText(stderr: string): boolean {
  return /\bENOENT\b|command not found|not recognized as/.test(stderr);
}
