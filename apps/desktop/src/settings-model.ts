import type {
  AgentAdapterCapabilitySet,
  AgentAdapterDetectionResult,
  AgentAdapterKind
} from "@htmlslide/agent-adapters";

export type AiEngineMode = "no-ai" | "htmlslide-agent" | "external-agent";
export type ApiKeyProvider = "openai" | "anthropic" | "compatible";
export type ExternalAgentId = "claude-code" | "codex-cli" | "generic";

export interface ApiKeyMetadata {
  provider: ApiKeyProvider;
  model: string;
  hasKey: boolean;
  updatedAt?: string;
}

export interface ExternalAgentSelection {
  selectedId: ExternalAgentId;
  customCommand: string;
  updatedAt?: string;
}

export type ExternalAgentStatus = Pick<
  AgentAdapterDetectionResult,
  "authenticated" | "capabilities" | "command" | "installed" | "label" | "status" | "version"
> & {
  id: ExternalAgentId;
  kind: Extract<AgentAdapterKind, "claude-code" | "codex-cli" | "generic">;
  checkedAt?: string;
  summary: string;
};

export interface AiEngineSettings {
  version: 1;
  mode: AiEngineMode;
  apiKey: ApiKeyMetadata;
  externalAgent: ExternalAgentSelection;
  updatedAt?: string;
}

export interface AiEngineSettingsDraft {
  mode: AiEngineMode;
  provider: ApiKeyProvider;
  model: string;
  apiKeyInput?: string;
  clearKey?: boolean;
  externalAgentId: ExternalAgentId;
  customCommand?: string;
}

export const aiEngineModes: Array<{ id: AiEngineMode; label: string; description: string }> = [
  {
    id: "no-ai",
    label: "No AI",
    description: "Preview, check, export, and present local decks."
  },
  {
    id: "htmlslide-agent",
    label: "HTMLslide Agent",
    description: "Use provider metadata for the built-in agent."
  },
  {
    id: "external-agent",
    label: "Coding Agent",
    description: "Connect Claude Code, Codex CLI, or a compatible command."
  }
];

export const apiKeyProviders: Array<{ id: ApiKeyProvider; label: string; defaultModel: string }> = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5-mini" },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4.5" },
  { id: "compatible", label: "OpenAI-compatible", defaultModel: "openai-compatible/default" }
];

export const externalAgentOptions: Array<{ id: ExternalAgentId; label: string; command: string }> = [
  { id: "claude-code", label: "Claude Code", command: "claude" },
  { id: "codex-cli", label: "Codex CLI", command: "codex" },
  { id: "generic", label: "Generic command", command: "" }
];

const defaultCapabilities: AgentAdapterCapabilitySet = {
  cancelRun: false,
  configureMCP: false,
  detectAuthenticated: true,
  detectInstalled: true,
  headlessRun: false,
  installSkills: false,
  openExternal: true,
  readDiff: false,
  streamLogs: false
};

export function createDefaultAiEngineSettings(): AiEngineSettings {
  return {
    apiKey: {
      hasKey: false,
      model: "gpt-5-mini",
      provider: "openai"
    },
    externalAgent: {
      customCommand: "",
      selectedId: "codex-cli"
    },
    mode: "no-ai",
    version: 1
  };
}

export function createDefaultExternalAgentStatuses(): ExternalAgentStatus[] {
  return [
    {
      authenticated: false,
      capabilities: { ...defaultCapabilities },
      command: "claude",
      id: "claude-code",
      installed: false,
      kind: "claude-code",
      label: "Claude Code",
      status: "not-installed",
      summary: "Not checked yet",
      version: undefined
    },
    {
      authenticated: false,
      capabilities: { ...defaultCapabilities },
      command: "codex",
      id: "codex-cli",
      installed: false,
      kind: "codex-cli",
      label: "Codex CLI",
      status: "not-installed",
      summary: "Not checked yet",
      version: undefined
    },
    {
      authenticated: false,
      capabilities: { ...defaultCapabilities, detectAuthenticated: false },
      command: "",
      id: "generic",
      installed: false,
      kind: "generic",
      label: "Generic command",
      status: "unavailable",
      summary: "Add a command template to use a compatible agent",
      version: undefined
    }
  ];
}

export function buildAiEngineSettingsUpdate(
  current: AiEngineSettings,
  draft: AiEngineSettingsDraft,
  now = new Date().toISOString()
): AiEngineSettings {
  const provider = normalizeProvider(draft.provider);
  const previousProvider = current.apiKey.provider;
  const enteredKey = (draft.apiKeyInput ?? "").trim().length > 0;
  const providerChanged = provider !== previousProvider;
  const hasKey = draft.clearKey
    ? false
    : enteredKey
      ? true
      : providerChanged
        ? false
        : current.apiKey.hasKey;
  const model = normalizeModel(draft.model, provider);
  const externalAgentId = normalizeExternalAgentId(draft.externalAgentId);

  return {
    apiKey: {
      hasKey,
      model,
      provider,
      updatedAt: now
    },
    externalAgent: {
      customCommand: normalizeCustomCommand(draft.customCommand),
      selectedId: externalAgentId,
      updatedAt: now
    },
    mode: normalizeMode(draft.mode),
    updatedAt: now,
    version: 1
  };
}

export function normalizeAiEngineSettings(value: unknown): AiEngineSettings {
  if (!isRecord(value)) {
    return createDefaultAiEngineSettings();
  }

  const fallback = createDefaultAiEngineSettings();
  const apiKey = isRecord(value.apiKey) ? value.apiKey : {};
  const externalAgent = isRecord(value.externalAgent) ? value.externalAgent : {};
  const provider = normalizeProvider(apiKey.provider);

  return {
    apiKey: {
      hasKey: apiKey.hasKey === true,
      model: normalizeModel(apiKey.model, provider),
      provider,
      updatedAt: typeof apiKey.updatedAt === "string" ? apiKey.updatedAt : undefined
    },
    externalAgent: {
      customCommand: normalizeCustomCommand(externalAgent.customCommand),
      selectedId: normalizeExternalAgentId(externalAgent.selectedId),
      updatedAt: typeof externalAgent.updatedAt === "string" ? externalAgent.updatedAt : undefined
    },
    mode: normalizeMode(value.mode ?? fallback.mode),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    version: 1
  };
}

export function formatRedactedKeyStatus(settings: AiEngineSettings): string {
  if (!settings.apiKey.hasKey) {
    return "No provider key saved";
  }

  const provider = apiKeyProviders.find((item) => item.id === settings.apiKey.provider)?.label ?? "Provider";
  return `${provider} key saved`;
}

export function selectedExternalAgentStatus(
  settings: AiEngineSettings,
  statuses: readonly ExternalAgentStatus[]
): ExternalAgentStatus {
  const defaultStatuses = createDefaultExternalAgentStatuses();
  if (
    settings.externalAgent.selectedId === "generic" &&
    settings.externalAgent.customCommand.trim().length > 0
  ) {
    const genericDefault = defaultStatuses.find((status) => status.id === "generic") ?? defaultStatuses[2]!;
    return {
      ...genericDefault,
      authenticated: true,
      capabilities: {
        ...genericDefault.capabilities,
        headlessRun: true,
        readDiff: true,
        streamLogs: true
      },
      command: settings.externalAgent.customCommand,
      installed: true,
      status: "ready",
      summary: "Generic command template saved"
    };
  }

  return (
    statuses.find((status) => status.id === settings.externalAgent.selectedId) ??
    defaultStatuses.find((status) => status.id === settings.externalAgent.selectedId) ??
    defaultStatuses.find((status) => status.id === "codex-cli") ??
    defaultStatuses[0]!
  );
}

function normalizeMode(value: unknown): AiEngineMode {
  return value === "htmlslide-agent" || value === "external-agent" || value === "no-ai" ? value : "no-ai";
}

function normalizeProvider(value: unknown): ApiKeyProvider {
  return value === "anthropic" || value === "compatible" || value === "openai" ? value : "openai";
}

function normalizeExternalAgentId(value: unknown): ExternalAgentId {
  return value === "claude-code" || value === "generic" || value === "codex-cli" ? value : "codex-cli";
}

function normalizeModel(value: unknown, provider: ApiKeyProvider): string {
  const fallback = apiKeyProviders.find((item) => item.id === provider)?.defaultModel ?? "gpt-5-mini";
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeCustomCommand(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
