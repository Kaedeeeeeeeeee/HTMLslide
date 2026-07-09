import type { AgentAdapterFailure } from "./failures.js";

export const AGENT_ADAPTER_CAPABILITIES = [
  "detectInstalled",
  "detectAuthenticated",
  "headlessRun",
  "streamLogs",
  "installSkills",
  "configureMCP",
  "openExternal",
  "cancelRun",
  "readDiff"
] as const;

export type AgentAdapterCapability = (typeof AGENT_ADAPTER_CAPABILITIES)[number];
export type AgentAdapterCapabilitySet = Partial<Record<AgentAdapterCapability, boolean>>;

export type AgentAdapterKind = "claude-code" | "codex-cli" | "gemini-cli" | "generic" | "fake";
export type AgentAdapterDetectionStatus = "ready" | "not-installed" | "not-authenticated" | "unavailable";
export type AgentAdapterRunStatus = "completed" | "failed" | "cancelled";

export interface AgentAdapterDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: AgentAdapterKind;
  readonly capabilities: AgentAdapterCapabilitySet;
}

export interface AgentAdapterDetectionResult extends AgentAdapterDescriptor {
  readonly status: AgentAdapterDetectionStatus;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly command: string;
  readonly version?: string;
  readonly failure?: AgentAdapterFailure;
  readonly raw?: {
    readonly stdout: string;
    readonly stderr: string;
  };
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: CommandOutputChunk) => void;
}

export interface CommandOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly signal?: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export interface RenderedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface GenericAgentAdapterConfig extends AgentAdapterDescriptor {
  readonly kind: "generic" | "fake";
  readonly commandTemplate: string;
  readonly pathVariables?: readonly string[];
  readonly timeoutMs?: number;
}

export interface GenericAgentRunOptions {
  readonly adapter: GenericAgentAdapterConfig;
  readonly projectRoot: string;
  readonly promptFile: string;
  readonly variables?: Readonly<Record<string, string | undefined>>;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onOutput?: (chunk: CommandOutputChunk) => void;
  readonly readReportedFileWrites?: () => Promise<readonly string[]>;
}

export interface AgentAdapterRunSuccess {
  readonly ok: true;
  readonly status: "completed";
  readonly adapter: AgentAdapterDescriptor;
  readonly command: RenderedCommand;
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly reportedWrites: readonly string[];
}

export interface AgentAdapterRunFailure {
  readonly ok: false;
  readonly status: "failed" | "cancelled";
  readonly adapter: AgentAdapterDescriptor;
  readonly command?: RenderedCommand;
  readonly cwd: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reportedWrites?: readonly string[];
  readonly failure: AgentAdapterFailure;
}

export type AgentAdapterRunResult = AgentAdapterRunSuccess | AgentAdapterRunFailure;

export function createCapabilitySet(
  supportedCapabilities: readonly AgentAdapterCapability[]
): AgentAdapterCapabilitySet {
  const capabilities: AgentAdapterCapabilitySet = {};

  for (const capability of AGENT_ADAPTER_CAPABILITIES) {
    capabilities[capability] = supportedCapabilities.includes(capability);
  }

  return capabilities;
}
