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

export const CLAUDE_HEADLESS_CONTRACT_ARGS = ["--help"] as const;
export const CLAUDE_HEADLESS_CONTRACT_FLAGS = [
  "--setting-sources",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence"
] as const;
export const CODEX_HEADLESS_CONTRACT_ARGS = ["exec", "--help"] as const;
export const CODEX_HEADLESS_CONTRACT_FLAGS = [
  "--sandbox",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--json"
] as const;

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

const GEMINI_CAPABILITIES = createCapabilitySet([
  "detectInstalled",
  "openExternal"
]);

export function claudeCliCapabilities(): AgentAdapterCapabilitySet {
  return { ...CLAUDE_CAPABILITIES };
}

export function codexCliCapabilities(): AgentAdapterCapabilitySet {
  return { ...CODEX_CAPABILITIES };
}

export function geminiCliCapabilities(): AgentAdapterCapabilitySet {
  return { ...GEMINI_CAPABILITIES };
}

export async function detectClaudeCli(options: ExternalCliDetectorOptions): Promise<AgentAdapterDetectionResult> {
  return detectExternalCli({
    adapterId: "claude-code",
    adapterLabel: "Claude Code",
    kind: "claude-code",
    command: options.command ?? "claude",
    versionArgs: options.versionArgs ?? ["--version"],
    authArgs: options.authArgs ?? ["auth", "status"],
    contractArgs: CLAUDE_HEADLESS_CONTRACT_ARGS,
    contractFlags: CLAUDE_HEADLESS_CONTRACT_FLAGS,
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
    authArgs: options.authArgs ?? ["login", "status"],
    contractArgs: CODEX_HEADLESS_CONTRACT_ARGS,
    contractFlags: CODEX_HEADLESS_CONTRACT_FLAGS,
    cwd: options.cwd,
    runner: options.runner,
    capabilities: codexCliCapabilities()
  });
}

export async function detectGeminiCli(options: ExternalCliDetectorOptions): Promise<AgentAdapterDetectionResult> {
  return detectExternalCli({
    adapterId: "gemini-cli",
    adapterLabel: "Gemini CLI",
    kind: "gemini-cli",
    command: options.command ?? "gemini",
    versionArgs: options.versionArgs ?? ["--version"],
    authArgs: options.authArgs,
    cwd: options.cwd,
    runner: options.runner,
    capabilities: geminiCliCapabilities()
  });
}

interface DetectExternalCliOptions {
  readonly adapterId: string;
  readonly adapterLabel: string;
  readonly kind: AgentAdapterKind;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly authArgs?: readonly string[];
  readonly contractArgs?: readonly string[];
  readonly contractFlags?: readonly string[];
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

  const version = firstNonEmptyLine(versionResult.result.stdout) ?? firstNonEmptyLine(versionResult.result.stderr);

  if (!options.authArgs) {
    return {
      ...base,
      status: "unavailable",
      installed: true,
      authenticated: false,
      version,
      raw: pickRaw(versionResult.result)
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

  if (options.contractArgs && options.contractFlags) {
    const contractResult = await runDetectorCommand(options.runner, {
      command: options.command,
      args: options.contractArgs,
      cwd
    });
    const output = contractResult.kind === "result"
      ? `${contractResult.result.stdout}\n${contractResult.result.stderr}`
      : "";
    const missingFlags = options.contractFlags.filter((flag) => !output.includes(flag));
    if (
      contractResult.kind !== "result" ||
      contractResult.result.exitCode !== 0 ||
      missingFlags.length > 0
    ) {
      return {
        ...base,
        capabilities: {
          ...base.capabilities,
          headlessRun: false,
          readDiff: false,
          streamLogs: false
        },
        status: "unavailable",
        installed: true,
        authenticated: true,
        version,
        ...(contractResult.kind === "result" ? { raw: pickRaw(contractResult.result) } : {}),
        failure: createAgentAdapterFailure("command-failed", {
          command: [options.command, ...options.contractArgs].join(" "),
          detail: missingFlags.length > 0
            ? `Installed CLI is missing required headless flags: ${missingFlags.join(", ")}`
            : "Installed CLI headless contract could not be verified.",
          ...(contractResult.kind === "result" ? { exitCode: contractResult.result.exitCode } : {})
        })
      };
    }
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
