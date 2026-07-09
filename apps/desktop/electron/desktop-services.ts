import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCapabilitySet,
  readJsonFileWriteManifest,
  runGenericAgentAdapter,
  type AgentAdapterRunResult,
  type CommandRunner,
  type GenericAgentAdapterConfig
} from "@htmlslide/agent-adapters";
import {
  applyAgentSourceWrites,
  applyMockAgentProject,
  createAnthropicProvider,
  createFileCopyCheckpoint,
  createOpenAICompatibleProvider,
  createMockProvider,
  defaultAgentStages,
  diffFileCopyCheckpoint,
  normalizeAgentSourceWrites,
  recordCheckpointChanges,
  revertFileCopyCheckpoint,
  runAgent,
  sanitizeProviderText,
  type AgentSourceWrite,
  type AgentRunEvent,
  type AgentRunLog,
  type AgentRunResult,
  type AgentRunStage,
  type AgentRunStatus,
  type ApplyMockAgentProjectResult,
  type FileCopyCheckpointDiff,
  type FileCopyCheckpointRevertResult,
  type FetchLike,
  type ModelProvider
} from "@htmlslide/agent";
import {
  DeckPackageValidationError,
  readDeckPackage,
  type PresenterDeckPackage
} from "@htmlslide/presenter";
import type { PresenterDeck } from "@htmlslide/presenter/session";
import {
  OFFICIAL_SKILLS,
  validateOfficialSkillRegistry
} from "@htmlslide/skills";

export type DesktopProjectStatus =
  | "Ready"
  | "Needs check"
  | "Export failed"
  | "Missing files"
  | "External changes detected";

export type DesktopProjectRecord = {
  id: string;
  title: string;
  path: string;
  lastOpenedAt: string;
  status: DesktopProjectStatus;
  slideCount: number;
  thumbnail?: string;
};

export type DesktopProjectReference = {
  id?: string;
  path?: string;
};

export type DesktopLibrary = {
  version: 1;
  defaultWorkspace: string;
  recentProjects: DesktopProjectRecord[];
};

export type DesktopSlidePreview = {
  id: string;
  number: string;
  title: string;
  section: string;
  status: "ready" | "needs-check" | "blocked";
  duration: string;
  accent: string;
  speakerNotes: string;
  bullets: string[];
  sourcePath: string;
  notesPath?: string;
  html: string;
};

export type DesktopProjectPreview = {
  project: DesktopProjectRecord;
  slides: DesktopSlidePreview[];
};

export type DesktopCreateProjectRequest = {
  title: string;
  folderName: string;
  workspacePath?: string;
};

export type DesktopResolvedCreateProjectRequest = {
  title: string;
  folderName: string;
  workspacePath: string;
  projectPath: string;
};

export type CliRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
};

export type CliRuntime = {
  mode: "development" | "packaged";
  cliPath: string;
  cwd: string;
  rootPath?: string;
};

export type CliRunnerOptions = {
  rootPath?: string;
  cliPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type DesktopCliRunner = (args: string[], options: CliRunnerOptions) => Promise<CliRunResult>;

export type DesktopCliIntegrationTarget = {
  targetDir: string;
  targetPath: string;
  htmlslideHomeDir: string;
  source: "env" | "homebrew" | "usr-local" | "user-home";
};

export type DesktopCliIntegrationState = {
  available: boolean;
  mode: CliRuntime["mode"] | "missing";
  status: "passed" | "info" | "warning" | "failed";
  installed: boolean;
  managed: boolean;
  onPath: boolean;
  targetPath: string;
  targetDir: string;
  htmlslideHomeDir: string;
  cliPath?: string;
  appPath?: string;
  action?: "installed" | "updated" | "removed" | "unchanged";
  message: string;
  suggestedFix?: string;
  manualInstallCommand: string;
  manualUninstallCommand: string;
  updatedAt: string;
};

export type DesktopCliIntegrationOptions = {
  appPath?: string;
  appVersion?: string;
  bundleId?: string;
  cliRuntime?: CliRuntime;
  cliRunner?: DesktopCliRunner;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  now?: string;
};

export type DesktopOfficialSkillsState = {
  available: boolean;
  status: "passed" | "info" | "warning" | "failed";
  installed: boolean;
  managed: true;
  action?: "installed" | "updated" | "unchanged";
  htmlslideHomeDir: string;
  skillsDir: string;
  skillCount: number;
  installedCount: number;
  missing: string[];
  stale: string[];
  names: string[];
  message: string;
  suggestedFix?: string;
  updatedAt: string;
};

export type DesktopOfficialSkillsOptions = {
  env?: NodeJS.ProcessEnv;
  now?: string;
};

export type DesktopMockAgentRunRequest = {
  projectPath: string;
  brief: string;
  runExport?: boolean;
  maxRepairRounds?: number;
  runId?: string;
};

export type DesktopMockAgentStageSummary = {
  stage: AgentRunStage;
  status: AgentRunStatus;
  summary: string;
  updatedAt?: string;
};

export type DesktopMockAgentRunSummary = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  stageCount: number;
  completedStages: number;
  failedStages: number;
  checkStatus?: string;
  checkErrors?: number;
  checkWarnings?: number;
  exportStatus?: string;
  exportArtifacts: string[];
};

export type DesktopAgentRunReportCliResult = {
  ok: boolean;
  exitCode: number;
  status?: string;
  summary?: unknown;
  artifactPaths: string[];
};

export type DesktopAgentRunReport = {
  schemaVersion: "0.1.0";
  kind: "htmlslide-agent-run-report";
  runId: string;
  providerId: "htmlslide-mock" | "htmlslide-byok";
  projectPath: string;
  generatedAt: string;
  ok: boolean;
  status: AgentRunResult["status"];
  stages: DesktopMockAgentStageSummary[];
  outputs: {
    brief?: AgentRunResult["outputs"]["brief"];
    outline?: AgentRunResult["outputs"]["outline"];
    visualDirection?: AgentRunResult["outputs"]["visualDirection"];
    selectedVisualDirectionId?: string;
    build?: {
      filesChanged: string[];
      slidesChanged: string[];
      notesChanged: string[];
      themeChanged: string[];
      sourceWriteCount: number;
      sourceWritePaths: string[];
    };
    checks: AgentRunResult["outputs"]["checks"];
    repairs: Array<{
      attempt: number;
      filesChanged: string[];
      issuesAddressed: string[];
      sourceWriteCount: number;
      sourceWritePaths: string[];
    }>;
    export?: AgentRunResult["outputs"]["export"];
    review?: AgentRunResult["outputs"]["review"];
  };
  applied?: {
    source: "mock-project-writer" | "provider-source-writes";
    filesChanged: string[];
    slideIds?: string[];
    selectedVisualDirectionId?: string;
    writeCount?: number;
    stages?: DesktopByokAgentAppliedResult["stages"];
  };
  checkpoint?: {
    id: string;
    strategy: string;
    manifestPath?: string;
    canRevert: boolean;
  };
  checkpointDiff?: {
    summary: FileCopyCheckpointDiff["summary"];
    changedPaths: string[];
    addedPaths: string[];
    deletedPaths: string[];
  };
  cli: {
    check?: DesktopAgentRunReportCliResult;
    export?: DesktopAgentRunReportCliResult;
  };
};

export type DesktopMockAgentRunResult = {
  ok: boolean;
  providerId: "htmlslide-mock";
  projectPath: string;
  stages: DesktopMockAgentStageSummary[];
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: CliRunResult;
  export?: CliRunResult;
  project?: DesktopProjectPreview;
  summary: DesktopMockAgentRunSummary;
  agentReportPath?: string;
};

export type DesktopByokAgentRunRequest = DesktopMockAgentRunRequest;

export type DesktopByokAgentRunSummary = DesktopMockAgentRunSummary & {
  provider: DesktopApiKeyProvider;
  model: string;
  baseUrl?: string;
};

export type DesktopByokAgentAppliedResult = {
  projectPath: string;
  source: "provider-source-writes";
  filesChanged: string[];
  writeCount: number;
  stages: Array<{
    stage: Extract<AgentRunStage, "build" | "repair">;
    attempt?: number;
    filesChanged: string[];
    writeCount: number;
  }>;
};

export type DesktopByokAgentRunResult = {
  ok: boolean;
  providerId: "htmlslide-byok";
  projectPath: string;
  settings: {
    provider: DesktopApiKeyProvider;
    model: string;
    baseUrl?: string;
  };
  stages: DesktopMockAgentStageSummary[];
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  agent?: AgentRunResult;
  applied?: DesktopByokAgentAppliedResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: CliRunResult;
  export?: CliRunResult;
  project?: DesktopProjectPreview;
  error?: string;
  summary: DesktopByokAgentRunSummary;
  agentReportPath?: string;
};

export type DesktopExternalAgentRunRequest = {
  projectPath: string;
  brief: string;
  runExport?: boolean;
  runId?: string;
};

export type DesktopExternalAgentRunSummary = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  stageCount: number;
  completedStages: number;
  failedStages: number;
  checkStatus?: string;
  checkErrors?: number;
  checkWarnings?: number;
  exportStatus?: string;
  exportArtifacts: string[];
  filesChanged: string[];
};

export type DesktopExternalAgentRunResult = {
  ok: boolean;
  providerId: "external-generic";
  projectPath: string;
  stages: DesktopMockAgentStageSummary[];
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  adapter?: AgentAdapterRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: CliRunResult;
  export?: CliRunResult;
  project?: DesktopProjectPreview;
  error?: string;
  summary: DesktopExternalAgentRunSummary;
};

export type DesktopCheckpointRequest = {
  projectPath: string;
  runId?: string;
  checkpointId?: string;
  confirmed?: boolean;
};

export type DesktopCheckpointRevertResult = FileCopyCheckpointRevertResult & {
  project?: DesktopProjectPreview;
};

export type DesktopPresenterDeckOptions = {
  cliRuntime?: CliRuntime;
  cliRunner?: DesktopCliRunner;
};

export type DesktopPresenterDeckIssue = {
  severity: string;
  type: string;
  message: string;
  path?: string;
  slideId?: string;
};

export type DesktopPresenterDeckOrigin = "project-export" | "deckpkg-file";

export type DesktopDisplayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopPresenterDisplay = {
  id: number;
  label: string;
  primary: boolean;
  internal: boolean;
  scaleFactor: number;
  bounds: DesktopDisplayBounds;
  workArea: DesktopDisplayBounds;
};

export type DesktopNativeDisplay = {
  id: number;
  label?: string;
  internal?: boolean;
  scaleFactor?: number;
  bounds: DesktopDisplayBounds;
  workArea: DesktopDisplayBounds;
};

export type DesktopDisplaySource = {
  getAllDisplays(): DesktopNativeDisplay[];
  getPrimaryDisplay(): DesktopNativeDisplay;
};

export type DesktopPresenterDeckResult =
  | {
      ok: true;
      source: "deckpkg";
      origin: DesktopPresenterDeckOrigin;
      projectPath?: string;
      deckpkgPath: string;
      deck: PresenterDeck;
    }
  | {
      ok: false;
      source: "missing" | "invalid";
      origin: DesktopPresenterDeckOrigin;
      projectPath?: string;
      deckpkgPath?: string;
      error: string;
      issues?: DesktopPresenterDeckIssue[];
    };

export type DesktopMockAgentRunnerOptions = {
  cliRuntime?: CliRuntime;
  cliRunner?: DesktopCliRunner;
};

export type DesktopByokAgentProviderFactory = (input: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider: DesktopApiKeyProvider;
}) => ModelProvider;

export type DesktopByokAgentRunnerOptions = DesktopMockAgentRunnerOptions & {
  credentialStore?: DesktopCredentialStore;
  providerFetch?: FetchLike;
  providerFactory?: DesktopByokAgentProviderFactory;
  settings?: DesktopAiEngineSettings;
  settingsPath?: string;
};

export type DesktopExternalAgentRunnerOptions = {
  cliRuntime?: CliRuntime;
  cliRunner?: DesktopCliRunner;
  settings?: DesktopAiEngineSettings;
  settingsPath?: string;
  agentRunner?: CommandRunner;
  timeoutMs?: number;
};

export type DesktopAiEngineMode = "no-ai" | "htmlslide-agent" | "external-agent";
export type DesktopApiKeyProvider = "openai" | "anthropic" | "compatible";
export type DesktopExternalAgentId = "claude-code" | "codex-cli" | "generic";
export type DesktopExternalAgentDetectionStatus = "ready" | "not-installed" | "not-authenticated" | "unavailable";

export type DesktopAiEngineSettings = {
  version: 1;
  mode: DesktopAiEngineMode;
  apiKey: {
    provider: DesktopApiKeyProvider;
    model: string;
    baseUrl?: string;
    hasKey: boolean;
    updatedAt?: string;
  };
  externalAgent: {
    selectedId: DesktopExternalAgentId;
    customCommand: string;
    updatedAt?: string;
  };
  updatedAt?: string;
};

export type DesktopAiEngineSettingsSaveRequest = {
  settings: unknown;
  apiKeyInput?: string;
  clearKey?: boolean;
};

export type DesktopCredentialStatus = {
  available: boolean;
  hasStoredKey: boolean;
  provider: DesktopApiKeyProvider;
  service: string;
  account: string;
  message: string;
};

export type DesktopCredentialStore = {
  available: boolean;
  label: string;
  getPassword(service: string, account: string): Promise<string | undefined>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
};

export type DesktopExternalAgentStatus = {
  id: DesktopExternalAgentId;
  label: string;
  kind: DesktopExternalAgentId;
  capabilities: Record<string, boolean>;
  status: DesktopExternalAgentDetectionStatus;
  installed: boolean;
  authenticated: boolean;
  command: string;
  version?: string;
  checkedAt: string;
  summary: string;
};

export type ExternalAgentDetectorRunner = (invocation: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type DeckManifest = {
  title?: unknown;
  slides?: Array<{
    id?: unknown;
    title?: unknown;
    source?: unknown;
    notes?: unknown;
    durationSec?: unknown;
    kind?: unknown;
    status?: unknown;
  }>;
};

const DEFAULT_LIBRARY: Omit<DesktopLibrary, "defaultWorkspace"> = {
  version: 1,
  recentProjects: []
};

const DEFAULT_AI_ENGINE_SETTINGS: DesktopAiEngineSettings = {
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

const DEFAULT_AGENT_CAPABILITIES = {
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

const EXTERNAL_AGENT_SPECS = [
  {
    authArgs: ["auth", "status"] as const,
    command: "claude",
    id: "claude-code",
    kind: "claude-code",
    label: "Claude Code",
    versionArgs: ["--version"] as const
  },
  {
    authArgs: ["auth", "status"] as const,
    command: "codex",
    id: "codex-cli",
    kind: "codex-cli",
    label: "Codex CLI",
    versionArgs: ["--version"] as const
  }
] satisfies Array<{
  authArgs: readonly string[];
  command: string;
  id: DesktopExternalAgentId;
  kind: DesktopExternalAgentId;
  label: string;
  versionArgs: readonly string[];
}>;

const CLI_RUNTIME_ENTRY_PARTS = ["cli-runtime", "dist", "bin", "htmlslide.js"] as const;
const DEFAULT_ACCENT = "#315fcb";
const DEFAULT_ACCENTS = [DEFAULT_ACCENT, "#267a4f", "#9a6410", "#286a8d", "#7b4ab8", "#bc3a3a"];
const AI_ENGINE_CREDENTIAL_SERVICE = "app.htmlslide.ai-key";

export const defaultWorkspacePath = (): string => path.join(os.homedir(), "Documents", "HTMLslide");

function resolveHtmlslideHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.HTMLSLIDE_HOME ?? path.join(os.homedir(), ".htmlslide"));
}

export function resolveCreateProjectRequest(
  request: DesktopCreateProjectRequest,
  defaultWorkspace = defaultWorkspacePath()
): DesktopResolvedCreateProjectRequest {
  if (typeof request.title !== "string" || typeof request.folderName !== "string") {
    throw new Error("New deck title and folder name are required.");
  }

  if (request.workspacePath !== undefined && typeof request.workspacePath !== "string") {
    throw new Error("Workspace path must be a string.");
  }

  const title = request.title.trim().replace(/\s+/g, " ");
  if (title.length === 0) {
    throw new Error("Deck title is required.");
  }

  if (title.length > 120) {
    throw new Error("Deck title must be 120 characters or fewer.");
  }

  const folderName = request.folderName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(folderName)) {
    throw new Error("Folder name must start with a lowercase letter or number and use only lowercase letters, numbers, dashes, underscores, or dots.");
  }

  if (folderName === "." || folderName === ".." || folderName.includes("..")) {
    throw new Error("Folder name cannot contain path traversal segments.");
  }

  const workspacePath = path.resolve(request.workspacePath ?? defaultWorkspace);
  const projectPath = path.resolve(workspacePath, folderName);
  const relativePath = path.relative(workspacePath, projectPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("New deck folder must stay inside the selected workspace.");
  }

  return {
    folderName,
    projectPath,
    title,
    workspacePath
  };
}

export async function readDesktopLibrary(
  libraryPath: string,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  try {
    const contents = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<DesktopLibrary>;
    return {
      version: 1,
      defaultWorkspace:
        typeof parsed.defaultWorkspace === "string" && parsed.defaultWorkspace.length > 0
          ? parsed.defaultWorkspace
          : defaultWorkspace,
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter(isProjectRecord)
        : []
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        ...DEFAULT_LIBRARY,
        defaultWorkspace
      };
    }
    throw error;
  }
}

export async function writeDesktopLibrary(libraryPath: string, library: DesktopLibrary): Promise<void> {
  await fs.mkdir(path.dirname(libraryPath), { recursive: true });
  await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

export async function readAiEngineSettings(settingsPath: string): Promise<DesktopAiEngineSettings> {
  try {
    const contents = await fs.readFile(settingsPath, "utf8");
    return sanitizeAiEngineSettings(JSON.parse(contents));
  } catch (error) {
    if (isMissingFileError(error)) {
      return sanitizeAiEngineSettings(DEFAULT_AI_ENGINE_SETTINGS);
    }
    throw error;
  }
}

export async function writeAiEngineSettings(
  settingsPath: string,
  settings: unknown
): Promise<DesktopAiEngineSettings> {
  const safeSettings = sanitizeAiEngineSettings(settings);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(safeSettings, null, 2)}\n`);
  return safeSettings;
}

export async function saveAiEngineSettings(
  settingsPath: string,
  request: DesktopAiEngineSettingsSaveRequest,
  credentialStore: DesktopCredentialStore = createDesktopCredentialStore()
): Promise<DesktopAiEngineSettings> {
  const previousSettings = await readAiEngineSettings(settingsPath);
  const requestedSettings = sanitizeAiEngineSettings(request.settings);
  const apiKeyInput = typeof request.apiKeyInput === "string" ? request.apiKeyInput.trim() : "";
  const clearKey = request.clearKey === true;
  const providerChanged = previousSettings.apiKey.provider !== requestedSettings.apiKey.provider;
  let nextSettings: DesktopAiEngineSettings = {
    ...requestedSettings,
    apiKey: {
      ...requestedSettings.apiKey,
      hasKey: providerChanged ? false : requestedSettings.apiKey.hasKey
    }
  };

  if (clearKey) {
    await deleteAiEngineCredential(previousSettings.apiKey.provider, credentialStore);
    if (providerChanged) {
      await deleteAiEngineCredential(requestedSettings.apiKey.provider, credentialStore);
    }
    nextSettings = {
      ...nextSettings,
      apiKey: {
        ...nextSettings.apiKey,
        hasKey: false
      }
    };
  } else if (apiKeyInput.length > 0) {
    await saveAiEngineCredential(requestedSettings.apiKey.provider, apiKeyInput, credentialStore);
    if (providerChanged) {
      await deleteAiEngineCredential(previousSettings.apiKey.provider, credentialStore);
    }
    nextSettings = {
      ...nextSettings,
      apiKey: {
        ...nextSettings.apiKey,
        hasKey: true
      }
    };
  } else if (providerChanged) {
    await deleteAiEngineCredential(previousSettings.apiKey.provider, credentialStore);
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return nextSettings;
}

export async function readAiEngineCredentialStatus(
  settingsPath: string,
  credentialStore: DesktopCredentialStore = createDesktopCredentialStore()
): Promise<DesktopCredentialStatus> {
  const settings = await readAiEngineSettings(settingsPath);
  const provider = settings.apiKey.provider;
  const account = aiEngineCredentialAccount(provider);

  if (!credentialStore.available) {
    return {
      account,
      available: false,
      hasStoredKey: false,
      provider,
      service: AI_ENGINE_CREDENTIAL_SERVICE,
      message: `${credentialStore.label} is not available.`
    };
  }

  const password = await credentialStore.getPassword(AI_ENGINE_CREDENTIAL_SERVICE, account);
  return {
    account,
    available: true,
    hasStoredKey: typeof password === "string" && password.length > 0,
    provider,
    service: AI_ENGINE_CREDENTIAL_SERVICE,
    message: typeof password === "string" && password.length > 0
      ? `${credentialStore.label} has a stored ${provider} key.`
      : `${credentialStore.label} has no stored ${provider} key.`
  };
}

export async function saveAiEngineCredential(
  provider: DesktopApiKeyProvider,
  apiKey: string,
  credentialStore: DesktopCredentialStore = createDesktopCredentialStore()
): Promise<void> {
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length === 0) {
    throw new Error("API key is required.");
  }

  if (!credentialStore.available) {
    throw new Error(`${credentialStore.label} is not available for API key storage.`);
  }

  await credentialStore.setPassword(AI_ENGINE_CREDENTIAL_SERVICE, aiEngineCredentialAccount(provider), trimmedKey);
}

export async function deleteAiEngineCredential(
  provider: DesktopApiKeyProvider,
  credentialStore: DesktopCredentialStore = createDesktopCredentialStore()
): Promise<void> {
  if (!credentialStore.available) {
    return;
  }

  await credentialStore.deletePassword(AI_ENGINE_CREDENTIAL_SERVICE, aiEngineCredentialAccount(provider));
}

export async function detectExternalAgentStatuses({
  cwd = process.cwd(),
  now = new Date().toISOString(),
  runner = runDetectorCommand
}: {
  cwd?: string;
  now?: string;
  runner?: ExternalAgentDetectorRunner;
} = {}): Promise<DesktopExternalAgentStatus[]> {
  const detected = await Promise.all(
    EXTERNAL_AGENT_SPECS.map(async (spec) => {
      const versionResult = await runDetectorSafely(runner, {
        args: spec.versionArgs,
        command: spec.command,
        cwd,
        timeoutMs: 3_000
      });

      if (versionResult.kind === "not-installed") {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: false,
          label: spec.label,
          status: "not-installed",
          summary: versionResult.detail
        });
      }

      if (versionResult.result.exitCode !== 0) {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          rawVersion: versionResult.result.stderr || versionResult.result.stdout,
          status: "unavailable",
          summary: `Version check exited with ${versionResult.result.exitCode}`
        });
      }

      const authResult = await runDetectorSafely(runner, {
        args: spec.authArgs,
        command: spec.command,
        cwd,
        timeoutMs: 3_000
      });
      const version = firstNonEmptyLine(versionResult.result.stdout) ?? firstNonEmptyLine(versionResult.result.stderr);

      if (authResult.kind === "not-installed") {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: false,
          label: spec.label,
          status: "not-installed",
          summary: authResult.detail
        });
      }

      if (authResult.result.exitCode !== 0) {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          status: "not-authenticated",
          summary: authResult.result.stderr || authResult.result.stdout || "Authentication status is unavailable",
          version
        });
      }

      return externalAgentStatus({
        authenticated: true,
        checkedAt: now,
        command: spec.command,
        id: spec.id,
        installed: true,
        label: spec.label,
        status: "ready",
        summary: "Detected and authenticated",
        version
      });
    })
  );

  return [
    ...detected,
    externalAgentStatus({
      checkedAt: now,
      command: "",
      id: "generic",
      installed: false,
      label: "Generic command",
      status: "unavailable",
      summary: "Add a custom command template before detection"
    })
  ];
}

export async function upsertRecentProject(
  libraryPath: string,
  project: DesktopProjectRecord,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextProjects = [
    project,
    ...library.recentProjects.filter((item) => path.resolve(item.path) !== path.resolve(project.path))
  ].slice(0, 40);
  const nextLibrary = {
    ...library,
    recentProjects: nextProjects
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextLibrary;
}

export async function removeRecentProject(
  libraryPath: string,
  projectReference: DesktopProjectReference,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextLibrary = {
    ...library,
    recentProjects: library.recentProjects.filter((project) => !matchesProjectReference(project, projectReference))
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextLibrary;
}

export async function markRecentProjectMissing(
  libraryPath: string,
  projectReference: DesktopProjectReference,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextLibrary = {
    ...library,
    recentProjects: library.recentProjects.map((project) =>
      matchesProjectReference(project, projectReference)
        ? {
            ...project,
            status: "Missing files" as const
          }
        : project
    )
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextLibrary;
}

function matchesProjectReference(project: DesktopProjectRecord, reference: DesktopProjectReference): boolean {
  const idMatches = typeof reference.id === "string" && reference.id.length > 0 && project.id === reference.id;
  const pathMatches = typeof reference.path === "string" && reference.path.length > 0
    && path.resolve(project.path) === path.resolve(reference.path);
  return idMatches || pathMatches;
}

export async function summarizeDeckProject(projectPath: string): Promise<DesktopProjectRecord> {
  const root = path.resolve(projectPath);
  const manifest = await readDeckManifest(root);
  const title = typeof manifest.title === "string" && manifest.title.length > 0
    ? manifest.title
    : path.basename(root);
  const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
  const missingFiles = await hasMissingSlideFiles(root, manifest);

  return {
    id: `proj_${stableId(root)}`,
    title,
    path: root,
    lastOpenedAt: new Date().toISOString(),
    status: missingFiles ? "Missing files" : "Needs check",
    slideCount: slides.length
  };
}

export async function loadProjectPreview(projectPath: string): Promise<DesktopProjectPreview> {
  const project = await summarizeDeckProject(projectPath);
  const manifest = await readDeckManifest(project.path);
  const slides = await Promise.all(
    (manifest.slides ?? []).map(async (slide, index): Promise<DesktopSlidePreview> => {
      const slideId = typeof slide.id === "string" && slide.id.length > 0 ? slide.id : `slide-${index + 1}`;
      const sourcePath = typeof slide.source === "string" ? slide.source : "";
      const notesPath = typeof slide.notes === "string" ? slide.notes : undefined;
      const html = await readProjectText(project.path, sourcePath);
      const notes = notesPath ? await readProjectText(project.path, notesPath) : "";
      const title = typeof slide.title === "string" && slide.title.length > 0 ? slide.title : slideId;
      const durationSec = typeof slide.durationSec === "number" && Number.isFinite(slide.durationSec)
        ? slide.durationSec
        : 60;

      return {
        id: slideId,
        number: String(index + 1).padStart(2, "0"),
        title,
        section: typeof slide.kind === "string" ? titleCase(slide.kind) : "Content",
        status: slide.status === "ready" || slide.status === "final" ? "ready" : "needs-check",
        duration: formatDuration(durationSec),
        accent: DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length] ?? DEFAULT_ACCENT,
        speakerNotes: notes.trim(),
        bullets: extractBullets(html, title),
        sourcePath,
        notesPath,
        html
      };
    })
  );

  return {
    project,
    slides
  };
}

export async function loadDesktopPresenterDeck(
  projectPath: string,
  options: DesktopPresenterDeckOptions = {}
): Promise<DesktopPresenterDeckResult> {
  const root = path.resolve(projectPath);
  const cliRunner = options.cliRunner ?? runHtmlslideCli;
  const exportResult = options.cliRuntime
    ? await runDesktopAgentCliStep(["export", root, "--json"], options.cliRuntime, cliRunner)
    : undefined;

  if (exportResult && !exportResult.ok) {
    return {
      ok: false,
      source: "invalid",
      origin: "project-export",
      projectPath: root,
      error: exportResult.error ?? firstNonEmptyLine(exportResult.stderr) ?? `Export exited with ${exportResult.exitCode}.`
    };
  }

  const deckpkgPath = deckpkgPathFromExportResult(exportResult) ?? await findProjectDeckPackage(root);
  if (!deckpkgPath) {
    return {
      ok: false,
      source: "missing",
      origin: "project-export",
      projectPath: root,
      error: "Export did not produce a deckpkg for presenter mode."
    };
  }

  return readDesktopPresenterDeckPackage(deckpkgPath, {
    origin: "project-export",
    projectPath: root
  });
}

export async function loadDesktopPresenterDeckPackage(deckpkgPath: string): Promise<DesktopPresenterDeckResult> {
  return readDesktopPresenterDeckPackage(path.resolve(deckpkgPath), {
    origin: "deckpkg-file"
  });
}

export function listDesktopPresenterDisplays(displaySource: DesktopDisplaySource): DesktopPresenterDisplay[] {
  const primaryDisplay = displaySource.getPrimaryDisplay();
  return displaySource.getAllDisplays()
    .map((display, index) => {
      const primary = display.id === primaryDisplay.id;
      const fallbackLabel = primary ? "Primary display" : `Display ${index + 1}`;
      const label = typeof display.label === "string" && display.label.trim().length > 0
        ? display.label.trim()
        : fallbackLabel;

      return {
        id: display.id,
        label,
        primary,
        internal: display.internal === true,
        scaleFactor: typeof display.scaleFactor === "number" && Number.isFinite(display.scaleFactor)
          ? display.scaleFactor
          : 1,
        bounds: normalizeDisplayBounds(display.bounds),
        workArea: normalizeDisplayBounds(display.workArea)
      };
    })
    .sort((left, right) => {
      if (left.primary !== right.primary) {
        return left.primary ? -1 : 1;
      }
      return left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y || left.id - right.id;
    });
}

function normalizeDisplayBounds(bounds: DesktopDisplayBounds): DesktopDisplayBounds {
  return {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0,
    width: Number.isFinite(bounds.width) ? Math.max(0, Math.round(bounds.width)) : 0,
    height: Number.isFinite(bounds.height) ? Math.max(0, Math.round(bounds.height)) : 0
  };
}

function deckpkgPathFromExportResult(result: CliRunResult | undefined): string | undefined {
  const artifacts = asRecord(asRecord(result?.json)?.artifacts);
  const deckpkg = artifacts?.deckpkg;
  return typeof deckpkg === "string" && deckpkg.length > 0 ? deckpkg : undefined;
}

export async function runHtmlslideCli(args: string[], options: CliRunnerOptions): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const command = process.execPath;
  const cliPath = options.cliPath ?? (options.rootPath ? path.join(options.rootPath, "packages", "cli", "dist", "bin", "htmlslide.js") : undefined);

  if (!cliPath) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI runtime was not configured for this desktop build."
    };
  }

  const commandArgs = [cliPath, ...args];
  const cliExists = await pathExists(cliPath);

  if (!cliExists) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: `HTMLslide CLI runtime was not found at ${cliPath}.`
    };
  }

  return new Promise<CliRunResult>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? options.rootPath ?? path.dirname(cliPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...options.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: 6,
        stdout,
        stderr,
        error: `htmlslide ${args.join(" ")} timed out after ${timeoutMs}ms.`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        json: parseJsonOutput(stdout)
      });
    });
  });
}

function officialSkillsBaseState(options: DesktopOfficialSkillsOptions = {}): DesktopOfficialSkillsState {
  const htmlslideHomeDir = resolveHtmlslideHomeDir(options.env);
  const skillsDir = path.join(htmlslideHomeDir, "skills");
  return {
    available: true,
    htmlslideHomeDir,
    installed: false,
    installedCount: 0,
    managed: true,
    message: "Official skills have not been checked yet.",
    missing: [],
    names: OFFICIAL_SKILLS.map((skill) => skill.metadata.name),
    skillCount: OFFICIAL_SKILLS.length,
    skillsDir,
    stale: [],
    status: "info",
    updatedAt: options.now ?? new Date().toISOString()
  };
}

function officialSkillEntryPath(htmlslideHomeDir: string, skillName: string): string {
  return path.join(htmlslideHomeDir, "skills", skillName, "SKILL.md");
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function getDesktopOfficialSkills(
  options: DesktopOfficialSkillsOptions = {}
): Promise<DesktopOfficialSkillsState> {
  const base = officialSkillsBaseState(options);
  const registry = validateOfficialSkillRegistry();
  if (!registry.ok) {
    return {
      ...base,
      available: false,
      status: "failed",
      message: `Official skill registry is invalid (${registry.issues.length} issue${registry.issues.length === 1 ? "" : "s"}).`,
      suggestedFix: "Run packages/skills tests and fix official skill metadata before packaging."
    };
  }

  const missing: string[] = [];
  const stale: string[] = [];
  let installedCount = 0;

  await Promise.all(OFFICIAL_SKILLS.map(async (skill) => {
    const entryPath = officialSkillEntryPath(base.htmlslideHomeDir, skill.metadata.name);
    const current = await readTextIfExists(entryPath);
    if (current === undefined) {
      missing.push(skill.metadata.name);
      return;
    }
    if (current !== skill.markdown) {
      stale.push(skill.metadata.name);
      return;
    }
    installedCount += 1;
  }));

  missing.sort();
  stale.sort();
  const installed = missing.length === 0 && stale.length === 0 && installedCount === OFFICIAL_SKILLS.length;
  const pendingCount = missing.length + stale.length;

  return {
    ...base,
    installed,
    installedCount,
    message: installed
      ? `${installedCount} official skills installed.`
      : `${pendingCount} official skill${pendingCount === 1 ? "" : "s"} need installation or update.`,
    missing,
    stale,
    status: installed ? "passed" : "warning",
    suggestedFix: installed ? undefined : "Install official skills from onboarding or Settings."
  };
}

export async function installDesktopOfficialSkills(
  options: DesktopOfficialSkillsOptions = {}
): Promise<DesktopOfficialSkillsState> {
  const before = await getDesktopOfficialSkills(options);
  if (!before.available) {
    return before;
  }

  const action: DesktopOfficialSkillsState["action"] =
    before.installed ? "unchanged" : before.stale.length > 0 ? "updated" : "installed";

  try {
    await Promise.all(OFFICIAL_SKILLS.map(async (skill) => {
      const entryPath = officialSkillEntryPath(before.htmlslideHomeDir, skill.metadata.name);
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, skill.markdown, "utf8");
    }));
  } catch (error) {
    return {
      ...before,
      action,
      status: "failed",
      installed: false,
      message: error instanceof Error ? error.message : String(error),
      suggestedFix: `Check write permissions for ${before.skillsDir}.`
    };
  }

  const after = await getDesktopOfficialSkills({
    ...options,
    now: before.updatedAt
  });

  return {
    ...after,
    action,
    message:
      action === "unchanged"
        ? `${after.installedCount} official skills already installed.`
        : `${after.installedCount} official skills ${action}.`
  };
}

export async function resolveDesktopCliIntegrationTarget(
  env: NodeJS.ProcessEnv = process.env
): Promise<DesktopCliIntegrationTarget> {
  const htmlslideHomeDir = resolveHtmlslideHomeDir(env);
  const explicitTargetPath = env.HTMLSLIDE_CLI_TARGET_PATH;
  if (explicitTargetPath && explicitTargetPath.trim().length > 0) {
    const targetPath = path.resolve(explicitTargetPath);
    return {
      targetDir: path.dirname(targetPath),
      targetPath,
      htmlslideHomeDir,
      source: "env"
    };
  }

  const explicitTargetDir = env.HTMLSLIDE_CLI_TARGET_DIR;
  if (explicitTargetDir && explicitTargetDir.trim().length > 0) {
    const targetDir = path.resolve(explicitTargetDir);
    return {
      targetDir,
      targetPath: path.join(targetDir, "htmlslide"),
      htmlslideHomeDir,
      source: "env"
    };
  }

  const preferredTargets = [
    { dir: "/opt/homebrew/bin", source: "homebrew" as const },
    { dir: "/usr/local/bin", source: "usr-local" as const }
  ];

  for (const candidate of preferredTargets) {
    if (await isWritableExistingDirectory(candidate.dir)) {
      return {
        targetDir: candidate.dir,
        targetPath: path.join(candidate.dir, "htmlslide"),
        htmlslideHomeDir,
        source: candidate.source
      };
    }
  }

  const targetDir = path.join(htmlslideHomeDir, "bin");
  return {
    targetDir,
    targetPath: path.join(targetDir, "htmlslide"),
    htmlslideHomeDir,
    source: "user-home"
  };
}

export async function getDesktopCliIntegration(
  options: DesktopCliIntegrationOptions = {}
): Promise<DesktopCliIntegrationState> {
  const cliRuntime = options.cliRuntime;
  const target = await resolveDesktopCliIntegrationTarget(options.env);
  const base = cliIntegrationBaseState(target, options);

  if (!cliRuntime) {
    return {
      ...base,
      available: false,
      mode: "missing",
      status: "failed",
      installed: false,
      managed: false,
      onPath: false,
      message: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide.",
      suggestedFix: "Rebuild the desktop app so the CLI runtime is available."
    };
  }

  const runner = options.cliRunner ?? runHtmlslideCli;
  const result = await runner(["setup", "status", "--target-path", target.targetPath, "--json"], {
    cliPath: cliRuntime.cliPath,
    cwd: cliRuntime.cwd,
    env: {
      HTMLSLIDE_HOME: target.htmlslideHomeDir
    },
    rootPath: cliRuntime.rootPath
  });

  return cliIntegrationStateFromCliResult(result, base, cliRuntime, options.appPath);
}

export async function installDesktopCliIntegration(
  options: DesktopCliIntegrationOptions = {}
): Promise<DesktopCliIntegrationState> {
  return runDesktopCliIntegrationAction("install", options);
}

export async function uninstallDesktopCliIntegration(
  options: DesktopCliIntegrationOptions = {}
): Promise<DesktopCliIntegrationState> {
  return runDesktopCliIntegrationAction("uninstall", options);
}

export async function runDesktopMockAgent(
  request: DesktopMockAgentRunRequest,
  options: DesktopMockAgentRunnerOptions = {}
): Promise<DesktopMockAgentRunResult> {
  const projectPath = path.resolve(request.projectPath);
  const brief = request.brief.trim();
  const logs: AgentRunLog[] = [];
  const cliRunner = options.cliRunner ?? runHtmlslideCli;

  let agent = await runAgent({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    maxRepairRounds: request.maxRepairRounds,
    projectRoot: projectPath,
    provider: createMockProvider(),
    runId: request.runId,
    metadata: {
      mode: "desktop-mock-agent"
    },
    createCheckpoint: createFileCopyCheckpoint
  });

  logs.push(...agent.logs);

  let applied: ApplyMockAgentProjectResult | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CliRunResult | undefined;
  let exportResult: CliRunResult | undefined;
  let project: DesktopProjectPreview | undefined;

  if (agent.ok) {
    applied = await applyMockAgentProject({
      brief,
      projectPath,
      result: agent
    });
    const checkpoint = await recordCheckpointChanges({
      projectRoot: projectPath,
      runId: agent.runId,
      filesChanged: applied.filesChanged
    });
    agent = {
      ...agent,
      checkpoint
    };
    checkpointDiff = await diffFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: agent.runId
    });
    logs.push({
      createdAt: new Date().toISOString(),
      level: "info",
      message: `Applied mock source files: ${applied.filesChanged.join(", ")}`,
      runId: agent.runId,
      stage: "build",
      metadata: {
        filesChanged: applied.filesChanged
      }
    });

    check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner);
    logs.push(desktopAgentCliLog(agent.runId, "check", check));

    if (check.ok && request.runExport !== false) {
      exportResult = await runDesktopAgentCliStep(["export", projectPath, "--json"], options.cliRuntime, cliRunner);
      logs.push(desktopAgentCliLog(agent.runId, "export", exportResult));
    }

    project = await loadProjectPreview(projectPath);
  }

  const stages = summarizeAgentStages(agent.events);
  const summary = summarizeDesktopMockAgentRun(agent, check, exportResult);
  const agentReportPath = await writeDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId: "htmlslide-mock",
    stages
  });

  return {
    ok: agent.ok && (check === undefined || check.ok) && (exportResult === undefined || exportResult.ok),
    providerId: "htmlslide-mock",
    projectPath,
    stages,
    events: agent.events,
    logs,
    agent,
    applied,
    checkpointDiff,
    check,
    export: exportResult,
    project,
    summary,
    agentReportPath
  };
}

export async function runDesktopByokAgent(
  request: DesktopByokAgentRunRequest,
  options: DesktopByokAgentRunnerOptions = {}
): Promise<DesktopByokAgentRunResult> {
  const projectPath = path.resolve(request.projectPath);
  const runId = normalizeDesktopAgentRunId(request.runId);
  const brief = request.brief.trim();
  const events: AgentRunEvent[] = [];
  const logs: AgentRunLog[] = [];
  const cliRunner = options.cliRunner ?? runHtmlslideCli;
  const credentialStore = options.credentialStore ?? createDesktopCredentialStore();
  const addEvent = createDesktopAgentEventRecorder(events, runId);
  const addLog = createDesktopAgentLogRecorder(logs, runId);
  const settings = sanitizeAiEngineSettings(options.settings ?? (options.settingsPath
    ? await readAiEngineSettings(options.settingsPath)
    : DEFAULT_AI_ENGINE_SETTINGS));
  const provider = settings.apiKey.provider;
  const model = settings.apiKey.model;
  const baseUrl = settings.apiKey.baseUrl;
  const settingsSummary = { provider, model, baseUrl };
  const settingsMetadata = byokSettingsMetadata(settingsSummary);

  addEvent("brief", "running", "HTMLslide Agent request accepted.", "run-created", {
    metadata: settingsMetadata,
    nextAction: "Validate provider credential"
  });

  if (!settings.apiKey.hasKey) {
    return byokAgentFailureResult({
      addEvent,
      addLog,
      error: "Save a provider API key in AI Engines before running HTMLslide Agent.",
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      stage: "brief"
    });
  }

  if (!credentialStore.available) {
    return byokAgentFailureResult({
      addEvent,
      addLog,
      error: `${credentialStore.label} is not available for HTMLslide Agent credentials.`,
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      stage: "brief"
    });
  }

  const credentialAccount = aiEngineCredentialAccount(provider);
  const apiKey = await credentialStore.getPassword(AI_ENGINE_CREDENTIAL_SERVICE, credentialAccount);
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return byokAgentFailureResult({
      addEvent,
      addLog,
      error: `Stored ${provider} API key was not found. Save the key again in AI Engines settings.`,
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      stage: "brief"
    });
  }

  let modelProvider: ModelProvider;
  try {
    modelProvider = options.providerFactory
      ? options.providerFactory({
          apiKey,
          baseUrl,
          model,
          provider
        })
      : createDesktopByokModelProvider({
          apiKey,
          baseUrl,
          fetch: options.providerFetch,
          model,
          provider
        });
    const credentialStatus = await modelProvider.validateCredentials();
    if (!credentialStatus.ok) {
      return byokAgentFailureResult({
        addEvent,
        addLog,
        error: credentialStatus.reason,
        events,
        logs,
        projectPath,
        runId,
        settings: settingsSummary,
        stage: "brief"
      });
    }
  } catch (error) {
    return byokAgentFailureResult({
      addEvent,
      addLog,
      error: error instanceof Error ? error.message : String(error),
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      stage: "brief"
    });
  }

  let agent = await runAgent({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    maxRepairRounds: request.maxRepairRounds,
    projectRoot: projectPath,
    provider: modelProvider,
    runId,
    metadata: {
      credentialAccount,
      ...(baseUrl ? { baseUrl } : {}),
      mode: "desktop-byok-agent",
      model,
      provider
    },
    createCheckpoint: createFileCopyCheckpoint
  });

  logs.push({
    createdAt: new Date().toISOString(),
    level: "info",
    message: `${credentialStore.label} credential validated for ${provider}.`,
    metadata: {
      credentialAccount,
      ...(baseUrl ? { baseUrl } : {}),
      model,
      provider
    },
    runId,
    stage: "brief"
  });
  logs.push(...agent.logs);

  let applied: DesktopByokAgentAppliedResult | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CliRunResult | undefined;
  let exportResult: CliRunResult | undefined;
  let project: DesktopProjectPreview | undefined;

  if (agent.ok) {
    applied = await applyByokAgentSourceWrites({
      projectPath,
      result: agent
    });
    const checkpoint = await recordCheckpointChanges({
      projectRoot: projectPath,
      runId: agent.runId,
      filesChanged: applied.filesChanged
    });
    agent = {
      ...agent,
      checkpoint
    };
    checkpointDiff = await diffFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: agent.runId
    });
    logs.push({
      createdAt: new Date().toISOString(),
      level: "info",
      message: `Applied HTMLslide Agent source writes: ${applied.filesChanged.join(", ")}`,
      runId: agent.runId,
      stage: "build",
      metadata: {
        filesChanged: applied.filesChanged,
        source: applied.source,
        writeCount: applied.writeCount,
        model,
        provider
      }
    });

    check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner);
    logs.push(desktopAgentCliLog(agent.runId, "check", check));

    if (check.ok && request.runExport !== false) {
      exportResult = await runDesktopAgentCliStep(["export", projectPath, "--json"], options.cliRuntime, cliRunner);
      logs.push(desktopAgentCliLog(agent.runId, "export", exportResult));
    }

    project = await loadProjectPreview(projectPath);
  }

  const stages = summarizeAgentStages(agent.events);
  const summary = summarizeDesktopByokAgentRun(agent, check, exportResult, settingsSummary);
  const agentReportPath = await writeDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId: "htmlslide-byok",
    stages
  });

  return {
    ok: agent.ok && (check === undefined || check.ok) && (exportResult === undefined || exportResult.ok),
    providerId: "htmlslide-byok",
    projectPath,
    settings: settingsSummary,
    stages,
    events: agent.events,
    logs,
    agent,
    applied,
    checkpointDiff,
    check,
    export: exportResult,
    project,
    summary,
    agentReportPath
  };
}

export async function runDesktopExternalAgent(
  request: DesktopExternalAgentRunRequest,
  options: DesktopExternalAgentRunnerOptions = {}
): Promise<DesktopExternalAgentRunResult> {
  const projectPath = path.resolve(request.projectPath);
  const runId = normalizeExternalAgentRunId(request.runId);
  const brief = request.brief.trim();
  const events: AgentRunEvent[] = [];
  const logs: AgentRunLog[] = [];
  const cliRunner = options.cliRunner ?? runHtmlslideCli;
  const addEvent = createDesktopAgentEventRecorder(events, runId);
  const addLog = createDesktopAgentLogRecorder(logs, runId);

  addEvent("brief", "running", "External agent request accepted.", "run-created", {
    nextAction: "Prepare prompt"
  });

  const settings = options.settings ?? (options.settingsPath
    ? await readAiEngineSettings(options.settingsPath)
    : sanitizeAiEngineSettings(DEFAULT_AI_ENGINE_SETTINGS));

  if (settings.mode !== "external-agent") {
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: "External agent mode is not selected in AI Engines settings.",
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }

  if (settings.externalAgent.selectedId !== "generic") {
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: "Only Generic command headless runs are enabled in this milestone.",
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }

  const commandTemplate = settings.externalAgent.customCommand.trim();
  if (commandTemplate.length === 0) {
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: "Generic command template is required before running an external agent.",
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }

  const checkpoint = await createFileCopyCheckpoint({
    projectRoot: projectPath,
    runId
  });
  addEvent("brief", "succeeded", "External agent checkpoint created.", "checkpoint-created", {
    checkpointId: checkpoint.id,
    nextAction: "Run generic command"
  });

  const runDirectory = path.join(projectPath, ".htmlslide", "runs", runId);
  const promptFile = path.join(runDirectory, "prompt.md");
  const writeManifest = path.join(runDirectory, "writes.json");
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(promptFile, externalAgentPrompt({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    projectPath,
    writeManifest
  }), "utf8");
  await fs.writeFile(writeManifest, `${JSON.stringify({ writes: [] }, null, 2)}\n`, "utf8");

  const adapterConfig: GenericAgentAdapterConfig = {
    id: "generic-command",
    label: "Generic command",
    kind: "generic",
    commandTemplate,
    capabilities: createCapabilitySet(["headlessRun", "streamLogs", "readDiff"]),
    pathVariables: ["projectRoot", "projectPath", "promptFile", "writeManifest"],
    timeoutMs: options.timeoutMs ?? 120_000
  };

  addEvent("build", "running", "Running Generic command external agent.", "stage-started", {
    nextAction: "Wait for reported writes"
  });

  const adapter = sanitizeAgentAdapterRunResult(
    await runGenericAgentAdapter({
      adapter: adapterConfig,
      projectRoot: projectPath,
      promptFile,
      variables: {
        writeManifest
      },
      onOutput: (chunk) => {
        const message = chunk.text.trim();
        if (message.length === 0) {
          return;
        }

        addLog(chunk.stream === "stdout" ? "info" : "warning", message, "build", {
          stream: chunk.stream
        });
      },
      runner: options.agentRunner,
      timeoutMs: options.timeoutMs,
      readReportedFileWrites: () => readJsonFileWriteManifest(projectPath, writeManifest)
    })
  );

  if (!adapter.ok) {
    const error = adapter.failure.detail ?? adapter.failure.message;
    addEvent("build", adapter.status === "cancelled" ? "cancelled" : "failed", adapter.failure.message, adapter.status === "cancelled" ? "run-cancelled" : "stage-failed", {
      nextAction: adapter.failure.remediation
    });
    addLog(adapter.status === "cancelled" ? "warning" : "error", error, "build", {
      failureType: adapter.failure.type
    });

    return {
      ok: false,
      providerId: "external-generic",
      projectPath,
      stages: summarizeAgentStages(events),
      events,
      logs,
      adapter,
      error,
      summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
    };
  }

  const filesChanged = adapter.reportedWrites.map((reportedWrite) => projectRelativeSourcePath(projectPath, reportedWrite));
  await recordCheckpointChanges({
    projectRoot: projectPath,
    runId,
    filesChanged
  });
  const checkpointDiff = await diffFileCopyCheckpoint({
    projectRoot: projectPath,
    runId
  });

  addEvent("build", "succeeded", `External agent reported ${filesChanged.length} source file writes.`, "stage-completed", {
    filesChanged,
    nextAction: "Run htmlslide check"
  });
  addLog("info", "Generic command completed.", "build", {
    filesChanged
  });

  addEvent("check", "running", "Running htmlslide check after external agent changes.", "stage-started", {
    nextAction: "Validate source files"
  });
  const check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner);
  logs.push(desktopAgentCliLog(runId, "check", check));
  const checkIssues = checkIssueCount(check);
  addEvent("check", check.ok ? "succeeded" : "failed", check.ok ? "Check passed after external agent run." : "Check found issues after external agent run.", check.ok ? "stage-completed" : "stage-failed", {
    issuesFound: checkIssues,
    nextAction: check.ok ? "Export artifacts" : "Review QA issues"
  });

  let exportResult: CliRunResult | undefined;
  if (check.ok && request.runExport !== false) {
    addEvent("export", "running", "Exporting artifacts after external agent run.", "stage-started", {
      nextAction: "Write PDF, HTML, deckpkg, notes, and thumbnails"
    });
    exportResult = await runDesktopAgentCliStep(["export", projectPath, "--json"], options.cliRuntime, cliRunner);
    logs.push(desktopAgentCliLog(runId, "export", exportResult));
    addEvent("export", exportResult.ok ? "succeeded" : "failed", exportResult.ok ? "Export completed after external agent run." : "Export failed after external agent run.", exportResult.ok ? "stage-completed" : "stage-failed", {
      nextAction: exportResult.ok ? "Review generated changes" : "Inspect export failure"
    });
  }

  const project = await loadProjectPreview(projectPath).catch((): DesktopProjectPreview | undefined => undefined);
  const ok = check.ok && (exportResult === undefined || exportResult.ok);
  addEvent("review", ok ? "succeeded" : "failed", ok ? "External agent changes are ready for review." : "External agent changes need review.", ok ? "run-completed" : "run-failed", {
    filesChanged,
    nextAction: ok ? "Accept or revert checkpoint" : "Inspect QA/export status"
  });

  return {
    ok,
    providerId: "external-generic",
    projectPath,
    stages: summarizeAgentStages(events),
    events,
    logs,
    adapter,
    checkpointDiff,
    check,
    export: exportResult,
    project,
    summary: summarizeDesktopExternalAgentRun(runId, events, check, exportResult, filesChanged)
  };
}

export async function diffDesktopCheckpoint(request: DesktopCheckpointRequest): Promise<FileCopyCheckpointDiff> {
  return diffFileCopyCheckpoint({
    projectRoot: path.resolve(request.projectPath),
    runId: request.runId,
    checkpointId: request.checkpointId
  });
}

export async function revertDesktopCheckpoint(
  request: DesktopCheckpointRequest
): Promise<DesktopCheckpointRevertResult> {
  if (request.confirmed !== true) {
    throw new Error("Checkpoint revert requires explicit confirmation.");
  }

  const projectPath = path.resolve(request.projectPath);
  const reverted = await revertFileCopyCheckpoint({
    projectRoot: projectPath,
    runId: request.runId,
    checkpointId: request.checkpointId
  });

  return {
    ...reverted,
    project: await loadProjectPreview(projectPath).catch(() => undefined)
  };
}

export function findCliRuntime(startPath: string, resourcesPath?: string): CliRuntime | undefined {
  const repoRoot = findRepositoryRoot(startPath);
  if (repoRoot) {
    const cliPath = path.join(repoRoot, "packages", "cli", "dist", "bin", "htmlslide.js");
    if (pathExistsSync(cliPath)) {
      return {
        mode: "development",
        cliPath,
        cwd: repoRoot,
        rootPath: repoRoot
      };
    }
  }

  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const resourceRoots = [
    resourcesPath,
    typeof processResourcesPath === "string" ? processResourcesPath : undefined,
    path.resolve(startPath, "..", "..", "..")
  ].filter((value): value is string => Boolean(value));

  for (const resourceRoot of resourceRoots) {
    const appResourcesRoot = path.join(resourceRoot, "app");
    const cliPath = path.join(appResourcesRoot, ...CLI_RUNTIME_ENTRY_PARTS);
    if (pathExistsSync(cliPath)) {
      return {
        mode: "packaged",
        cliPath,
        cwd: path.join(appResourcesRoot, "cli-runtime")
      };
    }
  }

  return undefined;
}

export function findRepositoryRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath);
  while (true) {
    if (pathExistsSync(path.join(current, "pnpm-workspace.yaml")) && pathExistsSync(path.join(current, "packages", "cli"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function sanitizeAiEngineSettings(value: unknown): DesktopAiEngineSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_AI_ENGINE_SETTINGS, apiKey: { ...DEFAULT_AI_ENGINE_SETTINGS.apiKey }, externalAgent: { ...DEFAULT_AI_ENGINE_SETTINGS.externalAgent } };
  }

  const apiKey = isRecord(value.apiKey) ? value.apiKey : {};
  const externalAgent = isRecord(value.externalAgent) ? value.externalAgent : {};
  const provider = normalizeApiKeyProvider(apiKey.provider);

  return {
    apiKey: {
      baseUrl: normalizeProviderBaseUrl(apiKey.baseUrl, provider),
      hasKey: apiKey.hasKey === true,
      model: normalizeModel(apiKey.model, provider),
      provider,
      updatedAt: typeof apiKey.updatedAt === "string" ? apiKey.updatedAt : undefined
    },
    externalAgent: {
      customCommand: typeof externalAgent.customCommand === "string" ? externalAgent.customCommand.trim() : "",
      selectedId: normalizeExternalAgentId(externalAgent.selectedId),
      updatedAt: typeof externalAgent.updatedAt === "string" ? externalAgent.updatedAt : undefined
    },
    mode: normalizeAiEngineMode(value.mode),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    version: 1
  };
}

function normalizeAiEngineMode(value: unknown): DesktopAiEngineMode {
  return value === "htmlslide-agent" || value === "external-agent" || value === "no-ai" ? value : "no-ai";
}

function normalizeApiKeyProvider(value: unknown): DesktopApiKeyProvider {
  return value === "anthropic" || value === "compatible" || value === "openai" ? value : "openai";
}

function normalizeExternalAgentId(value: unknown): DesktopExternalAgentId {
  return value === "claude-code" || value === "generic" || value === "codex-cli" ? value : "codex-cli";
}

function normalizeModel(value: unknown, provider: DesktopApiKeyProvider): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (provider === "anthropic") {
    return "claude-sonnet-4-5";
  }

  if (provider === "compatible") {
    return "openai-compatible/default";
  }

  return "gpt-5-mini";
}

function normalizeProviderBaseUrl(value: unknown, provider: DesktopApiKeyProvider): string | undefined {
  if (provider !== "compatible" || typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

function externalAgentStatus({
  authenticated = false,
  checkedAt,
  command,
  id,
  installed,
  label,
  status,
  summary,
  version
}: {
  authenticated?: boolean;
  checkedAt: string;
  command: string;
  id: DesktopExternalAgentId;
  installed: boolean;
  label: string;
  rawVersion?: string;
  status: DesktopExternalAgentDetectionStatus;
  summary: string;
  version?: string;
}): DesktopExternalAgentStatus {
  return {
    authenticated,
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
    checkedAt,
    command,
    id,
    installed,
    kind: id,
    label,
    status,
    summary: collapseWhitespace(summary),
    version
  };
}

type DetectorCommandOutcome =
  | {
      kind: "result";
      result: Awaited<ReturnType<ExternalAgentDetectorRunner>>;
    }
  | {
      detail: string;
      kind: "not-installed";
    };

async function runDetectorSafely(
  runner: ExternalAgentDetectorRunner,
  invocation: Parameters<ExternalAgentDetectorRunner>[0]
): Promise<DetectorCommandOutcome> {
  try {
    const result = await runner(invocation);
    if (isCommandNotFoundText(result.stderr)) {
      return {
        detail: result.stderr,
        kind: "not-installed"
      };
    }
    return {
      kind: "result",
      result
    };
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      return {
        detail: error instanceof Error ? error.message : String(error),
        kind: "not-installed"
      };
    }
    throw error;
  }
}

function runDetectorCommand(invocation: Parameters<ExternalAgentDetectorRunner>[0]): Promise<Awaited<ReturnType<ExternalAgentDetectorRunner>>> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || `Command ${invocation.command} timed out after ${invocation.timeoutMs}ms.`
      });
    }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message
      });
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function runSecurityCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message
      });
    });
    child.once("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function aiEngineCredentialAccount(provider: DesktopApiKeyProvider): string {
  return `provider:${provider}`;
}

function isKeychainNotFound(stderr: string): boolean {
  return /could not be found|The specified item could not be found|SecKeychainSearchCopyNext/u.test(stderr);
}

async function readDeckManifest(projectPath: string): Promise<DeckManifest> {
  const deckPath = path.join(projectPath, "deck.json");
  const contents = await fs.readFile(deckPath, "utf8");
  return JSON.parse(contents) as DeckManifest;
}

async function findProjectDeckPackage(projectPath: string): Promise<string | undefined> {
  const manifest = await readDeckManifest(projectPath);
  const title = typeof manifest.title === "string" && manifest.title.trim().length > 0
    ? manifest.title
    : path.basename(projectPath);
  const exportsPath = path.join(projectPath, "exports");
  const expectedPath = path.join(exportsPath, `${slugFileName(title)}.deckpkg`);
  if (await pathExists(expectedPath)) {
    return expectedPath;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(exportsPath);
  } catch {
    return undefined;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".deckpkg"))
      .map(async (entry) => {
        const filePath = path.join(exportsPath, entry);
        const stat = await fs.stat(filePath).catch(() => undefined);
        return stat?.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : undefined;
      })
  );

  return candidates
    .filter(isPresent)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath))[0]?.filePath;
}

async function readDesktopPresenterDeckPackage(
  deckpkgPath: string,
  context: { origin: DesktopPresenterDeckOrigin; projectPath?: string }
): Promise<DesktopPresenterDeckResult> {
  const resolvedDeckpkgPath = path.resolve(deckpkgPath);
  if (!(await pathExists(resolvedDeckpkgPath))) {
    return {
      ok: false,
      source: "missing",
      origin: context.origin,
      projectPath: context.projectPath,
      deckpkgPath: resolvedDeckpkgPath,
      error: "Deck package file was not found."
    };
  }

  try {
    const deckPackage = await readDeckPackage(resolvedDeckpkgPath);
    return {
      ok: true,
      source: "deckpkg",
      origin: context.origin,
      projectPath: context.projectPath,
      deckpkgPath: resolvedDeckpkgPath,
      deck: presenterDeckFromPackage(deckPackage)
    };
  } catch (error) {
    if (error instanceof DeckPackageValidationError) {
      return {
        ok: false,
        source: "invalid",
        origin: context.origin,
        projectPath: context.projectPath,
        deckpkgPath: resolvedDeckpkgPath,
        error: "Deck package validation failed.",
        issues: desktopPresenterDeckIssues(error)
      };
    }

    return {
      ok: false,
      source: "invalid",
      origin: context.origin,
      projectPath: context.projectPath,
      deckpkgPath: resolvedDeckpkgPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function desktopPresenterDeckIssues(error: DeckPackageValidationError): DesktopPresenterDeckIssue[] {
  return error.issues.map((issue) => ({
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
    path: issue.path,
    slideId: issue.slideId
  }));
}

function presenterDeckFromPackage(deckPackage: PresenterDeckPackage): PresenterDeck {
  return {
    title: deckPackage.manifest.title,
    settings: deckPackage.settings,
    slides: deckPackage.slides.map((slide) => ({
      ...slide,
      thumbnail: {
        ...slide.thumbnail,
        bytes: new Uint8Array(),
        dataUrl: presenterThumbnailDataUrl(slide.thumbnail.bytes)
      }
    }))
  };
}

function presenterThumbnailDataUrl(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) {
    return undefined;
  }
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function hasMissingSlideFiles(projectPath: string, manifest: DeckManifest): Promise<boolean> {
  for (const slide of manifest.slides ?? []) {
    const source = typeof slide.source === "string" ? slide.source : undefined;
    if (!source || !(await pathExists(resolveProjectPath(projectPath, source)))) {
      return true;
    }
    const notes = typeof slide.notes === "string" ? slide.notes : undefined;
    if (notes && !(await pathExists(resolveProjectPath(projectPath, notes)))) {
      return true;
    }
  }
  return false;
}

async function readProjectText(projectPath: string, relativePath: string): Promise<string> {
  if (relativePath.length === 0) {
    return "";
  }
  return fs.readFile(resolveProjectPath(projectPath, relativePath), "utf8");
}

function resolveProjectPath(projectPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  const resolved = path.resolve(projectPath, relativePath);
  const root = path.resolve(projectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  return resolved;
}

function extractBullets(html: string, fallbackTitle: string): string[] {
  const listItems = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);

  if (listItems.length > 0) {
    return listItems;
  }

  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);

  return paragraphs.length > 0 ? paragraphs : [`Review ${fallbackTitle}`];
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function stableId(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "deck";
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function isWritableExistingDirectory(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      return false;
    }
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function cliIntegrationBaseState(
  target: DesktopCliIntegrationTarget,
  options: DesktopCliIntegrationOptions
): DesktopCliIntegrationState {
  return {
    appPath: options.appPath,
    available: Boolean(options.cliRuntime),
    cliPath: options.cliRuntime?.cliPath,
    htmlslideHomeDir: target.htmlslideHomeDir,
    installed: false,
    managed: false,
    manualInstallCommand: buildCliIntegrationManualCommand("install", target, options),
    manualUninstallCommand: buildCliIntegrationManualCommand("uninstall", target, options),
    message: "HTMLslide CLI integration has not been checked yet.",
    mode: options.cliRuntime?.mode ?? "missing",
    onPath: false,
    status: "info",
    targetDir: target.targetDir,
    targetPath: target.targetPath,
    updatedAt: options.now ?? new Date().toISOString()
  };
}

function buildCliIntegrationManualCommand(
  action: "install" | "uninstall",
  target: DesktopCliIntegrationTarget,
  options: DesktopCliIntegrationOptions
): string {
  const cliPath = options.cliRuntime?.cliPath ?? "<HTMLslide CLI path>";
  const executable = options.nodeExecutable ?? process.execPath;
  const envPrefix = process.versions.electron ? "ELECTRON_RUN_AS_NODE=1 " : "";
  const args =
    action === "install"
      ? [
          executable,
          cliPath,
          "setup",
          "install-cli",
          "--target-path",
          target.targetPath,
          ...(options.appPath ? ["--app-path", options.appPath] : []),
          ...(options.appVersion ? ["--app-version", options.appVersion] : []),
          ...(options.bundleId ? ["--bundle-id", options.bundleId] : []),
          "--fallback-cli-path",
          cliPath
        ]
      : [
          executable,
          cliPath,
          "setup",
          "uninstall-cli",
          "--target-path",
          target.targetPath
        ];

  return `${envPrefix}HTMLSLIDE_HOME=${shellQuote(target.htmlslideHomeDir)} ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runDesktopCliIntegrationAction(
  action: "install" | "uninstall",
  options: DesktopCliIntegrationOptions
): Promise<DesktopCliIntegrationState> {
  const cliRuntime = options.cliRuntime;
  const target = await resolveDesktopCliIntegrationTarget(options.env);
  const base = cliIntegrationBaseState(target, options);

  if (!cliRuntime) {
    return {
      ...base,
      available: false,
      mode: "missing",
      status: "failed",
      message: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide.",
      suggestedFix: "Rebuild the desktop app so the CLI runtime is available."
    };
  }

  const runner = options.cliRunner ?? runHtmlslideCli;
  const args =
    action === "install"
      ? [
          "setup",
          "install-cli",
          "--target-path",
          target.targetPath,
          ...(options.appPath ? ["--app-path", options.appPath] : []),
          ...(options.appVersion ? ["--app-version", options.appVersion] : []),
          ...(options.bundleId ? ["--bundle-id", options.bundleId] : []),
          "--fallback-cli-path",
          cliRuntime.cliPath,
          "--json"
        ]
      : ["setup", "uninstall-cli", "--target-path", target.targetPath, "--json"];
  const result = await runner(args, {
    cliPath: cliRuntime.cliPath,
    cwd: cliRuntime.cwd,
    env: {
      HTMLSLIDE_HOME: target.htmlslideHomeDir
    },
    rootPath: cliRuntime.rootPath
  });
  const state = cliIntegrationStateFromCliResult(result, base, cliRuntime, options.appPath);

  if (!result.ok) {
    return state;
  }

  return getDesktopCliIntegration({
    ...options,
    cliRuntime,
    cliRunner: runner,
    now: state.updatedAt
  }).then((nextState) => ({
    ...nextState,
    action: state.action,
    message: state.message
  }));
}

function cliIntegrationStateFromCliResult(
  result: CliRunResult,
  base: DesktopCliIntegrationState,
  cliRuntime: CliRuntime,
  appPath?: string
): DesktopCliIntegrationState {
  const payload = isRecord(result.json) ? result.json : undefined;

  if (!result.ok) {
    const targetPath = payload && typeof payload.targetPath === "string" ? payload.targetPath : base.targetPath;
    const targetDir = payload && typeof payload.targetDir === "string" ? payload.targetDir : path.dirname(targetPath);
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : payload && typeof payload.message === "string"
          ? payload.message
          : result.error ?? (result.stderr.trim() || `htmlslide setup exited with ${result.exitCode}.`);

    return {
      ...base,
      available: true,
      cliPath: cliRuntime.cliPath,
      mode: cliRuntime.mode,
      status: "failed",
      message,
      suggestedFix:
        payload && typeof payload.suggestedFix === "string"
          ? payload.suggestedFix
          : "Review CLI integration details or copy the manual install command.",
      targetDir,
      targetPath
    };
  }

  if (!payload) {
    return {
      ...base,
      available: true,
      cliPath: cliRuntime.cliPath,
      mode: cliRuntime.mode,
      status: "failed",
      message: result.error ?? (result.stderr.trim() || `htmlslide setup exited with ${result.exitCode}.`),
      suggestedFix: "Review CLI integration details or copy the manual install command."
    };
  }

  const status = normalizeCliIntegrationStatus(payload.status);
  const action = normalizeCliIntegrationAction(payload.action);
  const targetPath = typeof payload.targetPath === "string" ? payload.targetPath : base.targetPath;
  const targetDir = typeof payload.targetDir === "string" ? payload.targetDir : base.targetDir;
  const htmlslideHomeDir = typeof payload.htmlslideHomeDir === "string" ? payload.htmlslideHomeDir : base.htmlslideHomeDir;

  return {
    ...base,
    action,
    appPath,
    available: true,
    cliPath: cliRuntime.cliPath,
    htmlslideHomeDir,
    installed: payload.installed === true || action === "installed" || action === "updated",
    managed: payload.managed === true || action === "installed" || action === "updated",
    message: typeof payload.message === "string" ? payload.message : base.message,
    mode: cliRuntime.mode,
    onPath: payload.onPath === true,
    status,
    suggestedFix: typeof payload.suggestedFix === "string" ? payload.suggestedFix : undefined,
    targetDir,
    targetPath
  };
}

function normalizeCliIntegrationStatus(value: unknown): DesktopCliIntegrationState["status"] {
  return value === "passed" || value === "info" || value === "warning" || value === "failed" ? value : "failed";
}

function normalizeCliIntegrationAction(value: unknown): DesktopCliIntegrationState["action"] {
  return value === "installed" || value === "updated" || value === "removed" || value === "unchanged" ? value : undefined;
}

export function createDesktopCredentialStore(platform: NodeJS.Platform = process.platform): DesktopCredentialStore {
  if (platform !== "darwin") {
    return {
      available: false,
      label: "macOS Keychain",
      async getPassword() {
        return undefined;
      },
      async setPassword() {
        throw new Error("macOS Keychain is not available on this platform.");
      },
      async deletePassword() {
        return undefined;
      }
    };
  }

  return {
    available: true,
    label: "macOS Keychain",
    async getPassword(service, account) {
      const result = await runSecurityCommand(["find-generic-password", "-s", service, "-a", account, "-w"]);
      return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : undefined;
    },
    async setPassword(service, account, password) {
      const result = await runSecurityCommand([
        "add-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
        password,
        "-U"
      ]);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Failed to store API key in macOS Keychain.");
      }
    },
    async deletePassword(service, account) {
      const result = await runSecurityCommand(["delete-generic-password", "-s", service, "-a", account]);
      if (result.exitCode !== 0 && !isKeychainNotFound(result.stderr)) {
        throw new Error(result.stderr || "Failed to delete API key from macOS Keychain.");
      }
    }
  };
}

async function runDesktopAgentCliStep(
  args: string[],
  cliRuntime: CliRuntime | undefined,
  cliRunner: DesktopCliRunner
): Promise<CliRunResult> {
  if (!cliRuntime) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide."
    };
  }

  return cliRunner(args, {
    cliPath: cliRuntime.cliPath,
    cwd: cliRuntime.cwd,
    rootPath: cliRuntime.rootPath
  });
}

function desktopAgentCliLog(runId: string, stage: "check" | "export", result: CliRunResult): AgentRunLog {
  return {
    runId,
    stage,
    level: result.ok ? "info" : "error",
    message: result.ok
      ? `htmlslide ${stage} completed with exit code ${result.exitCode}.`
      : `htmlslide ${stage} failed with exit code ${result.exitCode}.`,
    createdAt: new Date().toISOString(),
    metadata: {
      exitCode: result.exitCode
    }
  };
}

type DesktopAgentEventRecorder = ReturnType<typeof createDesktopAgentEventRecorder>;
type DesktopAgentLogRecorder = ReturnType<typeof createDesktopAgentLogRecorder>;

function createDesktopAgentEventRecorder(events: AgentRunEvent[], runId: string) {
  return (
    stage: AgentRunStage,
    status: AgentRunStatus,
    summary: string,
    type: AgentRunEvent["type"],
    fields: Partial<Pick<AgentRunEvent, "checkpointId" | "filesChanged" | "issuesFound" | "nextAction" | "metadata">> = {}
  ): void => {
    events.push({
      createdAt: new Date().toISOString(),
      runId,
      sequence: events.length + 1,
      stage,
      status,
      summary,
      type,
      ...fields
    });
  };
}

function createDesktopAgentLogRecorder(logs: AgentRunLog[], runId: string) {
  return (
    level: AgentRunLog["level"],
    message: string,
    stage?: AgentRunStage,
    metadata?: AgentRunLog["metadata"]
  ): void => {
    logs.push({
      createdAt: new Date().toISOString(),
      level,
      message: sanitizeDesktopAgentText(message),
      runId,
      stage,
      metadata
    });
  };
}

function sanitizeDesktopAgentText(value: string): string {
  return sanitizeProviderText(value);
}

function sanitizeAgentAdapterRunResult(adapter: AgentAdapterRunResult): AgentAdapterRunResult {
  if (adapter.ok) {
    return {
      ...adapter,
      stderr: sanitizeDesktopAgentText(adapter.stderr),
      stdout: sanitizeDesktopAgentText(adapter.stdout)
    };
  }

  return {
    ...adapter,
    failure: {
      ...adapter.failure,
      detail: adapter.failure.detail === undefined ? undefined : sanitizeDesktopAgentText(adapter.failure.detail),
      message: sanitizeDesktopAgentText(adapter.failure.message)
    },
    stderr: adapter.stderr === undefined ? undefined : sanitizeDesktopAgentText(adapter.stderr),
    stdout: adapter.stdout === undefined ? undefined : sanitizeDesktopAgentText(adapter.stdout)
  };
}

function externalAgentFailureResult({
  addEvent,
  addLog,
  error,
  events,
  logs,
  projectPath,
  runId,
  stage
}: {
  addEvent: DesktopAgentEventRecorder;
  addLog: DesktopAgentLogRecorder;
  error: string;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  projectPath: string;
  runId: string;
  stage: AgentRunStage;
}): DesktopExternalAgentRunResult {
  addEvent(stage, "failed", error, "stage-failed", {
    nextAction: "Update AI Engines settings and retry."
  });
  addLog("error", error, stage);

  return {
    ok: false,
    providerId: "external-generic",
    projectPath,
    stages: summarizeAgentStages(events),
    events,
    logs,
    error,
    summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
  };
}

function byokAgentFailureResult({
  addEvent,
  addLog,
  error,
  events,
  logs,
  projectPath,
  runId,
  settings,
  stage
}: {
  addEvent: DesktopAgentEventRecorder;
  addLog: DesktopAgentLogRecorder;
  error: string;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  projectPath: string;
  runId: string;
  settings: {
    baseUrl?: string;
    provider: DesktopApiKeyProvider;
    model: string;
  };
  stage: AgentRunStage;
}): DesktopByokAgentRunResult {
  addEvent(stage, "failed", error, "stage-failed", {
    metadata: byokSettingsMetadata(settings),
    nextAction: "Update AI Engines settings and retry."
  });
  addLog("error", error, stage, byokSettingsMetadata(settings));

  return {
    ok: false,
    providerId: "htmlslide-byok",
    projectPath,
    settings,
    stages: summarizeAgentStages(events),
    events,
    logs,
    error,
    summary: summarizeDesktopByokFailureRun(runId, events, settings)
  };
}

function byokSettingsMetadata(settings: {
  baseUrl?: string;
  provider: DesktopApiKeyProvider;
  model: string;
}): Record<string, string> {
  return settings.baseUrl
    ? {
        baseUrl: settings.baseUrl,
        model: settings.model,
        provider: settings.provider
      }
    : {
        model: settings.model,
        provider: settings.provider
      };
}

function createDesktopByokModelProvider({
  apiKey,
  baseUrl,
  fetch,
  model,
  provider
}: {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  model: string;
  provider: DesktopApiKeyProvider;
}): ModelProvider {
  if (provider === "anthropic") {
    return createAnthropicProvider({
      apiKey,
      fetch,
      id: "htmlslide-byok",
      label: `HTMLslide Agent (${providerLabel(provider)} / ${model})`,
      model
    });
  }

  if (provider === "compatible" && !baseUrl) {
    throw new Error("OpenAI-compatible BYOK provider requires a base URL in AI Engines settings.");
  }

  return createOpenAICompatibleProvider({
    apiKey,
    baseUrl,
    fetch,
    id: "htmlslide-byok",
    label: `HTMLslide Agent (${providerLabel(provider)} / ${model})`,
    model
  });
}

async function applyByokAgentSourceWrites({
  projectPath,
  result
}: {
  projectPath: string;
  result: AgentRunResult;
}): Promise<DesktopByokAgentAppliedResult> {
  if (!result.ok || result.status !== "succeeded") {
    throw new Error("Cannot apply BYOK source writes from a non-successful agent run.");
  }

  if (!result.outputs.build?.sourceWrites) {
    throw new Error("HTMLslide Agent provider did not return build sourceWrites.");
  }

  const batches: Array<{
    stage: Extract<AgentRunStage, "build" | "repair">;
    attempt?: number;
    writes: AgentSourceWrite[];
  }> = [
    {
      stage: "build",
      writes: normalizeAgentSourceWrites(result.outputs.build.sourceWrites)
    }
  ];

  for (const repair of result.outputs.repairs) {
    if (!repair.sourceWrites) {
      throw new Error(`HTMLslide Agent provider did not return sourceWrites for repair attempt ${repair.attempt}.`);
    }
    batches.push({
      attempt: repair.attempt,
      stage: "repair",
      writes: normalizeAgentSourceWrites(repair.sourceWrites)
    });
  }

  const stageResults: DesktopByokAgentAppliedResult["stages"] = [];
  for (const batch of batches) {
    const applied = await applyAgentSourceWrites({
      projectPath,
      writes: batch.writes
    });
    const stageResult: DesktopByokAgentAppliedResult["stages"][number] = {
      filesChanged: applied.filesChanged,
      stage: batch.stage,
      writeCount: applied.writes.length
    };
    if (batch.attempt !== undefined) {
      stageResult.attempt = batch.attempt;
    }
    stageResults.push(stageResult);
  }

  return {
    projectPath: path.resolve(projectPath),
    source: "provider-source-writes",
    filesChanged: uniqueStrings(stageResults.flatMap((stage) => stage.filesChanged)),
    stages: stageResults,
    writeCount: stageResults.reduce((total, stage) => total + stage.writeCount, 0)
  };
}

async function writeDesktopAgentRunReport({
  agent,
  applied,
  check,
  checkpointDiff,
  exportResult,
  projectPath,
  providerId,
  stages
}: {
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult | DesktopByokAgentAppliedResult;
  check?: CliRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportResult?: CliRunResult;
  projectPath: string;
  providerId: DesktopAgentRunReport["providerId"];
  stages: DesktopMockAgentStageSummary[];
}): Promise<string> {
  const reportsPath = path.join(projectPath, ".htmlslide", "reports");
  await fs.mkdir(reportsPath, { recursive: true });

  const report = createDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId,
    stages
  });
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = path.join(reportsPath, `agent-run-${safeAgentRunReportId(agent.runId)}.json`);
  await Promise.all([
    fs.writeFile(reportPath, payload, "utf8"),
    fs.writeFile(path.join(reportsPath, "latest-agent-run.json"), payload, "utf8")
  ]);

  return reportPath;
}

function createDesktopAgentRunReport({
  agent,
  applied,
  check,
  checkpointDiff,
  exportResult,
  projectPath,
  providerId,
  stages
}: {
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult | DesktopByokAgentAppliedResult;
  check?: CliRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportResult?: CliRunResult;
  projectPath: string;
  providerId: DesktopAgentRunReport["providerId"];
  stages: DesktopMockAgentStageSummary[];
}): DesktopAgentRunReport {
  const report: DesktopAgentRunReport = {
    schemaVersion: "0.1.0",
    kind: "htmlslide-agent-run-report",
    runId: agent.runId,
    providerId,
    projectPath: path.resolve(projectPath),
    generatedAt: new Date().toISOString(),
    ok: agent.ok,
    status: agent.status,
    stages,
    outputs: sanitizeAgentOutputsForReport(agent.outputs),
    cli: {}
  };

  const appliedSummary = summarizeAppliedAgentRunForReport(applied);
  if (appliedSummary) {
    report.applied = appliedSummary;
  }

  if (agent.checkpoint) {
    const checkpoint: NonNullable<DesktopAgentRunReport["checkpoint"]> = {
      id: agent.checkpoint.id,
      strategy: agent.checkpoint.strategy,
      canRevert: agent.checkpoint.restore.canRevert
    };
    if (agent.checkpoint.manifestPath) {
      checkpoint.manifestPath = agent.checkpoint.manifestPath;
    }
    report.checkpoint = checkpoint;
  }

  if (checkpointDiff) {
    report.checkpointDiff = {
      summary: checkpointDiff.summary,
      changedPaths: checkpointDiff.changed.map((file) => file.path),
      addedPaths: checkpointDiff.added.map((file) => file.path),
      deletedPaths: checkpointDiff.deleted.map((file) => file.path)
    };
  }

  const checkSummary = summarizeCliRunForAgentReport(check);
  if (checkSummary) {
    report.cli.check = checkSummary;
  }

  const exportSummary = summarizeCliRunForAgentReport(exportResult);
  if (exportSummary) {
    report.cli.export = exportSummary;
  }

  return report;
}

function sanitizeAgentOutputsForReport(outputs: AgentRunResult["outputs"]): DesktopAgentRunReport["outputs"] {
  const reportOutputs: DesktopAgentRunReport["outputs"] = {
    checks: outputs.checks,
    repairs: outputs.repairs.map((repair) => ({
      attempt: repair.attempt,
      filesChanged: repair.filesChanged,
      issuesAddressed: repair.issuesAddressed,
      sourceWriteCount: repair.sourceWrites?.length ?? 0,
      sourceWritePaths: sourceWritePathsForReport(repair.sourceWrites)
    }))
  };

  if (outputs.brief) {
    reportOutputs.brief = outputs.brief;
  }
  if (outputs.outline) {
    reportOutputs.outline = outputs.outline;
  }
  if (outputs.visualDirection) {
    reportOutputs.visualDirection = outputs.visualDirection;
  }
  if (outputs.selectedVisualDirectionId) {
    reportOutputs.selectedVisualDirectionId = outputs.selectedVisualDirectionId;
  }
  if (outputs.build) {
    reportOutputs.build = {
      filesChanged: outputs.build.filesChanged,
      slidesChanged: outputs.build.slidesChanged,
      notesChanged: outputs.build.notesChanged,
      themeChanged: outputs.build.themeChanged,
      sourceWriteCount: outputs.build.sourceWrites?.length ?? 0,
      sourceWritePaths: sourceWritePathsForReport(outputs.build.sourceWrites)
    };
  }
  if (outputs.export) {
    reportOutputs.export = outputs.export;
  }
  if (outputs.review) {
    reportOutputs.review = outputs.review;
  }

  return reportOutputs;
}

function summarizeAppliedAgentRunForReport(
  applied: ApplyMockAgentProjectResult | DesktopByokAgentAppliedResult | undefined
): DesktopAgentRunReport["applied"] | undefined {
  if (!applied) {
    return undefined;
  }

  if ("source" in applied) {
    return {
      source: applied.source,
      filesChanged: applied.filesChanged,
      writeCount: applied.writeCount,
      stages: applied.stages
    };
  }

  const summary: NonNullable<DesktopAgentRunReport["applied"]> = {
    source: "mock-project-writer",
    filesChanged: applied.filesChanged,
    slideIds: applied.slideIds
  };
  if (applied.selectedVisualDirectionId) {
    summary.selectedVisualDirectionId = applied.selectedVisualDirectionId;
  }
  return summary;
}

function summarizeCliRunForAgentReport(result: CliRunResult | undefined): DesktopAgentRunReportCliResult | undefined {
  if (!result) {
    return undefined;
  }

  const json = asRecord(result.json);
  const summary: DesktopAgentRunReportCliResult = {
    ok: result.ok,
    exitCode: result.exitCode,
    artifactPaths: collectExportArtifacts(json)
  };
  if (typeof json?.status === "string") {
    summary.status = json.status;
  }
  if (json && Object.prototype.hasOwnProperty.call(json, "summary")) {
    summary.summary = json.summary;
  }
  return summary;
}

function sourceWritePathsForReport(writes: readonly AgentSourceWrite[] | undefined): string[] {
  return writes?.map((write) => write.path) ?? [];
}

function safeAgentRunReportId(runId: string): string {
  const safeId = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return safeId.length > 0 && safeId !== "." && safeId !== ".." ? safeId : "run";
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }

  return unique;
}

function providerLabel(provider: DesktopApiKeyProvider): string {
  if (provider === "anthropic") {
    return "Anthropic";
  }

  if (provider === "compatible") {
    return "OpenAI-compatible";
  }

  return "OpenAI";
}

function externalAgentPrompt({
  brief,
  projectPath,
  writeManifest
}: {
  brief: string;
  projectPath: string;
  writeManifest: string;
}): string {
  return [
    "# HTMLslide External Agent Task",
    "",
    `Project root: ${projectPath}`,
    "",
    "## User request",
    brief,
    "",
    "## Required boundaries",
    "- Edit only deck source files: deck.json, slides/, notes/, theme/, or assets/.",
    "- Do not edit exports/ or .htmlslide/ except for the write manifest below.",
    "- Keep slide content as fixed 16:9 HTML fragments; do not add responsive reflow.",
    "- Preserve project-relative paths in deck.json.",
    "",
    "## Write manifest",
    `After editing, write JSON to: ${writeManifest}`,
    "",
    "Use either of these shapes:",
    "",
    "```json",
    "{ \"writes\": [\"slides/001-title.html\", \"notes/001-title.md\"] }",
    "```",
    "",
    "or:",
    "",
    "```json",
    "[\"slides/001-title.html\", \"notes/001-title.md\"]",
    "```",
    ""
  ].join("\n");
}

function normalizeExternalAgentRunId(runId: string | undefined): string {
  return normalizeDesktopAgentRunId(runId, "external");
}

function normalizeDesktopAgentRunId(runId: string | undefined, fallbackPrefix = "run"): string {
  const fallback = `${fallbackPrefix}-${Date.now().toString(36)}`;
  const raw = typeof runId === "string" && runId.trim().length > 0 ? runId.trim() : fallback;
  const normalized = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return normalized.length > 0 && normalized !== "." && normalized !== ".." ? normalized : fallback;
}

function projectRelativeSourcePath(projectPath: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(projectPath), path.resolve(filePath)).split(path.sep).join(path.posix.sep);
  if (relativePath.length === 0 || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`Reported write is outside the project: ${filePath}`);
  }
  return relativePath;
}

function checkIssueCount(check: CliRunResult): number {
  const summary = asRecord(asRecord(check.json)?.summary);
  return (
    (numberFromRecord(summary, "errors") ?? 0) +
    (numberFromRecord(summary, "warnings") ?? 0) +
    (numberFromRecord(summary, "info") ?? 0) +
    (numberFromRecord(summary, "suggestions") ?? 0)
  );
}

function summarizeAgentStages(events: readonly AgentRunEvent[]): DesktopMockAgentStageSummary[] {
  return defaultAgentStages.map((stage) => {
    const stageEvents = events.filter((event) => event.stage === stage);
    const terminalEvent = lastMatchingEvent(
      stageEvents,
      (event) => event.type === "stage-failed" || event.type === "stage-completed"
    );
    const lastEvent = terminalEvent ?? stageEvents.at(-1);
    return {
      stage,
      status: lastEvent?.status ?? "queued",
      summary: lastEvent?.summary ?? `${stage} queued.`,
      updatedAt: lastEvent?.createdAt
    };
  });
}

function lastMatchingEvent(
  events: readonly AgentRunEvent[],
  predicate: (event: AgentRunEvent) => boolean
): AgentRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) {
      return event;
    }
  }
  return undefined;
}

function summarizeDesktopMockAgentRun(
  agent: AgentRunResult,
  check: CliRunResult | undefined,
  exportResult: CliRunResult | undefined
): DesktopMockAgentRunSummary {
  const stages = summarizeAgentStages(agent.events);
  const checkJson = asRecord(check?.json);
  const checkSummary = asRecord(checkJson?.summary);
  const exportJson = asRecord(exportResult?.json);

  return {
    runId: agent.runId,
    status: agent.status,
    stageCount: stages.length,
    completedStages: stages.filter((stage) => stage.status === "succeeded").length,
    failedStages: stages.filter((stage) => stage.status === "failed").length,
    checkStatus: typeof checkJson?.status === "string" ? checkJson.status : undefined,
    checkErrors: numberFromRecord(checkSummary, "errors"),
    checkWarnings: numberFromRecord(checkSummary, "warnings"),
    exportStatus: typeof exportJson?.status === "string" ? exportJson.status : undefined,
    exportArtifacts: collectExportArtifacts(exportJson)
  };
}

function summarizeDesktopByokAgentRun(
  agent: AgentRunResult,
  check: CliRunResult | undefined,
  exportResult: CliRunResult | undefined,
  settings: {
    baseUrl?: string;
    provider: DesktopApiKeyProvider;
    model: string;
  }
): DesktopByokAgentRunSummary {
  return {
    ...summarizeDesktopMockAgentRun(agent, check, exportResult),
    baseUrl: settings.baseUrl,
    model: settings.model,
    provider: settings.provider
  };
}

function summarizeDesktopByokFailureRun(
  runId: string,
  events: readonly AgentRunEvent[],
  settings: {
    baseUrl?: string;
    provider: DesktopApiKeyProvider;
    model: string;
  }
): DesktopByokAgentRunSummary {
  const stages = summarizeAgentStages(events);
  const status = events.some((event) => event.status === "cancelled")
    ? "cancelled"
    : "failed";

  return {
    runId,
    status,
    stageCount: stages.length,
    completedStages: stages.filter((stage) => stage.status === "succeeded").length,
    failedStages: stages.filter((stage) => stage.status === "failed").length,
    exportArtifacts: [],
    baseUrl: settings.baseUrl,
    model: settings.model,
    provider: settings.provider
  };
}

function summarizeDesktopExternalAgentRun(
  runId: string,
  events: readonly AgentRunEvent[],
  check: CliRunResult | undefined,
  exportResult: CliRunResult | undefined,
  filesChanged: string[]
): DesktopExternalAgentRunSummary {
  const stages = summarizeAgentStages(events);
  const checkJson = asRecord(check?.json);
  const checkSummary = asRecord(checkJson?.summary);
  const exportJson = asRecord(exportResult?.json);
  const status = events.some((event) => event.status === "cancelled")
    ? "cancelled"
    : stages.some((stage) => stage.status === "failed")
      ? "failed"
      : "succeeded";

  return {
    runId,
    status,
    stageCount: stages.length,
    completedStages: stages.filter((stage) => stage.status === "succeeded").length,
    failedStages: stages.filter((stage) => stage.status === "failed").length,
    checkStatus: typeof checkJson?.status === "string" ? checkJson.status : undefined,
    checkErrors: numberFromRecord(checkSummary, "errors"),
    checkWarnings: numberFromRecord(checkSummary, "warnings"),
    exportStatus: typeof exportJson?.status === "string" ? exportJson.status : undefined,
    exportArtifacts: collectExportArtifacts(exportJson),
    filesChanged
  };
}

function collectExportArtifacts(value: Record<string, unknown> | undefined): string[] {
  const artifacts = asRecord(value?.artifacts);
  if (!artifacts) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of Object.values(artifacts)) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string") {
          paths.push(item);
        }
      }
    }
  }
  return paths;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function numberFromRecord(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function firstNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function isProjectRecord(value: unknown): value is DesktopProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<DesktopProjectRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.path === "string" &&
    typeof record.lastOpenedAt === "string" &&
    typeof record.slideCount === "number" &&
    typeof record.status === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
