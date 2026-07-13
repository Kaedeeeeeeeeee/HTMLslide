import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_HEADLESS_CONTRACT_ARGS,
  CLAUDE_HEADLESS_CONTRACT_FLAGS,
  CODEX_HEADLESS_CONTRACT_ARGS,
  CODEX_HEADLESS_CONTRACT_FLAGS,
  runBuiltInExternalAgentAdapter,
  createCapabilitySet,
  readJsonFileWriteManifest,
  runCommand,
  runGenericAgentAdapter,
  type AgentAdapterRunResult,
  type BuiltInExternalAgentKind,
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
  sanitizeProviderText,
  startAgentRun,
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
  type JsonObject,
  type JsonValue,
  type ModelProvider,
  type VisualDirection
} from "@htmlslide/agent";
import { buildSlidePreviewDocument } from "@htmlslide/compiler";
import {
  ExportManifestSchema,
  MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
  MAX_SOURCE_MATERIAL_COUNT,
  addQaIgnoreRule,
  isSpeakerNotesMode,
  loadDeckProject,
  normalizeSpeakerNotesMode,
  normalizeDeckExportOptions,
  parseDeck,
  parseDeckExportOptions,
  resolveProjectRelativePathInsideRealProject,
  stageSourceMaterials,
  writeDeckExportOptions as writeCoreDeckExportOptions,
  type SourceMaterialInput,
  type SourceMaterialRecord,
  type Deck,
  type DeckExportOptions,
  type LoadedDeckProject,
  type SpeakerNotesMode
} from "@htmlslide/core";
import { AGENT_RUN_REPORT_SCHEMA_VERSION } from "@htmlslide/core/version";
import {
  DeckPackageValidationError,
  readDeckPackage,
  type PresenterDeckPackage
} from "@htmlslide/presenter";
import {
  DEFAULT_NOTES_FONT_SIZE_PX,
  MAX_NOTES_FONT_SIZE_PX,
  MIN_NOTES_FONT_SIZE_PX,
  type PresenterDeck
} from "@htmlslide/presenter/session";
import {
  inspectInstalledSkill,
  installSkill,
  OFFICIAL_SKILLS,
  removeSkill,
  SkillStoreError,
  type SkillStoreIntegrity,
  type SkillInstallResult,
  validateOfficialSkillRegistry
} from "@htmlslide/skills";

export type DesktopProjectStatus =
  | "Ready"
  | "Needs check"
  | "Export failed"
  | "Missing files"
  | "External changes detected";

export type DesktopExportOptions = {
  deckpkg: boolean;
  html: boolean;
  pdf: boolean;
  thumbnails: boolean;
};

export type DesktopProjectRecord = {
  id: string;
  title: string;
  path: string;
  lastOpenedAt: string;
  status: DesktopProjectStatus;
  slideCount: number;
  speakerNotesMode?: SpeakerNotesMode;
  thumbnail?: string;
};

export type DesktopProjectReference = {
  id?: string;
  path?: string;
};

export type DesktopPresenterDisplayPreference = {
  id: number;
  label: string;
  internal: boolean;
};

export type DesktopPresenterPreferences = {
  projectId: string;
  projectPath: string;
  recentSlideId?: string;
  notesFontSizePx: number;
  selectedDisplay?: DesktopPresenterDisplayPreference;
};

export type DesktopLibrary = {
  version: 1;
  defaultWorkspace: string;
  onboardingCompleted: boolean;
  recentProjects: DesktopProjectRecord[];
  presenterPreferences: DesktopPresenterPreferences[];
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
  speakerNotesMode?: SpeakerNotesMode;
};

export type DesktopProjectPreview = {
  exportOptions: DesktopExportOptions;
  project: DesktopProjectRecord;
  slides: DesktopSlidePreview[];
  speakerNotesMode?: SpeakerNotesMode;
};

export type DesktopSlidePreviewDocument = Awaited<ReturnType<typeof buildSlidePreviewDocument>>;

export type DesktopCreateProjectRequest = {
  exportOptions?: DeckExportOptions;
  speakerNotesMode?: SpeakerNotesMode;
  title: string;
  folderName: string;
  templateId?: string;
  workspacePath?: string;
  sources?: DesktopNewDeckSource[];
};

export type DesktopNewDeckSource =
  | { kind: "file"; name: string; path: string; size?: number }
  | { kind: "text"; name: string; content: string };

export type DesktopSourceFileSelection = {
  kind: "file";
  name: string;
  path: string;
  size: number;
};

export type DesktopResolvedCreateProjectRequest = {
  title: string;
  folderName: string;
  templateId: string;
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
  signal?: AbortSignal;
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
  action?: "installed" | "updated" | "removed" | "unchanged";
  htmlslideHomeDir: string;
  skillsDir: string;
  skillCount: number;
  installedCount: number;
  missing: string[];
  stale: string[];
  names: string[];
  skills: DesktopOfficialSkillSummary[];
  message: string;
  suggestedFix?: string;
  updatedAt: string;
};

export type DesktopOfficialSkillSummary = {
  name: string;
  version: string;
  author: string;
  description: string;
  entrypoint: string;
  supportedDeckSchema: string[];
  installTargets: string[];
  type: string;
  output: string;
  viewport: string;
  supports: string[];
  riskLevel: string;
  risk: {
    scripts: boolean;
    network: boolean;
    remoteAssets: boolean;
    writesExports: boolean;
    writesSecrets: boolean;
    modifiesSource: boolean;
  };
  license: string;
  installPath: string;
  markdownPreview: string;
  installed: boolean;
  stale: boolean;
  status: "installed" | "missing" | "stale";
  integrity: SkillStoreIntegrity | "missing";
  removeEnabled: boolean;
  removeDisabledReason?: string;
};

export type DesktopOfficialSkillsOptions = {
  env?: NodeJS.ProcessEnv;
  now?: string;
};

export type DesktopOfficialSkillRemoveRequest = {
  name: string;
  confirmed?: boolean;
};

export type DesktopMockAgentRunRequest = {
  exportOptions?: DesktopExportOptions;
  projectPath: string;
  brief: string;
  targetSlideCount?: number;
  runExport?: boolean;
  maxRepairRounds?: number;
  runId?: string;
  speakerNotesMode?: SpeakerNotesMode;
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
  schemaVersion: typeof AGENT_RUN_REPORT_SCHEMA_VERSION;
  kind: "htmlslide-agent-run-report";
  runId: string;
  providerId: "htmlslide-mock" | "htmlslide-byok";
  provider?: {
    provider: DesktopApiKeyProvider;
    model: string;
    baseUrlSha256?: string;
  };
  targetSlideCount?: number;
  projectPath: string;
  generatedAt: string;
  ok: boolean;
  status: AgentRunResult["status"];
  stages: DesktopMockAgentStageSummary[];
  outputs: {
    speakerNotesMode?: SpeakerNotesMode;
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
  exportManifest?: {
    sourceDigest: string;
    artifactCount: number;
    sha256: string;
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
  exportOptions?: DesktopExportOptions;
  projectPath: string;
  brief: string;
  runExport?: boolean;
  runId?: string;
  speakerNotesMode?: SpeakerNotesMode;
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
  providerId: "external-agent";
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
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  onLog?: (log: AgentRunLog) => void | Promise<void>;
  chooseVisualDirection?: (directions: VisualDirection[]) => Promise<string> | string;
};

export type DesktopByokAgentProviderFactory = (input: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider: DesktopApiKeyProvider;
}) => ModelProvider;

export type DesktopByokAgentRunnerOptions = DesktopMockAgentRunnerOptions & {
  credentialAccessTimeoutMs?: number;
  credentialStore?: DesktopCredentialStore;
  credentialValidationTimeoutMs?: number;
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
  externalAgentStatuses?: DesktopExternalAgentStatus[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  onLog?: (log: AgentRunLog) => void | Promise<void>;
  chooseVisualDirection?: (directions: VisualDirection[]) => Promise<string> | string;
};

export type DesktopAiEngineMode = "no-ai" | "htmlslide-agent" | "external-agent";
export type DesktopApiKeyProvider = "openai" | "anthropic" | "compatible";
export type DesktopExternalAgentId = "claude-code" | "codex-cli" | "gemini-cli" | "generic";
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
  getPassword(
    service: string,
    account: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<string | undefined>;
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
  export?: unknown;
  speakerNotesMode?: unknown;
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
  onboardingCompleted: false,
  presenterPreferences: [],
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
    capabilities: {
      ...DEFAULT_AGENT_CAPABILITIES,
      cancelRun: true,
      headlessRun: true,
      readDiff: true,
      streamLogs: true
    },
    command: "claude",
    contractArgs: CLAUDE_HEADLESS_CONTRACT_ARGS,
    contractFlags: CLAUDE_HEADLESS_CONTRACT_FLAGS,
    id: "claude-code",
    kind: "claude-code",
    label: "Claude Code",
    versionArgs: ["--version"] as const
  },
  {
    authArgs: ["login", "status"] as const,
    capabilities: {
      ...DEFAULT_AGENT_CAPABILITIES,
      cancelRun: true,
      headlessRun: true,
      readDiff: true,
      streamLogs: true
    },
    command: "codex",
    contractArgs: CODEX_HEADLESS_CONTRACT_ARGS,
    contractFlags: CODEX_HEADLESS_CONTRACT_FLAGS,
    id: "codex-cli",
    kind: "codex-cli",
    label: "Codex CLI",
    versionArgs: ["--version"] as const
  },
  {
    authArgs: undefined,
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, detectAuthenticated: false },
    command: "gemini",
    contractArgs: undefined,
    contractFlags: undefined,
    id: "gemini-cli",
    kind: "gemini-cli",
    label: "Gemini CLI",
    manualAuthSummary: "Gemini CLI detected. Authentication depends on interactive sign-in, GEMINI_API_KEY, or Vertex AI environment, so validate it manually before release claims.",
    versionArgs: ["--version"] as const
  }
] satisfies Array<{
  authArgs?: readonly string[];
  capabilities?: Record<string, boolean>;
  command: string;
  contractArgs?: readonly string[];
  contractFlags?: readonly string[];
  id: DesktopExternalAgentId;
  kind: DesktopExternalAgentId;
  label: string;
  manualAuthSummary?: string;
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

  if (request.templateId !== undefined && typeof request.templateId !== "string") {
    throw new Error("Template id must be a string.");
  }

  if (request.speakerNotesMode !== undefined) {
    normalizeSpeakerNotesMode(request.speakerNotesMode);
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
    templateId: request.templateId?.trim() || "default",
    title,
    workspacePath
  };
}

export async function inspectDesktopSourceFiles(filePaths: readonly string[]): Promise<DesktopSourceFileSelection[]> {
  const uniquePaths = [...new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))];
  if (uniquePaths.length > MAX_SOURCE_MATERIAL_COUNT) {
    throw new Error(`Choose no more than ${MAX_SOURCE_MATERIAL_COUNT} source files at a time.`);
  }

  const selections = await Promise.all(uniquePaths.map(async (filePath) => {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`Source file must be an absolute local path: ${filePath}`);
    }
    const fileInfo = await fs.lstat(filePath);
    if (fileInfo.isSymbolicLink()) {
      throw new Error(`Source file symlinks are not allowed: ${path.basename(filePath)}`);
    }
    if (!fileInfo.isFile()) {
      throw new Error(`Source must be a regular file: ${path.basename(filePath)}`);
    }
    if (fileInfo.size > MAX_SOURCE_MATERIAL_BYTES_PER_FILE) {
      throw new Error(`Source file exceeds the 25 MiB limit: ${path.basename(filePath)}`);
    }
    if (isSecretLikeSourceName(path.basename(filePath))) {
      throw new Error(`Secret-like files cannot be added as source material: ${path.basename(filePath)}`);
    }
    return {
      kind: "file" as const,
      name: path.basename(filePath),
      path: filePath,
      size: fileInfo.size
    };
  }));

  return selections;
}

export async function stageDesktopNewDeckSources(
  projectPath: string,
  sources: readonly DesktopNewDeckSource[] = []
): Promise<SourceMaterialRecord[]> {
  const inputs: SourceMaterialInput[] = sources.map((source) => {
    if (source.kind === "file") {
      return {
        kind: "file",
        name: source.name,
        sourcePath: source.path
      };
    }
    return {
      content: source.content,
      kind: "text",
      name: source.name
    };
  });
  const result = await stageSourceMaterials(path.resolve(projectPath), inputs);
  return result.records;
}

function isSecretLikeSourceName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.includes("credential")
    || normalized.includes("secret")
    || normalized.includes("token")
    || normalized.endsWith(".pem")
    || normalized.endsWith(".key")
    || normalized === "id_rsa";
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
      onboardingCompleted: parsed.onboardingCompleted !== false,
      presenterPreferences: Array.isArray(parsed.presenterPreferences)
        ? parsed.presenterPreferences.map(normalizeStoredPresenterPreferences).filter(isPresent)
        : [],
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

export async function readDesktopPresenterPreferences(
  libraryPath: string,
  project: DesktopProjectReference,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopPresenterPreferences> {
  const reference = requirePresenterProjectReference(project);
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const stored = library.presenterPreferences.find((preferences) => matchesPresenterProject(preferences, reference));
  return stored
    ? { ...stored, projectId: reference.id, projectPath: reference.path }
    : defaultPresenterPreferences(reference);
}

export async function writeDesktopPresenterPreferences(
  libraryPath: string,
  project: DesktopProjectReference,
  preferences: unknown,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopPresenterPreferences> {
  const reference = requirePresenterProjectReference(project);
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextPreferences = normalizePresenterPreferences(preferences, reference);
  const nextLibrary: DesktopLibrary = {
    ...library,
    presenterPreferences: [
      nextPreferences,
      ...library.presenterPreferences.filter((item) => !matchesPresenterProject(item, reference))
    ]
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextPreferences;
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
          capabilities: spec.capabilities,
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
          capabilities: spec.capabilities,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          rawVersion: versionResult.result.stderr || versionResult.result.stdout,
          status: "unavailable",
          summary: `Version check exited with ${versionResult.result.exitCode}`
        });
      }

      const version = firstNonEmptyLine(versionResult.result.stdout) ?? firstNonEmptyLine(versionResult.result.stderr);

      if (!spec.authArgs) {
        return externalAgentStatus({
          checkedAt: now,
          capabilities: spec.capabilities,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          status: "unavailable",
          summary: spec.manualAuthSummary ?? "Authentication status must be validated manually.",
          version
        });
      }

      const authResult = await runDetectorSafely(runner, {
        args: spec.authArgs,
        command: spec.command,
        cwd,
        timeoutMs: 3_000
      });

      if (authResult.kind === "not-installed") {
        return externalAgentStatus({
          checkedAt: now,
          capabilities: spec.capabilities,
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
          capabilities: spec.capabilities,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          status: "not-authenticated",
          summary: authResult.result.stderr || authResult.result.stdout || "Authentication status is unavailable",
          version
        });
      }

      if (spec.contractArgs && spec.contractFlags) {
        const contractResult = await runDetectorSafely(runner, {
          args: spec.contractArgs,
          command: spec.command,
          cwd,
          timeoutMs: 3_000
        });
        const contractOutput = contractResult.kind === "result"
          ? `${contractResult.result.stdout}\n${contractResult.result.stderr}`
          : "";
        const missingFlags = spec.contractFlags.filter((flag) => !contractOutput.includes(flag));
        if (
          contractResult.kind !== "result" ||
          contractResult.result.exitCode !== 0 ||
          missingFlags.length > 0
        ) {
          return externalAgentStatus({
            authenticated: true,
            checkedAt: now,
            capabilities: {
              ...spec.capabilities,
              headlessRun: false,
              readDiff: false,
              streamLogs: false
            },
            command: spec.command,
            id: spec.id,
            installed: true,
            label: spec.label,
            status: "unavailable",
            summary: missingFlags.length > 0
              ? `Installed CLI is missing required headless flags: ${missingFlags.join(", ")}`
              : "Installed CLI headless contract could not be verified.",
            version
          });
        }
      }

      return externalAgentStatus({
        authenticated: true,
        checkedAt: now,
        capabilities: spec.capabilities,
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
      capabilities: { detectAuthenticated: false },
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
  const loadedProject = await loadDeckProject(root, { verifyFiles: false });
  const title = loadedProject.deck.title.length > 0
    ? loadedProject.deck.title
    : path.basename(root);
  const missingFiles = await hasMissingSlideFiles(loadedProject);

  return {
    id: `proj_${stableId(root)}`,
    title,
    path: root,
    lastOpenedAt: new Date().toISOString(),
    status: missingFiles ? "Missing files" : "Needs check",
    slideCount: loadedProject.slides.length,
    ...(isSpeakerNotesMode(loadedProject.deck.speakerNotesMode)
      ? { speakerNotesMode: loadedProject.deck.speakerNotesMode }
      : {})
  };
}

export async function loadProjectPreview(projectPath: string): Promise<DesktopProjectPreview> {
  const loadedProject = await loadDeckProject(path.resolve(projectPath));
  const project: DesktopProjectRecord = {
    id: `proj_${stableId(loadedProject.projectRoot)}`,
    title: loadedProject.deck.title,
    path: loadedProject.projectRoot,
    lastOpenedAt: new Date().toISOString(),
    status: "Needs check",
    slideCount: loadedProject.slides.length,
    ...(isSpeakerNotesMode(loadedProject.deck.speakerNotesMode)
      ? { speakerNotesMode: loadedProject.deck.speakerNotesMode }
      : {})
  };
  const slides = await Promise.all(
    loadedProject.slides.map(async ({ slide, sourcePath, notesPath }, index): Promise<DesktopSlidePreview> => {
      const html = await fs.readFile(sourcePath, "utf8");
      const notes = notesPath ? await fs.readFile(notesPath, "utf8") : "";

      return {
        id: slide.id,
        number: String(index + 1).padStart(2, "0"),
        title: slide.title,
        section: titleCase(slide.kind),
        status: slide.status === "ready" || slide.status === "final" ? "ready" : "needs-check",
        duration: formatDuration(slide.durationSec ?? 60),
        accent: DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length] ?? DEFAULT_ACCENT,
        speakerNotes: notes.trim(),
        bullets: extractBullets(html, slide.title),
        sourcePath: slide.source,
        ...(slide.notes ? { notesPath: slide.notes } : {}),
        ...(isSpeakerNotesMode(loadedProject.deck.speakerNotesMode)
          ? { speakerNotesMode: loadedProject.deck.speakerNotesMode }
          : {})
      };
    })
  );

  return {
    exportOptions: desktopExportOptionsFromManifest(loadedProject.deck.export),
    project,
    slides,
    ...(isSpeakerNotesMode(loadedProject.deck.speakerNotesMode)
      ? { speakerNotesMode: loadedProject.deck.speakerNotesMode }
      : {})
  };
}

export async function persistDesktopExportOptions(
  projectPath: string,
  options: Partial<DeckExportOptions>
): Promise<DeckExportOptions> {
  const root = path.resolve(projectPath);
  const manifest = await readDeckManifest(root);
  const nextOptions = parseDeckExportOptions({
    ...normalizeDeckExportOptions(manifest.export),
    ...options
  });
  const deck = await writeCoreDeckExportOptions(root, nextOptions);
  return deck.export;
}

export async function loadSlidePreview(
  projectPath: string,
  slideId: string
): Promise<DesktopSlidePreviewDocument> {
  return buildSlidePreviewDocument(projectPath, { slideId });
}

export type DesktopSaveSlideNotesResult = {
  projectPath: string;
  slideId: string;
  notesPath: string;
  bytes: number;
};

export async function saveDesktopSlideNotes(
  projectPath: string,
  slideId: string,
  content: string
): Promise<DesktopSaveSlideNotesResult> {
  const root = path.resolve(projectPath);
  const normalizedSlideId = slideId.trim();
  if (normalizedSlideId.length === 0) {
    throw new Error("Speaker notes require a slide id.");
  }
  if (typeof content !== "string") {
    throw new Error("Speaker notes must be text.");
  }

  const manifest = await readDeckManifest(root);
  const slide = manifest.slides?.find((candidate) => candidate.id === normalizedSlideId);
  const notesPath = typeof slide?.notes === "string" ? slide.notes.trim() : "";
  if (notesPath.length === 0) {
    throw new Error(`Slide ${normalizedSlideId} does not define a speaker notes path.`);
  }
  if (notesPath !== "notes" && !notesPath.startsWith("notes/")) {
    throw new Error(`Speaker notes must stay under notes/: ${notesPath}`);
  }

  const notesFilePath = await resolveProjectRelativePathInsideRealProject(root, notesPath);
  await fs.writeFile(notesFilePath, content, "utf8");
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    notesPath,
    projectPath: root,
    slideId: normalizedSlideId
  };
}

export async function addDesktopQaIgnoreRule(projectPath: string, issueType: string): Promise<{ issueTypes: string[] }> {
  const config = await addQaIgnoreRule(path.resolve(projectPath), issueType);
  return { issueTypes: config.issueTypes };
}

export async function loadDesktopPresenterDeck(
  projectPath: string,
  options: DesktopPresenterDeckOptions = {}
): Promise<DesktopPresenterDeckResult> {
  const root = path.resolve(projectPath);
  const cliRunner = options.cliRunner ?? runHtmlslideCli;
  const exportResult = await runDesktopAgentCliStep(
    ["export", root, "--no-pdf", "--no-html", "--deckpkg", "--no-thumbnails", "--json"],
    options.cliRuntime,
    cliRunner
  );

  if (exportResult && !exportResult.ok) {
    const issues = desktopPresenterIssuesFromCliResult(exportResult);
    return {
      ok: false,
      source: "invalid",
      origin: "project-export",
      projectPath: root,
      error: exportResult.error ?? firstNonEmptyLine(exportResult.stderr) ?? `Export exited with ${exportResult.exitCode}.`,
      ...(issues.length > 0 ? { issues } : {})
    };
  }

  const deckpkgPath = deckpkgPathFromExportResult(exportResult);
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

function desktopPresenterIssuesFromCliResult(result: CliRunResult): DesktopPresenterDeckIssue[] {
  const issues = asRecord(result.json)?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.flatMap((value) => {
    const issue = asRecord(value);
    if (!issue || typeof issue.type !== "string" || typeof issue.message !== "string") {
      return [];
    }

    return [{
      severity: typeof issue.severity === "string" ? issue.severity : "error",
      type: issue.type,
      message: issue.message,
      ...(typeof issue.path === "string" ? { path: issue.path } : {}),
      ...(typeof issue.slideId === "string" ? { slideId: issue.slideId } : {})
    }];
  });
}

export function normalizeDesktopExportOptions(value: unknown): DesktopExportOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Export options must be an object.");
  }

  const record = value as Record<string, unknown>;
  const options: DesktopExportOptions = {
    deckpkg: record.deckpkg === true,
    html: record.html === true,
    pdf: record.pdf === true,
    thumbnails: record.thumbnails === true
  };
  const invalidKeys = ["deckpkg", "html", "pdf", "thumbnails"].filter((key) => typeof record[key] !== "boolean");
  if (invalidKeys.length > 0) {
    throw new Error(`Export options must use boolean values: ${invalidKeys.join(", ")}.`);
  }
  return options;
}

export function exportOptionsToCliArgs(value?: unknown): string[] {
  const options = normalizeDesktopExportOptions(value);
  if (!options || Object.values(options).every(Boolean)) {
    return [];
  }

  return [
    options.pdf ? "--pdf" : "--no-pdf",
    options.html ? "--html" : "--no-html",
    options.deckpkg ? "--deckpkg" : "--no-deckpkg",
    options.thumbnails ? "--thumbnails" : "--no-thumbnails"
  ];
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

  if (options.signal?.aborted) {
    return cancelledDesktopCliResult(args, "", "", options.signal);
  }

  const result = await runCommand({
    command,
    args: commandArgs,
    cwd: options.cwd ?? options.rootPath ?? path.dirname(cliPath),
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...options.env
    },
    signal: options.signal,
    timeoutMs
  });

  if (result.cancelled) {
    return cancelledDesktopCliResult(args, result.stdout, result.stderr, options.signal);
  }
  if (result.timedOut) {
    return {
      ok: false,
      exitCode: 6,
      stdout: result.stdout,
      stderr: result.stderr,
      error: `htmlslide ${args.join(" ")} timed out after ${timeoutMs}ms.`
    };
  }
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parseJsonOutput(result.stdout)
  };
}

function cancelledDesktopCliResult(
  args: string[],
  stdout: string,
  stderr: string,
  signal?: AbortSignal
): CliRunResult {
  return {
    ok: false,
    exitCode: 6,
    stdout,
    stderr,
    error: `htmlslide ${args.join(" ")} cancelled: ${desktopAgentCancellationReason(signal)}`
  };
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
    skills: OFFICIAL_SKILLS.map((skill) => officialSkillSummary(htmlslideHomeDir, skill, "missing")),
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

function officialSkillRemovalReason(integrity: DesktopOfficialSkillSummary["integrity"]): string | undefined {
  if (integrity === "modified") {
    return "Remove unavailable: HTMLslide-managed files were modified.";
  }
  if (integrity === "unmanaged") {
    return "Remove unavailable: this skill is not managed by HTMLslide.";
  }
  if (integrity === "invalid") {
    return "Remove unavailable: this skill installation is invalid or unsafe.";
  }
  return undefined;
}

function officialSkillIntegrityFromError(error: unknown): DesktopOfficialSkillSummary["integrity"] {
  if (error instanceof SkillStoreError && error.code === "SKILL_TARGET_UNMANAGED") {
    return "unmanaged";
  }
  if (error instanceof SkillStoreError && error.code === "SKILL_TARGET_MODIFIED") {
    return "modified";
  }
  return "invalid";
}

function officialSkillSummary(
  htmlslideHomeDir: string,
  skill: (typeof OFFICIAL_SKILLS)[number],
  status: DesktopOfficialSkillSummary["status"],
  integrity: DesktopOfficialSkillSummary["integrity"] = "missing"
): DesktopOfficialSkillSummary {
  return {
    name: skill.metadata.name,
    version: skill.metadata.version,
    author: skill.metadata.author ?? "HTMLslide",
    description: skill.metadata.description,
    entrypoint: skill.metadata.entrypoint,
    supportedDeckSchema: [...skill.metadata.supportedDeckSchema],
    installTargets: [...skill.metadata.installTargets],
    type: skill.metadata.deck.type,
    output: skill.metadata.deck.output,
    viewport: skill.metadata.deck.viewport,
    supports: [...skill.metadata.deck.supports],
    riskLevel: skill.metadata.riskLevel,
    risk: {
      scripts: skill.metadata.deck.risk.scripts,
      network: skill.metadata.deck.risk.network,
      remoteAssets: skill.metadata.deck.risk.remoteAssets,
      writesExports: skill.metadata.deck.risk.writesExports,
      writesSecrets: skill.metadata.deck.risk.writesSecrets,
      modifiesSource: skill.metadata.deck.risk.modifiesSource
    },
    license: skill.metadata.license,
    installPath: officialSkillEntryPath(htmlslideHomeDir, skill.metadata.name),
    markdownPreview: skill.markdown.slice(0, 900).trim(),
    installed: status === "installed",
    integrity,
    removeEnabled: integrity === "verified",
    removeDisabledReason: officialSkillRemovalReason(integrity),
    stale: status === "stale",
    status
  };
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

  const target = { kind: "global" as const, htmlslideHomeDir: base.htmlslideHomeDir };
  const states = await Promise.all(OFFICIAL_SKILLS.map(async (skill) => {
    try {
      const [inspection] = await inspectInstalledSkill({ target, name: skill.metadata.name });
      if (!inspection) {
        return {
          name: skill.metadata.name,
          summary: officialSkillSummary(base.htmlslideHomeDir, skill, "missing"),
          status: "missing" as const
        };
      }
      const installed =
        inspection.managed === true &&
        inspection.integrity === "verified" &&
        inspection.markdown === skill.markdown;
      return {
        name: skill.metadata.name,
        summary: officialSkillSummary(
          base.htmlslideHomeDir,
          skill,
          installed ? "installed" : "stale",
          inspection.integrity
        ),
        status: installed ? ("installed" as const) : ("stale" as const)
      };
    } catch (error) {
      if (error instanceof SkillStoreError && error.code === "SKILL_NOT_FOUND") {
        return {
          name: skill.metadata.name,
          summary: officialSkillSummary(base.htmlslideHomeDir, skill, "missing"),
          status: "missing" as const
        };
      }
      const integrity = officialSkillIntegrityFromError(error);
      return {
        name: skill.metadata.name,
        summary: officialSkillSummary(base.htmlslideHomeDir, skill, "stale", integrity),
        status: "stale" as const
      };
    }
  }));

  const missing = states.filter((state) => state.status === "missing").map((state) => state.name).sort();
  const stale = states.filter((state) => state.status === "stale").map((state) => state.name).sort();
  const installedCount = states.filter((state) => state.status === "installed").length;
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
    skills: states.map((state) => state.summary),
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

  let results: SkillInstallResult[];
  try {
    results = [];
    for (const skill of OFFICIAL_SKILLS) {
      results.push(await installSkill({
        source: { kind: "official", name: skill.metadata.name },
        target: { kind: "global", htmlslideHomeDir: before.htmlslideHomeDir },
        adoptLegacyOfficial: true
      }));
    }
  } catch (error) {
    return {
      ...before,
      status: "failed",
      installed: false,
      message: error instanceof Error ? error.message : String(error),
      suggestedFix: `Check write permissions for ${before.skillsDir}.`
    };
  }

  const action: DesktopOfficialSkillsState["action"] = results.some((result) => result.action === "updated")
    ? "updated"
    : results.some((result) => result.action === "installed")
      ? "installed"
      : results.some((result) => result.action === "adopted")
        ? "updated"
        : "unchanged";

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

export async function removeDesktopOfficialSkill(
  request: DesktopOfficialSkillRemoveRequest,
  options: DesktopOfficialSkillsOptions = {}
): Promise<DesktopOfficialSkillsState> {
  if (request.confirmed !== true) {
    throw new Error("Official skill removal requires explicit confirmation.");
  }

  const before = await getDesktopOfficialSkills(options);
  if (!before.available) {
    return before;
  }
  const skill = before.skills.find((candidate) => candidate.name === request.name);
  if (!skill) {
    return {
      ...before,
      status: "failed",
      message: `Official skill is not in the registry: ${request.name}.`
    };
  }
  if (!skill.removeEnabled) {
    return {
      ...before,
      status: "failed",
      message: skill.removeDisabledReason ?? `Official skill cannot be removed: ${request.name}.`
    };
  }

  try {
    await removeSkill({
      name: request.name,
      target: { kind: "global", htmlslideHomeDir: before.htmlslideHomeDir }
    });
  } catch (error) {
    return {
      ...before,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      suggestedFix: `Check the integrity and permissions for ${before.skillsDir}.`
    };
  }

  const after = await getDesktopOfficialSkills({
    ...options,
    now: before.updatedAt
  });
  return {
    ...after,
    action: "removed",
    message: `${request.name} removed.`
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
  const events: AgentRunEvent[] = [];
  const logs: AgentRunLog[] = [];
  const cliRunner = options.cliRunner ?? runHtmlslideCli;
  const observerRunId = request.runId ?? "desktop-mock-pending";
  const observers = createDesktopAgentObserverDispatcher(options, observerRunId, events, logs);
  const addLog = createDesktopAgentLogRecorder(logs, observerRunId, observers);
  const controller = startAgentRun({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    maxRepairRounds: request.maxRepairRounds,
    projectRoot: projectPath,
    provider: createMockProvider(),
    runId: request.runId,
    speakerNotesMode: request.speakerNotesMode,
    targetSlideCount: request.targetSlideCount,
    metadata: {
      mode: "desktop-mock-agent"
    },
    chooseVisualDirection: options.chooseVisualDirection,
    createCheckpoint: createFileCopyCheckpoint
  }, {
    onEvent: observers.event,
    onLog: observers.log
  });
  const detachAbortSignal = bridgeDesktopAgentAbortSignal(options.signal, (reason) => controller.cancel(reason));
  let agent: AgentRunResult;
  try {
    agent = await controller.done;
  } finally {
    detachAbortSignal();
  }

  let applied: ApplyMockAgentProjectResult | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CliRunResult | undefined;
  let exportResult: CliRunResult | undefined;
  let project: DesktopProjectPreview | undefined;

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "build", observers, options.signal);
  }

  if (agent.ok) {
    notifyDesktopAgentEvent(observers, agent.runId, "build", "running", "Applying mock agent source files.", "stage-started", {
      nextAction: "Write generated deck source"
    });
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "build", observers, options.signal);
    }
  }

  if (agent.ok) {
    applied = await applyMockAgentProject({
      brief,
      projectPath,
      result: agent
    });
    if (request.exportOptions) {
      await persistDesktopExportOptions(projectPath, request.exportOptions);
    }
    notifyDesktopAgentEvent(observers, agent.runId, "build", "succeeded", "Applied mock agent source files.", "stage-completed", {
      filesChanged: applied.filesChanged,
      nextAction: "Record checkpoint changes"
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
    addLog("info", `Applied mock source files: ${applied.filesChanged.join(", ")}`, "build", {
      filesChanged: applied.filesChanged
    });
  }

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "check", observers, options.signal);
  }

  if (agent.ok) {
    notifyDesktopAgentEvent(observers, agent.runId, "check", "running", "Running htmlslide check after applying mock source files.", "stage-started", {
      nextAction: "Validate source files"
    });
    check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner, options.signal);
    const cliLog = desktopAgentCliLog(agent.runId, "check", check);
    addLog(cliLog.level, cliLog.message, cliLog.stage, cliLog.metadata);
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "check", observers, options.signal);
    } else {
      notifyDesktopAgentEvent(observers, agent.runId, "check", check.ok ? "succeeded" : "failed", check.ok ? "Check passed after applying mock source files." : "Check found issues after applying mock source files.", check.ok ? "stage-completed" : "stage-failed", {
        issuesFound: checkIssueCount(check),
        nextAction: check.ok ? "Export artifacts" : "Review QA issues"
      });
    }
  }

  if (agent.ok && check?.ok && request.runExport !== false) {
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "export", observers, options.signal);
    } else {
      notifyDesktopAgentEvent(observers, agent.runId, "export", "running", "Exporting checked mock agent project.", "stage-started", {
        nextAction: "Write project artifacts"
      });
      exportResult = await runDesktopAgentCliStep(
        ["export", projectPath, ...exportOptionsToCliArgs(request.exportOptions), "--json"],
        options.cliRuntime,
        cliRunner,
        options.signal
      );
      const cliLog = desktopAgentCliLog(agent.runId, "export", exportResult);
      addLog(cliLog.level, cliLog.message, cliLog.stage, cliLog.metadata);
      if (options.signal?.aborted) {
        agent = cancelDesktopCoreAgentResult(agent, "export", observers, options.signal);
      } else {
        notifyDesktopAgentEvent(observers, agent.runId, "export", exportResult.ok ? "succeeded" : "failed", exportResult.ok ? "Export completed for mock agent project." : "Export failed for mock agent project.", exportResult.ok ? "stage-completed" : "stage-failed");
      }
    }
  }

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "review", observers, options.signal);
  }
  if (agent.ok) {
    project = await loadProjectPreview(projectPath);
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "review", observers, options.signal);
      project = undefined;
    }
  }

  const stages = summarizeAgentStages(events);
  const summary = summarizeDesktopMockAgentRun(agent, check, exportResult);
  const agentReportPath = await writeDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId: "htmlslide-mock",
    targetSlideCount: request.targetSlideCount,
    stages
  });

  return {
    ok: agent.ok && (check === undefined || check.ok) && (exportResult === undefined || exportResult.ok),
    providerId: "htmlslide-mock",
    projectPath,
    stages,
    events,
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
  const observers = createDesktopAgentObserverDispatcher(options, runId, events, logs);
  const addEvent = createDesktopAgentEventRecorder(events, runId, observers);
  const addLog = createDesktopAgentLogRecorder(logs, runId, observers);
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

  if (options.signal?.aborted) {
    return byokAgentCancellationResult({
      addEvent,
      addLog,
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      signal: options.signal,
      stage: "brief"
    });
  }

  if (!options.cliRuntime) {
    return byokAgentFailureResult({
      addEvent,
      addLog,
      error: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide before running HTMLslide Agent.",
      events,
      logs,
      projectPath,
      runId,
      settings: settingsSummary,
      stage: "brief"
    });
  }

  if (!options.cliRunner) {
    try {
      await assertDesktopCliRuntimeUsable(options.cliRuntime);
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
  }

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

  const credentialStore = options.credentialStore ?? createDesktopCredentialStore();
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
  let apiKey: string | undefined;
  try {
    const credentialAccessTimeoutMs = options.credentialAccessTimeoutMs ?? DESKTOP_AGENT_CREDENTIAL_ACCESS_TIMEOUT_MS;
    const credentialAccess = await waitForDesktopAgentOperation(
      credentialStore.getPassword(AI_ENGINE_CREDENTIAL_SERVICE, credentialAccount, {
        signal: options.signal,
        timeoutMs: credentialAccessTimeoutMs
      }),
      options.signal,
      credentialAccessTimeoutMs,
      `${credentialStore.label} credential retrieval`
    );
    if (credentialAccess.status === "cancelled") {
      return byokAgentCancellationResult({
        addEvent,
        addLog,
        events,
        logs,
        projectPath,
        runId,
        settings: settingsSummary,
        signal: options.signal,
        stage: "brief"
      });
    }
    apiKey = credentialAccess.value;
  } catch (error) {
    if (options.signal?.aborted) {
      return byokAgentCancellationResult({
        addEvent,
        addLog,
        events,
        logs,
        projectPath,
        runId,
        settings: settingsSummary,
        signal: options.signal,
        stage: "brief"
      });
    }
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
    const credentialValidation = await waitForDesktopAgentOperation(
      modelProvider.validateCredentials(),
      options.signal,
      options.credentialValidationTimeoutMs
    );
    if (credentialValidation.status === "cancelled") {
      return byokAgentCancellationResult({
        addEvent,
        addLog,
        events,
        logs,
        projectPath,
        runId,
        settings: settingsSummary,
        signal: options.signal,
        stage: "brief"
      });
    }
    const credentialStatus = credentialValidation.value;
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
    if (options.signal?.aborted) {
      return byokAgentCancellationResult({
        addEvent,
        addLog,
        events,
        logs,
        projectPath,
        runId,
        settings: settingsSummary,
        signal: options.signal,
        stage: "brief"
      });
    }
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

  addEvent("brief", "succeeded", `${credentialStore.label} credential validated for ${provider}.`, "stage-completed", {
    metadata: settingsMetadata,
    nextAction: "Start HTMLslide Agent"
  });
  addLog("info", `${credentialStore.label} credential validated for ${provider}.`, "brief", {
    credentialAccount,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    provider
  });

  const controller = startAgentRun({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    maxRepairRounds: request.maxRepairRounds,
    projectRoot: projectPath,
    provider: modelProvider,
    runId,
    speakerNotesMode: request.speakerNotesMode,
    targetSlideCount: request.targetSlideCount,
    metadata: {
      credentialAccount,
      ...(baseUrl ? { baseUrl } : {}),
      mode: "desktop-byok-agent",
      model,
      provider
    },
    chooseVisualDirection: options.chooseVisualDirection,
    createCheckpoint: createFileCopyCheckpoint
  }, {
    onEvent: observers.event,
    onLog: observers.log
  });
  const detachAbortSignal = bridgeDesktopAgentAbortSignal(options.signal, (reason) => controller.cancel(reason));
  let agent: AgentRunResult;
  try {
    agent = await controller.done;
  } finally {
    detachAbortSignal();
  }

  let applied: DesktopByokAgentAppliedResult | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CliRunResult | undefined;
  let exportResult: CliRunResult | undefined;
  let project: DesktopProjectPreview | undefined;

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "build", observers, options.signal);
  }

  if (agent.ok) {
    notifyDesktopAgentEvent(observers, agent.runId, "build", "running", "Applying HTMLslide Agent source writes.", "stage-started", {
      metadata: settingsMetadata,
      nextAction: "Write provider-generated deck source"
    });
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "build", observers, options.signal);
    }
  }

  if (agent.ok) {
    applied = await applyByokAgentSourceWrites({
      projectPath,
      result: agent
    });
    if (request.exportOptions) {
      await persistDesktopExportOptions(projectPath, request.exportOptions);
    }
    notifyDesktopAgentEvent(observers, agent.runId, "build", "succeeded", "Applied HTMLslide Agent source writes.", "stage-completed", {
      filesChanged: applied.filesChanged,
      metadata: settingsMetadata,
      nextAction: "Record checkpoint changes"
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
    addLog("info", `Applied HTMLslide Agent source writes: ${applied.filesChanged.join(", ")}`, "build", {
      filesChanged: applied.filesChanged,
      source: applied.source,
      writeCount: applied.writeCount,
      model,
      provider
    });
  }

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "check", observers, options.signal);
  }

  if (agent.ok) {
    notifyDesktopAgentEvent(observers, agent.runId, "check", "running", "Running htmlslide check after applying HTMLslide Agent source writes.", "stage-started", {
      nextAction: "Validate source files"
    });
    check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner, options.signal);
    const cliLog = desktopAgentCliLog(agent.runId, "check", check);
    addLog(cliLog.level, cliLog.message, cliLog.stage, cliLog.metadata);
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "check", observers, options.signal);
    } else {
      notifyDesktopAgentEvent(observers, agent.runId, "check", check.ok ? "succeeded" : "failed", check.ok ? "Check passed after applying HTMLslide Agent source writes." : "Check found issues after applying HTMLslide Agent source writes.", check.ok ? "stage-completed" : "stage-failed", {
        issuesFound: checkIssueCount(check),
        nextAction: check.ok ? "Export artifacts" : "Review QA issues"
      });
    }
  }

  if (agent.ok && check?.ok && request.runExport !== false) {
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "export", observers, options.signal);
    } else {
      notifyDesktopAgentEvent(observers, agent.runId, "export", "running", "Exporting checked HTMLslide Agent project.", "stage-started", {
        nextAction: "Write project artifacts"
      });
      exportResult = await runDesktopAgentCliStep(
        ["export", projectPath, ...exportOptionsToCliArgs(request.exportOptions), "--json"],
        options.cliRuntime,
        cliRunner,
        options.signal
      );
      const cliLog = desktopAgentCliLog(agent.runId, "export", exportResult);
      addLog(cliLog.level, cliLog.message, cliLog.stage, cliLog.metadata);
      if (options.signal?.aborted) {
        agent = cancelDesktopCoreAgentResult(agent, "export", observers, options.signal);
      } else {
        notifyDesktopAgentEvent(observers, agent.runId, "export", exportResult.ok ? "succeeded" : "failed", exportResult.ok ? "Export completed for HTMLslide Agent project." : "Export failed for HTMLslide Agent project.", exportResult.ok ? "stage-completed" : "stage-failed");
      }
    }
  }

  if (agent.ok && options.signal?.aborted) {
    agent = cancelDesktopCoreAgentResult(agent, "review", observers, options.signal);
  }
  if (agent.ok) {
    project = await loadProjectPreview(projectPath);
    if (options.signal?.aborted) {
      agent = cancelDesktopCoreAgentResult(agent, "review", observers, options.signal);
      project = undefined;
    }
  }

  const stages = summarizeAgentStages(events);
  const summary = summarizeDesktopByokAgentRun(agent, check, exportResult, settingsSummary);
  const agentReportPath = await writeDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId: "htmlslide-byok",
    providerMetadata: settingsSummary,
    targetSlideCount: request.targetSlideCount,
    stages
  });

  return {
    ok: agent.ok && (check === undefined || check.ok) && (exportResult === undefined || exportResult.ok),
    providerId: "htmlslide-byok",
    projectPath,
    settings: settingsSummary,
    stages,
    events,
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
  const observers = createDesktopAgentObserverDispatcher(options, runId, events, logs);
  const addEvent = createDesktopAgentEventRecorder(events, runId, observers);
  const addLog = createDesktopAgentLogRecorder(logs, runId, observers);

  addEvent("brief", "running", "External agent request accepted.", "run-created", {
    nextAction: "Prepare prompt"
  });

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      events,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "brief"
    });
  }

  const settings = options.settings ?? (options.settingsPath
    ? await readAiEngineSettings(options.settingsPath)
    : sanitizeAiEngineSettings(DEFAULT_AI_ENGINE_SETTINGS));

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      events,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "brief"
    });
  }

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

  const selectedAgentId = settings.externalAgent.selectedId;
  if (selectedAgentId === "gemini-cli") {
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: "Gemini CLI remains detection-only until its non-interactive authentication and permission contract is tested.",
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }

  const commandTemplate = settings.externalAgent.customCommand.trim();
  if (selectedAgentId === "generic" && commandTemplate.length === 0) {
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

  const adapterLabel = selectedAgentId === "claude-code"
    ? "Claude Code"
    : selectedAgentId === "codex-cli"
      ? "Codex CLI"
      : "Generic command";

  if (selectedAgentId === "claude-code" || selectedAgentId === "codex-cli") {
    const statuses = options.externalAgentStatuses ?? await detectExternalAgentStatuses({ cwd: projectPath });
    const selectedStatus = statuses.find((status) => status.id === selectedAgentId);
    const ready =
      selectedStatus?.status === "ready" &&
      selectedStatus.installed &&
      selectedStatus.authenticated &&
      selectedStatus.capabilities.headlessRun === true &&
      selectedStatus.capabilities.readDiff === true;
    if (!ready) {
      return externalAgentFailureResult({
        addEvent,
        addLog,
        error: selectedStatus?.summary ?? `${adapterLabel} readiness could not be verified.`,
        events,
        logs,
        projectPath,
        runId,
        stage: "brief"
      });
    }
  }

  const checkpoint = await createFileCopyCheckpoint({
    projectRoot: projectPath,
    runId
  });
  addEvent("brief", "succeeded", "External agent checkpoint created.", "checkpoint-created", {
    checkpointId: checkpoint.id,
    nextAction: `Run ${adapterLabel}`
  });

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      events,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "build"
    });
  }

  const runDirectory = path.join(projectPath, ".htmlslide", "runs", runId);
  const writeManifest = path.join(runDirectory, "writes.json");
  const builtIn = selectedAgentId !== "generic";
  const agentWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-workspace-"));
  try {
    await copyBuiltInAgentWorkspace(projectPath, agentWorkspace);
    await createFileCopyCheckpoint({
      projectRoot: agentWorkspace,
      runId
    });
  } catch (error) {
    await cleanupBuiltInAgentWorkspace(agentWorkspace);
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: error instanceof Error ? error.message : String(error),
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }
  const agentProjectPath = agentWorkspace;
  const promptFile = builtIn
    ? path.join(agentProjectPath, ".htmlslide-task.md")
    : path.join(runDirectory, "prompt.md");
  const agentPromptFile = builtIn
    ? promptFile
    : path.join(agentProjectPath, ".htmlslide-task.md");
  const agentWriteManifest = builtIn
    ? undefined
    : path.join(agentProjectPath, ".htmlslide", "runs", runId, "writes.json");

  try {
    await fs.mkdir(runDirectory, { recursive: true });
    const prompt = externalAgentPrompt({
      brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
      projectPath: builtIn ? agentProjectPath : projectPath,
      speakerNotesMode: request.speakerNotesMode,
      writeManifest: builtIn ? undefined : writeManifest
    });
    await fs.writeFile(promptFile, prompt, "utf8");
    if (agentPromptFile !== promptFile) {
      await fs.mkdir(path.dirname(agentPromptFile), { recursive: true });
      await fs.writeFile(agentPromptFile, externalAgentPrompt({
        brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
        projectPath: agentProjectPath,
        speakerNotesMode: request.speakerNotesMode,
        writeManifest: agentWriteManifest
      }), "utf8");
    }
    if (!builtIn) {
      await fs.mkdir(path.dirname(agentWriteManifest ?? writeManifest), { recursive: true });
      await fs.writeFile(writeManifest, `${JSON.stringify({ writes: [] }, null, 2)}\n`, "utf8");
      await fs.writeFile(agentWriteManifest ?? writeManifest, `${JSON.stringify({ writes: [] }, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    await cleanupBuiltInAgentWorkspace(agentWorkspace);
    return externalAgentFailureResult({
      addEvent,
      addLog,
      error: error instanceof Error ? error.message : String(error),
      events,
      logs,
      projectPath,
      runId,
      stage: "brief"
    });
  }

  if (options.signal?.aborted) {
    await cleanupBuiltInAgentWorkspace(agentWorkspace);
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      events,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "build"
    });
  }

  addEvent("build", "running", `Running ${adapterLabel} external agent.`, "stage-started", {
    nextAction: "Wait for source changes"
  });

  const outputBuffer = createDesktopExternalAgentOutputBuffer(addLog);
  const onOutput = (chunk: { stream: "stdout" | "stderr"; text: string }): void => {
    if (builtIn) {
      outputBuffer.push(
        chunk.stream,
        `${adapterLabel} emitted a ${chunk.stream === "stdout" ? "progress" : "diagnostic"} event.\n`
      );
      return;
    }
    outputBuffer.push(chunk.stream, chunk.text);
  };
  let rawAdapter: AgentAdapterRunResult;
  if (selectedAgentId === "generic") {
    const adapterConfig: GenericAgentAdapterConfig = {
      id: "generic-command",
      label: adapterLabel,
      kind: "generic",
      commandTemplate,
      capabilities: createCapabilitySet(["headlessRun", "streamLogs", "cancelRun", "readDiff"]),
      pathVariables: ["projectRoot", "projectPath", "promptFile", "writeManifest"],
      timeoutMs: options.timeoutMs ?? 120_000
    };
    rawAdapter = await runGenericAgentAdapter({
      adapter: adapterConfig,
      projectRoot: agentProjectPath,
      promptFile: agentPromptFile,
      variables: {
        writeManifest: agentWriteManifest ?? writeManifest
      },
      signal: options.signal,
      onOutput,
      runner: options.agentRunner,
      timeoutMs: options.timeoutMs,
      readReportedFileWrites: () => readJsonFileWriteManifest(agentProjectPath, agentWriteManifest ?? writeManifest)
    });
  } else {
    rawAdapter = await runBuiltInExternalAgentAdapter({
      kind: selectedAgentId satisfies BuiltInExternalAgentKind,
      projectRoot: agentProjectPath,
      promptFile: agentPromptFile,
      signal: options.signal,
      onOutput,
      runner: options.agentRunner,
      timeoutMs: options.timeoutMs ?? 120_000
    });
  }
  const adapter = sanitizeAgentAdapterRunResult(
    rebaseAgentAdapterResultPaths(rawAdapter, agentProjectPath, projectPath)
  );
  const rawReportedWrites = rawAdapter.ok ? rawAdapter.reportedWrites : [];
  outputBuffer.flush();

  if (!builtIn && agentWriteManifest !== undefined) {
    await fs.copyFile(agentWriteManifest, writeManifest).catch(() => undefined);
  }

  if (!adapter.ok) {
    await cleanupBuiltInAgentWorkspace(agentWorkspace);
    const error = adapter.failure.detail ?? adapter.failure.message;
    addEvent("build", adapter.status === "cancelled" ? "cancelled" : "failed", adapter.failure.message, adapter.status === "cancelled" ? "run-cancelled" : "stage-failed", {
      nextAction: adapter.failure.remediation
    });
    addLog(adapter.status === "cancelled" ? "warning" : "error", error, "build", {
      failureType: adapter.failure.type
    });

    return {
      ok: false,
      providerId: "external-agent",
      projectPath,
      stages: summarizeAgentStages(events),
      events,
      logs,
      adapter,
      error,
      summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
    };
  }

  if (agentWorkspace !== undefined) {
    try {
      await assertBuiltInAgentWorkspaceHasNoSymlinks(agentWorkspace);
      const stagedDiff = await diffFileCopyCheckpoint({
        projectRoot: agentWorkspace,
        runId
      });
      if (!builtIn) {
        const unreportedWrites = findUnreportedSourceWrites(
          agentWorkspace,
          stagedDiff,
          rawReportedWrites
        );
        if (unreportedWrites.length > 0) {
          const error = `Generic external agent changed source files without reporting them: ${unreportedWrites.join(", ")}.`;
          addEvent("build", "failed", error, "stage-failed", {
            filesChanged: unreportedWrites,
            nextAction: "Review the checkpoint diff and retry with a complete write manifest"
          });
          addLog("error", error, "build", { filesChanged: unreportedWrites });
          return {
            ok: false,
            providerId: "external-agent",
            projectPath,
            stages: summarizeAgentStages(events),
            events,
            logs,
            adapter,
            error,
            summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, unreportedWrites)
          };
        }
      }
      const liveProjectDiff = await diffFileCopyCheckpoint({ projectRoot: projectPath, runId });
      const concurrentChanges = checkpointChangedPaths(liveProjectDiff);
      if (concurrentChanges.length > 0) {
        const error = `Project source changed while ${adapterLabel} was running; no agent changes were applied. Review external changes and retry.`;
        addEvent("build", "failed", error, "stage-failed", {
          filesChanged: concurrentChanges,
          nextAction: "Review external changes and retry"
        });
        addLog("warning", error, "build", { filesChanged: concurrentChanges });
        return {
          ok: false,
          providerId: "external-agent",
          projectPath,
          stages: summarizeAgentStages(events),
          events,
          logs,
          adapter,
          error,
          summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
        };
      }
      try {
        await assertRealProjectMatchesAgentBaseline(
          projectPath,
          stagedDiff,
          new Map(liveProjectDiff.unchanged.map((file) => [file.path, file.currentDigest ?? file.digest]))
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addEvent("build", "failed", message, "stage-failed", {
          nextAction: "Review external changes and retry"
        });
        addLog("warning", message, "build");
        return {
          ok: false,
          providerId: "external-agent",
          projectPath,
          stages: summarizeAgentStages(events),
          events,
          logs,
          adapter,
          error: message,
          summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
        };
      }
      await applyBuiltInAgentWorkspaceDiff(projectPath, agentWorkspace, stagedDiff);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const partialDiff = await diffFileCopyCheckpoint({ projectRoot: projectPath, runId });
      const partialFilesChanged = checkpointChangedPaths(partialDiff);
      if (partialFilesChanged.length > 0) {
        await recordCheckpointChanges({
          projectRoot: projectPath,
          runId,
          filesChanged: partialFilesChanged
        });
      }
      const checkpointDiff = partialFilesChanged.length > 0
        ? await diffFileCopyCheckpoint({ projectRoot: projectPath, runId })
        : undefined;
      addEvent("build", "failed", message, "stage-failed", {
        ...(partialFilesChanged.length > 0 ? { filesChanged: partialFilesChanged } : {}),
        nextAction: "Review agent output and retry"
      });
      addLog("error", message, "build");
      return {
        ok: false,
        providerId: "external-agent",
        projectPath,
        stages: summarizeAgentStages(events),
        events,
        logs,
        adapter,
        ...(checkpointDiff ? { checkpointDiff } : {}),
        error: message,
        summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, partialFilesChanged)
      };
    } finally {
      await cleanupBuiltInAgentWorkspace(agentWorkspace);
    }
  }

  if (request.exportOptions) {
    await persistDesktopExportOptions(projectPath, request.exportOptions);
  }
  const initialCheckpointDiff = await diffFileCopyCheckpoint({ projectRoot: projectPath, runId });
  const filesChanged = checkpointChangedPaths(initialCheckpointDiff);
  await recordCheckpointChanges({
    projectRoot: projectPath,
    runId,
    filesChanged
  });
  const checkpointDiff = await diffFileCopyCheckpoint({
    projectRoot: projectPath,
    runId
  });

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      adapter,
      checkpointDiff,
      events,
      filesChanged,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "build"
    });
  }

  addEvent("build", "succeeded", `${adapterLabel} changed ${filesChanged.length} source files.`, "stage-completed", {
    filesChanged,
    nextAction: "Run htmlslide check"
  });
  addLog("info", `${adapterLabel} completed.`, "build", {
    filesChanged
  });

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      adapter,
      checkpointDiff,
      events,
      filesChanged,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "check"
    });
  }

  addEvent("check", "running", "Running htmlslide check after external agent changes.", "stage-started", {
    nextAction: "Validate source files"
  });
  const check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner, options.signal);
  const checkLog = desktopAgentCliLog(runId, "check", check);
  addLog(checkLog.level, checkLog.message, checkLog.stage, checkLog.metadata);
  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      adapter,
      check,
      checkpointDiff,
      events,
      filesChanged,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "check"
    });
  }
  const checkIssues = checkIssueCount(check);
  addEvent("check", check.ok ? "succeeded" : "failed", check.ok ? "Check passed after external agent run." : "Check found issues after external agent run.", check.ok ? "stage-completed" : "stage-failed", {
    issuesFound: checkIssues,
    nextAction: check.ok ? "Export artifacts" : "Review QA issues"
  });

  let exportResult: CliRunResult | undefined;
  if (check.ok && request.runExport !== false) {
    if (options.signal?.aborted) {
      return externalAgentCancellationResult({
        addEvent,
        addLog,
        adapter,
        check,
        checkpointDiff,
        events,
        filesChanged,
        logs,
        projectPath,
        runId,
        signal: options.signal,
        stage: "export"
      });
    }
    addEvent("export", "running", "Exporting artifacts after external agent run.", "stage-started", {
      nextAction: "Write PDF, HTML, deckpkg, notes, and thumbnails"
    });
    exportResult = await runDesktopAgentCliStep(
      ["export", projectPath, ...exportOptionsToCliArgs(request.exportOptions), "--json"],
      options.cliRuntime,
      cliRunner,
      options.signal
    );
    const exportLog = desktopAgentCliLog(runId, "export", exportResult);
    addLog(exportLog.level, exportLog.message, exportLog.stage, exportLog.metadata);
    if (options.signal?.aborted) {
      return externalAgentCancellationResult({
        addEvent,
        addLog,
        adapter,
        check,
        checkpointDiff,
        events,
        exportResult,
        filesChanged,
        logs,
        projectPath,
        runId,
        signal: options.signal,
        stage: "export"
      });
    }
    addEvent("export", exportResult.ok ? "succeeded" : "failed", exportResult.ok ? "Export completed after external agent run." : "Export failed after external agent run.", exportResult.ok ? "stage-completed" : "stage-failed", {
      nextAction: exportResult.ok ? "Review generated changes" : "Inspect export failure"
    });
  }

  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      adapter,
      check,
      checkpointDiff,
      events,
      exportResult,
      filesChanged,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "review"
    });
  }
  const project = await loadProjectPreview(projectPath).catch((): DesktopProjectPreview | undefined => undefined);
  if (options.signal?.aborted) {
    return externalAgentCancellationResult({
      addEvent,
      addLog,
      adapter,
      check,
      checkpointDiff,
      events,
      exportResult,
      filesChanged,
      logs,
      projectPath,
      runId,
      signal: options.signal,
      stage: "review"
    });
  }
  const ok = check.ok && (exportResult === undefined || exportResult.ok);
  addEvent("review", ok ? "succeeded" : "failed", ok ? "External agent changes are ready for review." : "External agent changes need review.", ok ? "run-completed" : "run-failed", {
    filesChanged,
    nextAction: ok ? "Accept or revert checkpoint" : "Inspect QA/export status"
  });

  return {
    ok,
    providerId: "external-agent",
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
  return value === "claude-code" || value === "generic" || value === "codex-cli" || value === "gemini-cli"
    ? value
    : "codex-cli";
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
  capabilities,
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
  capabilities?: Record<string, boolean>;
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
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, ...capabilities },
    checkedAt,
    command,
    id,
    installed,
    kind: id,
    label,
    status,
    summary: sanitizeDesktopAgentText(collapseWhitespace(summary)),
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

async function runDetectorCommand(
  invocation: Parameters<ExternalAgentDetectorRunner>[0]
): Promise<Awaited<ReturnType<ExternalAgentDetectorRunner>>> {
  const result = await runCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.timedOut
      ? result.stderr || `Command ${invocation.command} timed out after ${invocation.timeoutMs}ms.`
      : result.stderr
  };
}

async function runSecurityCommand(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cancelled?: boolean; timedOut?: boolean }> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "macOS Keychain request cancelled.",
      cancelled: true
    });
  }

  const timeoutMs = Math.max(1, options.timeoutMs ?? DESKTOP_AGENT_CREDENTIAL_ACCESS_TIMEOUT_MS);
  const result = await runCommand({
    command: "/usr/bin/security",
    args,
    cwd: process.cwd(),
    signal: options.signal,
    timeoutMs
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.timedOut
      ? result.stderr || `macOS Keychain request timed out after ${timeoutMs}ms.`
      : result.cancelled
        ? result.stderr || "macOS Keychain request cancelled."
        : result.stderr,
    cancelled: result.cancelled,
    timedOut: result.timedOut
  };
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

function desktopExportOptionsFromManifest(value: unknown): DesktopExportOptions {
  const exportOptions = normalizeDeckExportOptions(value);
  return {
    deckpkg: exportOptions.deckpkg,
    html: exportOptions.html,
    pdf: exportOptions.pdf,
    thumbnails: exportOptions.thumbnails
  };
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

async function hasMissingSlideFiles(project: LoadedDeckProject): Promise<boolean> {
  for (const slide of project.slides) {
    if (!(await pathExists(slide.sourcePath))) {
      return true;
    }
    if (slide.notesPath && !(await pathExists(slide.notesPath))) {
      return true;
    }
  }
  return false;
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
    async getPassword(service, account, options) {
      const result = await runSecurityCommand(
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        options
      );
      if (result.timedOut) {
        throw new Error(result.stderr);
      }
      if (result.cancelled) {
        return undefined;
      }
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
  cliRunner: DesktopCliRunner,
  signal?: AbortSignal
): Promise<CliRunResult> {
  if (signal?.aborted) {
    return cancelledDesktopCliResult(args, "", "", signal);
  }
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
    rootPath: cliRuntime.rootPath,
    signal
  });
}

async function assertDesktopCliRuntimeUsable(cliRuntime: CliRuntime): Promise<void> {
  const cliStat = await fs.lstat(cliRuntime.cliPath);
  const cwdStat = await fs.lstat(cliRuntime.cwd);
  const rootStat = cliRuntime.rootPath ? await fs.lstat(cliRuntime.rootPath) : undefined;
  if (
    !cliStat.isFile() ||
    cliStat.isSymbolicLink() ||
    !cwdStat.isDirectory() ||
    (rootStat !== undefined && !rootStat.isDirectory())
  ) {
    throw new Error("HTMLslide CLI runtime is no longer usable. Rebuild the app or reinstall HTMLslide before running HTMLslide Agent.");
  }
  await fs.access(cliRuntime.cliPath, fsConstants.R_OK);
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
type DesktopAgentObserverDispatcher = ReturnType<typeof createDesktopAgentObserverDispatcher>;

function createDesktopAgentObserverDispatcher(
  options: Pick<DesktopMockAgentRunnerOptions, "onEvent" | "onLog">,
  runId: string,
  events: AgentRunEvent[],
  logs: AgentRunLog[]
) {
  let logLimitReached = false;
  return {
    event(event: AgentRunEvent): void {
      const normalized = normalizeDesktopAgentEvent(event, runId, events.length + 1);
      events.push(normalized);
      safelyNotifyDesktopAgentObserver(options.onEvent, normalized);
    },
    log(log: AgentRunLog): void {
      if (logLimitReached) {
        return;
      }
      if (logs.length >= DESKTOP_AGENT_LOG_RECORD_LIMIT - 1) {
        logLimitReached = true;
        const limitLog = normalizeDesktopAgentLog({
          createdAt: new Date().toISOString(),
          level: "warning",
          message: `Desktop service log limit reached (${DESKTOP_AGENT_LOG_RECORD_LIMIT} records).`,
          runId
        }, runId);
        logs.push(limitLog);
        safelyNotifyDesktopAgentObserver(options.onLog, limitLog);
        return;
      }
      const normalized = normalizeDesktopAgentLog(log, runId);
      logs.push(normalized);
      safelyNotifyDesktopAgentObserver(options.onLog, normalized);
    }
  };
}

function safelyNotifyDesktopAgentObserver<T>(
  observer: ((value: T) => void | Promise<void>) | undefined,
  value: T
): void {
  try {
    const delivery = observer?.(value);
    if (delivery && typeof delivery.then === "function") {
      void delivery.catch(() => undefined);
    }
  } catch {
    // Observer delivery is a UI side effect and must never affect the run.
  }
}

function createDesktopAgentEventRecorder(
  events: AgentRunEvent[],
  runId: string,
  observers?: DesktopAgentObserverDispatcher
) {
  return (
    stage: AgentRunStage,
    status: AgentRunStatus,
    summary: string,
    type: AgentRunEvent["type"],
    fields: Partial<Pick<AgentRunEvent, "checkpointId" | "filesChanged" | "issuesFound" | "nextAction" | "metadata">> = {}
  ): void => {
    const event: AgentRunEvent = {
      createdAt: new Date().toISOString(),
      runId,
      stage,
      status,
      summary,
      type,
      ...fields
    };
    if (observers) {
      observers.event(event);
    } else {
      events.push(normalizeDesktopAgentEvent(event, runId, events.length + 1));
    }
  };
}

function createDesktopAgentLogRecorder(
  logs: AgentRunLog[],
  runId: string,
  observers?: DesktopAgentObserverDispatcher
) {
  return (
    level: AgentRunLog["level"],
    message: string,
    stage?: AgentRunStage,
    metadata?: AgentRunLog["metadata"]
  ): void => {
    const log: AgentRunLog = {
      createdAt: new Date().toISOString(),
      level,
      message,
      runId,
      stage,
      metadata
    };
    if (observers) {
      observers.log(log);
    } else {
      logs.push(normalizeDesktopAgentLog(log, runId));
    }
  };
}

function normalizeDesktopAgentEvent(event: AgentRunEvent, runId: string, sequence: number): AgentRunEvent {
  return {
    ...event,
    runId: event.runId ?? runId,
    sequence,
    summary: sanitizeAndTruncateDesktopAgentText(event.summary, DESKTOP_AGENT_EVENT_TEXT_LIMIT),
    checkpointId: event.checkpointId === undefined
      ? undefined
      : sanitizeAndTruncateDesktopAgentText(event.checkpointId, DESKTOP_AGENT_EVENT_TEXT_LIMIT),
    filesChanged: event.filesChanged
      ?.slice(0, DESKTOP_AGENT_METADATA_ARRAY_LIMIT)
      .map((file) => sanitizeAndTruncateDesktopAgentText(file, DESKTOP_AGENT_METADATA_STRING_LIMIT)),
    nextAction: event.nextAction === undefined
      ? undefined
      : sanitizeAndTruncateDesktopAgentText(event.nextAction, DESKTOP_AGENT_EVENT_TEXT_LIMIT),
    metadata: sanitizeDesktopAgentMetadata(event.metadata)
  };
}

function normalizeDesktopAgentLog(log: AgentRunLog, runId: string): AgentRunLog {
  return {
    ...log,
    runId: log.runId || runId,
    message: sanitizeAndTruncateDesktopAgentText(log.message, DESKTOP_AGENT_LOG_MESSAGE_LIMIT),
    metadata: sanitizeDesktopAgentMetadata(log.metadata)
  };
}

export function sanitizeDesktopAgentMetadata(metadata: JsonObject | undefined): JsonObject | undefined {
  return metadata === undefined ? undefined : sanitizeDesktopAgentJsonValue(metadata) as JsonObject;
}

type DesktopAgentMetadataSanitizeState = {
  remainingNodes: number;
  remainingTextChars: number;
  seen: WeakSet<object>;
};

function sanitizeDesktopAgentJsonValue(
  value: JsonValue,
  state: DesktopAgentMetadataSanitizeState = {
    remainingNodes: DESKTOP_AGENT_METADATA_NODE_LIMIT,
    remainingTextChars: DESKTOP_AGENT_METADATA_TEXT_LIMIT,
    seen: new WeakSet<object>()
  },
  depth = 0
): JsonValue {
  if (typeof value === "string") {
    const limit = Math.max(0, Math.min(DESKTOP_AGENT_METADATA_STRING_LIMIT, state.remainingTextChars));
    const sanitized = limit === 0 ? "" : sanitizeAndTruncateDesktopAgentText(value, limit);
    state.remainingTextChars -= sanitized.length;
    return sanitized;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= DESKTOP_AGENT_METADATA_DEPTH_LIMIT || state.remainingNodes <= 0 || state.seen.has(value)) {
    return Array.isArray(value) ? [] : {};
  }
  state.seen.add(value);
  state.remainingNodes -= 1;
  if (Array.isArray(value)) {
    return value
      .slice(0, DESKTOP_AGENT_METADATA_ARRAY_LIMIT)
      .map((entry) => sanitizeDesktopAgentJsonValue(entry, state, depth + 1));
  }
  const result: JsonObject = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, DESKTOP_AGENT_METADATA_OBJECT_KEY_LIMIT)) {
    const key = sanitizeAndTruncateDesktopAgentText(rawKey, DESKTOP_AGENT_METADATA_KEY_LIMIT);
    result[key] = sanitizeDesktopAgentJsonValue(entry, state, depth + 1);
  }
  return result;
}

function bridgeDesktopAgentAbortSignal(
  signal: AbortSignal | undefined,
  cancel: (reason?: string) => void
): () => void {
  if (!signal) {
    return () => undefined;
  }

  const cancelRun = (): void => cancel(desktopAgentCancellationReason(signal));
  if (signal.aborted) {
    cancelRun();
  } else {
    signal.addEventListener("abort", cancelRun, { once: true });
  }

  return () => signal.removeEventListener("abort", cancelRun);
}

function desktopAgentCancellationReason(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return sanitizeDesktopAgentText(reason.message);
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return sanitizeDesktopAgentText(reason);
  }
  return "Run cancelled by user.";
}

function notifyDesktopAgentEvent(
  observers: DesktopAgentObserverDispatcher,
  runId: string,
  stage: AgentRunStage,
  status: AgentRunStatus,
  summary: string,
  type: AgentRunEvent["type"],
  fields: Partial<Pick<AgentRunEvent, "checkpointId" | "filesChanged" | "issuesFound" | "nextAction" | "metadata">> = {}
): void {
  observers.event({
    createdAt: new Date().toISOString(),
    runId,
    stage,
    status,
    summary,
    type,
    ...fields
  });
}

function cancelDesktopCoreAgentResult(
  agent: AgentRunResult,
  stage: AgentRunStage,
  observers: DesktopAgentObserverDispatcher,
  signal?: AbortSignal
): AgentRunResult {
  if (agent.status === "cancelled") {
    return agent;
  }

  const message = desktopAgentCancellationReason(signal);
  const createdAt = new Date().toISOString();
  const sequence = agent.events.reduce((highest, event) => Math.max(highest, event.sequence ?? 0), 0) + 1;
  const event = normalizeDesktopAgentEvent({
    createdAt,
    runId: agent.runId,
    sequence,
    stage,
    status: "cancelled",
    summary: message,
    type: "run-cancelled"
  }, agent.runId, sequence);
  const log = normalizeDesktopAgentLog({
    createdAt,
    level: "warning",
    message,
    runId: agent.runId,
    stage
  }, agent.runId);
  observers.event(event);
  observers.log(log);

  return {
    ok: false,
    status: "cancelled",
    runId: agent.runId,
    checkpoint: agent.checkpoint,
    error: {
      code: "cancelled",
      message,
      stage
    },
    outputs: agent.outputs,
    events: [...agent.events, event],
    logs: [...agent.logs, log]
  };
}

function sanitizeDesktopAgentText(value: string): string {
  return sanitizeProviderText(value);
}

const DESKTOP_AGENT_LOG_MESSAGE_LIMIT = 8_192;
const DESKTOP_AGENT_LOG_RECORD_LIMIT = 500;
const DESKTOP_AGENT_EVENT_TEXT_LIMIT = 8_192;
const DESKTOP_AGENT_METADATA_STRING_LIMIT = 4_096;
const DESKTOP_AGENT_METADATA_KEY_LIMIT = 128;
const DESKTOP_AGENT_METADATA_ARRAY_LIMIT = 100;
const DESKTOP_AGENT_METADATA_OBJECT_KEY_LIMIT = 100;
const DESKTOP_AGENT_METADATA_DEPTH_LIMIT = 6;
const DESKTOP_AGENT_METADATA_NODE_LIMIT = 1_000;
const DESKTOP_AGENT_METADATA_TEXT_LIMIT = 65_536;
const DESKTOP_AGENT_STREAM_LINE_LIMIT = 65_536;
const DESKTOP_AGENT_CREDENTIAL_ACCESS_TIMEOUT_MS = 5_000;
const DESKTOP_AGENT_PREFLIGHT_TIMEOUT_MS = 15_000;

function truncateDesktopAgentText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 36))}\n[truncated for desktop delivery]`;
}

function sanitizeAndTruncateDesktopAgentText(value: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  const boundedInput = value.slice(0, Math.min(value.length, limit + 256));
  return truncateDesktopAgentText(sanitizeDesktopAgentText(boundedInput), limit);
}

function createDesktopExternalAgentOutputBuffer(addLog: DesktopAgentLogRecorder) {
  type Stream = "stdout" | "stderr";
  type StreamState = { text: string; truncated: boolean };
  const states: Record<Stream, StreamState> = {
    stdout: { text: "", truncated: false },
    stderr: { text: "", truncated: false }
  };

  const append = (state: StreamState, text: string): void => {
    const available = Math.max(0, DESKTOP_AGENT_STREAM_LINE_LIMIT - state.text.length);
    state.text += text.slice(0, available);
    if (text.length > available) {
      state.truncated = true;
    }
  };
  const emit = (stream: Stream): void => {
    const state = states[stream];
    const message = state.text.replace(/\r$/u, "").trim();
    if (message.length > 0) {
      addLog(
        stream === "stdout" ? "info" : "warning",
        state.truncated ? `${message}\n[stream line truncated]` : message,
        "build",
        { stream }
      );
    }
    state.text = "";
    state.truncated = false;
  };

  return {
    push(stream: Stream, text: string): void {
      let remaining = text;
      while (remaining.length > 0) {
        const newline = remaining.indexOf("\n");
        if (newline < 0) {
          append(states[stream], remaining);
          return;
        }
        append(states[stream], remaining.slice(0, newline));
        emit(stream);
        remaining = remaining.slice(newline + 1);
      }
    },
    flush(): void {
      emit("stdout");
      emit("stderr");
    }
  };
}

async function waitForDesktopAgentOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = DESKTOP_AGENT_PREFLIGHT_TIMEOUT_MS,
  label = "Provider credential validation"
): Promise<{ status: "completed"; value: T } | { status: "cancelled" }> {
  if (signal?.aborted) {
    return { status: "cancelled" };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    };
    const finish = (result: { status: "completed"; value: T } | { status: "cancelled" }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const cancel = (): void => finish({ status: "cancelled" });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    void operation.then(
      (value) => finish({ status: "completed", value }),
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function rebaseAgentAdapterResultPaths(
  adapter: AgentAdapterRunResult,
  workspacePath: string,
  projectPath: string
): AgentAdapterRunResult {
  const workspaceRoot = path.resolve(workspacePath);
  const projectRoot = path.resolve(projectPath);
  const rebasePath = (value: string): string => {
    const absolute = path.resolve(value);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))) {
      return path.resolve(projectRoot, relative);
    }
    return value;
  };
  const rebaseText = (value: string): string => value.split(workspaceRoot).join(projectRoot);
  const reportedWrites = adapter.reportedWrites?.map(rebasePath);

  if (adapter.ok) {
    return {
      ...adapter,
      command: {
        ...adapter.command,
        args: adapter.command.args.map(rebaseText)
      },
      cwd: projectRoot,
      ...(reportedWrites === undefined ? {} : { reportedWrites })
    };
  }

  const command = adapter.command === undefined
    ? undefined
    : {
        ...adapter.command,
        args: adapter.command.args.map(rebaseText)
      };
  return {
    ...adapter,
    command,
    cwd: projectRoot,
    ...(reportedWrites === undefined ? {} : { reportedWrites }),
    failure: {
      ...adapter.failure,
      ...(adapter.failure.path === undefined ? {} : { path: rebasePath(adapter.failure.path) }),
      ...(adapter.failure.command === undefined ? {} : { command: rebaseText(adapter.failure.command) })
    }
  };
}

function sanitizeAgentAdapterRunResult(adapter: AgentAdapterRunResult): AgentAdapterRunResult {
  const builtIn = adapter.adapter.kind === "claude-code" || adapter.adapter.kind === "codex-cli";
  if (adapter.ok) {
    return {
      ...adapter,
      stderr: builtIn && adapter.stderr.length > 0 ? "[built-in diagnostic output omitted]" : sanitizeDesktopAgentText(adapter.stderr),
      stdout: builtIn && adapter.stdout.length > 0 ? "[built-in structured output omitted]" : sanitizeDesktopAgentText(adapter.stdout)
    };
  }

  return {
    ...adapter,
    failure: {
      ...adapter.failure,
      detail: adapter.failure.detail === undefined
        ? undefined
        : builtIn
          ? "Built-in agent diagnostic output omitted."
          : sanitizeDesktopAgentText(adapter.failure.detail),
      message: sanitizeDesktopAgentText(adapter.failure.message)
    },
    stderr: adapter.stderr === undefined
      ? undefined
      : builtIn && adapter.stderr.length > 0
        ? "[built-in diagnostic output omitted]"
        : sanitizeDesktopAgentText(adapter.stderr),
    stdout: adapter.stdout === undefined
      ? undefined
      : builtIn && adapter.stdout.length > 0
        ? "[built-in structured output omitted]"
        : sanitizeDesktopAgentText(adapter.stdout)
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
  const sanitizedError = sanitizeDesktopAgentText(error);
  addEvent(stage, "failed", sanitizedError, "stage-failed", {
    nextAction: "Update AI Engines settings and retry."
  });
  addLog("error", sanitizedError, stage);

  return {
    ok: false,
    providerId: "external-agent",
    projectPath,
    stages: summarizeAgentStages(events),
    events,
    logs,
    error: sanitizedError,
    summary: summarizeDesktopExternalAgentRun(runId, events, undefined, undefined, [])
  };
}

function externalAgentCancellationResult({
  addEvent,
  addLog,
  adapter,
  check,
  checkpointDiff,
  events,
  exportResult,
  filesChanged = [],
  logs,
  projectPath,
  runId,
  signal,
  stage
}: {
  addEvent: DesktopAgentEventRecorder;
  addLog: DesktopAgentLogRecorder;
  adapter?: AgentAdapterRunResult;
  check?: CliRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  events: AgentRunEvent[];
  exportResult?: CliRunResult;
  filesChanged?: string[];
  logs: AgentRunLog[];
  projectPath: string;
  runId: string;
  signal?: AbortSignal;
  stage: AgentRunStage;
}): DesktopExternalAgentRunResult {
  const error = desktopAgentCancellationReason(signal);
  addEvent(stage, "cancelled", error, "run-cancelled", {
    nextAction: "Start a new run when ready."
  });
  addLog("warning", error, stage);

  return {
    ok: false,
    providerId: "external-agent",
    projectPath,
    stages: summarizeAgentStages(events),
    events,
    logs,
    adapter,
    checkpointDiff,
    check,
    export: exportResult,
    error,
    summary: summarizeDesktopExternalAgentRun(runId, events, check, exportResult, filesChanged)
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
  const sanitizedError = sanitizeDesktopAgentText(error);
  addEvent(stage, "failed", sanitizedError, "stage-failed", {
    metadata: byokSettingsMetadata(settings),
    nextAction: "Update AI Engines settings and retry."
  });
  addLog("error", sanitizedError, stage, byokSettingsMetadata(settings));

  return {
    ok: false,
    providerId: "htmlslide-byok",
    projectPath,
    settings,
    stages: summarizeAgentStages(events),
    events,
    logs,
    error: sanitizedError,
    summary: summarizeDesktopByokFailureRun(runId, events, settings)
  };
}

function byokAgentCancellationResult({
  addEvent,
  addLog,
  events,
  logs,
  projectPath,
  runId,
  settings,
  signal,
  stage
}: {
  addEvent: DesktopAgentEventRecorder;
  addLog: DesktopAgentLogRecorder;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  projectPath: string;
  runId: string;
  settings: {
    baseUrl?: string;
    provider: DesktopApiKeyProvider;
    model: string;
  };
  signal?: AbortSignal;
  stage: AgentRunStage;
}): DesktopByokAgentRunResult {
  const error = desktopAgentCancellationReason(signal);
  addEvent(stage, "cancelled", error, "run-cancelled", {
    metadata: byokSettingsMetadata(settings),
    nextAction: "Start a new run when ready."
  });
  addLog("warning", error, stage, byokSettingsMetadata(settings));

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

  await validateByokAgentBuildManifest({
    batches,
    projectPath,
    result
  });

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

async function validateByokAgentBuildManifest({
  batches,
  projectPath,
  result
}: {
  batches: Array<{
    stage: Extract<AgentRunStage, "build" | "repair">;
    attempt?: number;
    writes: AgentSourceWrite[];
  }>;
  projectPath: string;
  result: AgentRunResult;
}): Promise<void> {
  const outline = result.outputs.outline;
  if (!outline) {
    throw new Error("HTMLslide Agent provider did not return an accepted outline for build-manifest validation.");
  }

  const finalWriteByPath = new Map<string, AgentSourceWrite>();
  for (const batch of batches) {
    for (const write of batch.writes) {
      finalWriteByPath.set(write.path, write);
    }
  }

  const manifestWrite = finalWriteByPath.get("deck.json");
  if (!manifestWrite) {
    throw new Error("HTMLslide Agent provider sourceWrites must include the generated deck.json manifest.");
  }

  let deck: Deck;
  try {
    deck = parseDeck(JSON.parse(manifestWrite.content) as unknown);
  } catch (error) {
    const detail = error instanceof SyntaxError ? ` ${error.message}` : "";
    throw new Error(`HTMLslide Agent generated deck.json is invalid.${detail}`);
  }

  const outlineSlideIds = outline.slides.map((slide) => slide.id);
  const manifestSlideIds = deck.slides.map((slide) => slide.id);
  if (
    outlineSlideIds.length !== manifestSlideIds.length ||
    outlineSlideIds.some((slideId, index) => slideId !== manifestSlideIds[index])
  ) {
    throw new Error(
      `HTMLslide Agent generated deck.json slide IDs/order do not match the accepted outline ` +
      `(outline: ${outlineSlideIds.join(", ")}; deck.json: ${manifestSlideIds.join(", ")}).`
    );
  }

  const referencedPaths = uniqueStrings(
    deck.slides.flatMap((slide) => slide.notes ? [slide.source, slide.notes] : [slide.source])
  );
  for (const referencedPath of referencedPaths) {
    if (finalWriteByPath.has(referencedPath)) {
      continue;
    }
    await assertExistingByokManifestReferenceSafe(projectPath, referencedPath);
  }
}

async function assertExistingByokManifestReferenceSafe(
  projectPath: string,
  referencedPath: string
): Promise<void> {
  const projectRoot = await fs.realpath(projectPath);
  let currentPath = projectRoot;

  try {
    for (const segment of referencedPath.split("/")) {
      currentPath = path.join(currentPath, segment);
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`path component is a symbolic link: ${referencedPath}`);
      }
    }

    const stats = await fs.stat(currentPath);
    if (!stats.isFile()) {
      throw new Error(`path is not a regular file: ${referencedPath}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `HTMLslide Agent generated deck.json references ${referencedPath}, but it is not included in sourceWrites ` +
      `and does not already exist safely in the project (${detail}).`
    );
  }
}

async function writeDesktopAgentRunReport({
  agent,
  applied,
  check,
  checkpointDiff,
  exportResult,
  projectPath,
  providerId,
  providerMetadata,
  targetSlideCount,
  stages
}: {
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult | DesktopByokAgentAppliedResult;
  check?: CliRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportResult?: CliRunResult;
  projectPath: string;
  providerId: DesktopAgentRunReport["providerId"];
  providerMetadata?: Pick<DesktopByokAgentRunSummary, "provider" | "model" | "baseUrl">;
  targetSlideCount?: number;
  stages: DesktopMockAgentStageSummary[];
}): Promise<string> {
  const reportsPath = await ensureProjectRuntimeDirectory(projectPath, [".htmlslide", "reports"]);
  const exportManifest = await readDesktopAgentExportManifestSummary(projectPath, exportResult);

  const report = createDesktopAgentRunReport({
    agent,
    applied,
    check,
    checkpointDiff,
    exportResult,
    projectPath,
    providerId,
    providerMetadata,
    targetSlideCount,
    exportManifest,
    stages
  });
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = path.join(reportsPath, `agent-run-${safeAgentRunReportId(agent.runId)}.json`);
  await Promise.all([
    writeRuntimeFileAtomic(reportPath, payload),
    writeRuntimeFileAtomic(path.join(reportsPath, "latest-agent-run.json"), payload)
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
  providerMetadata,
  targetSlideCount,
  exportManifest,
  stages
}: {
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult | DesktopByokAgentAppliedResult;
  check?: CliRunResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportResult?: CliRunResult;
  projectPath: string;
  providerId: DesktopAgentRunReport["providerId"];
  providerMetadata?: Pick<DesktopByokAgentRunSummary, "provider" | "model" | "baseUrl">;
  targetSlideCount?: number;
  exportManifest?: DesktopAgentRunReport["exportManifest"];
  stages: DesktopMockAgentStageSummary[];
}): DesktopAgentRunReport {
  const report: DesktopAgentRunReport = {
    schemaVersion: AGENT_RUN_REPORT_SCHEMA_VERSION,
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

  if (targetSlideCount !== undefined) {
    report.targetSlideCount = targetSlideCount;
  }

  if (providerMetadata) {
    report.provider = {
      model: providerMetadata.model,
      provider: providerMetadata.provider,
      ...(providerMetadata.baseUrl
        ? { baseUrlSha256: createHash("sha256").update(providerMetadata.baseUrl).digest("hex") }
        : {})
    };
  }

  if (exportManifest) {
    report.exportManifest = exportManifest;
  }

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

async function readDesktopAgentExportManifestSummary(
  projectPath: string,
  exportResult: CliRunResult | undefined
): Promise<DesktopAgentRunReport["exportManifest"] | undefined> {
  if (!exportResult?.ok) {
    return undefined;
  }
  try {
    const manifestPath = path.join(projectPath, "exports", "export-manifest.json");
    const manifestStat = await fs.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return undefined;
    }
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = ExportManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    return {
      sourceDigest: manifest.sourceDigest,
      artifactCount: manifest.artifacts.length,
      sha256: createHash("sha256").update(manifestBytes).digest("hex")
    };
  } catch {
    return undefined;
  }
}

async function ensureProjectRuntimeDirectory(projectPath: string, segments: string[]): Promise<string> {
  let current = path.resolve(projectPath);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const currentStat = await fs.lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw new Error(`HTMLslide runtime path must be a real project directory: ${current}`);
    }
  }
  return current;
}

async function writeRuntimeFileAtomic(filePath: string, payload: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await fs.writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
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

  if (outputs.speakerNotesMode) {
    reportOutputs.speakerNotesMode = outputs.speakerNotesMode;
  }

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
  speakerNotesMode,
  writeManifest
}: {
  brief: string;
  projectPath: string;
  speakerNotesMode?: SpeakerNotesMode;
  writeManifest?: string;
}): string {
  const lines = [
    "# HTMLslide External Agent Task",
    "",
    `Project root: ${projectPath}`,
    "",
    "## User request",
    brief,
    "",
    `Speaker notes mode: ${speakerNotesMode ?? "bullet-notes"}. Preserve this mode in deck.json and ${speakerNotesMode === "none" ? "omit slide notes paths and files." : "generate the requested notes style."}`,
    "",
    "## Required boundaries",
    "- Edit only deck source files: deck.json, slides/, notes/, theme/, or assets/.",
    writeManifest === undefined
      ? "- Do not edit exports/ or .htmlslide/."
      : "- Do not edit exports/ or .htmlslide/ except for the write manifest below.",
    "- Keep slide content as fixed 16:9 HTML fragments; do not add responsive reflow.",
    "- Preserve project-relative paths in deck.json.",
    ""
  ];

  if (writeManifest !== undefined) {
    lines.push(
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
    );
  }

  return lines.join("\n");
}

const builtInAgentWorkspaceEntries = [
  "deck.json",
  "slides",
  "notes",
  "theme",
  "assets",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "skills",
  ".agents",
  ".claude"
] as const;

async function copyBuiltInAgentWorkspace(projectPath: string, workspacePath: string): Promise<void> {
  for (const entry of builtInAgentWorkspaceEntries) {
    await copyBuiltInAgentWorkspaceEntry(
      path.join(projectPath, entry),
      path.join(workspacePath, entry),
      entry === "deck.json"
    );
  }
}

async function copyBuiltInAgentWorkspaceEntry(
  sourcePath: string,
  destinationPath: string,
  required = false
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(sourcePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Built-in external agent workspaces do not follow symlinks: ${sourcePath}`);
  }

  if (stat.isDirectory()) {
    await fs.mkdir(destinationPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await copyBuiltInAgentWorkspaceEntry(
        path.join(sourcePath, entry.name),
        path.join(destinationPath, entry.name)
      );
    }
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`Built-in external agent workspaces accept only regular files: ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
}

async function applyBuiltInAgentWorkspaceDiff(
  projectPath: string,
  workspacePath: string,
  diff: FileCopyCheckpointDiff
): Promise<void> {
  for (const file of [...diff.changed, ...diff.added]) {
    const sourcePath = resolveBuiltInAgentSourcePath(workspacePath, file.path);
    const destinationPath = resolveBuiltInAgentSourcePath(projectPath, file.path);
    await assertNoSymlinkPathComponents(workspacePath, file.path);
    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Built-in external agent produced a non-regular source file: ${file.path}`);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }

  for (const file of diff.deleted) {
    await fs.rm(resolveBuiltInAgentSourcePath(projectPath, file.path), { force: true });
  }
}

async function assertBuiltInAgentWorkspaceHasNoSymlinks(workspacePath: string): Promise<void> {
  for (const entry of ["deck.json", "slides", "notes", "theme", "assets"] as const) {
    await assertWorkspaceEntryHasNoSymlinks(path.join(workspacePath, entry));
  }
}

async function assertWorkspaceEntryHasNoSymlinks(entryPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Built-in external agent produced a symlinked source path: ${entryPath}`);
  }
  if (!stat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(entryPath);
  for (const child of entries.sort((left, right) => left.localeCompare(right))) {
    await assertWorkspaceEntryHasNoSymlinks(path.join(entryPath, child));
  }
}

async function assertRealProjectMatchesAgentBaseline(
  projectPath: string,
  diff: FileCopyCheckpointDiff,
  baselineDigests: ReadonlyMap<string, string | undefined>
): Promise<void> {
  for (const file of [...diff.changed, ...diff.added, ...diff.deleted]) {
    await assertRealSourceDigest(projectPath, file.path, baselineDigests.get(file.path));
  }
}

async function assertRealSourceDigest(
  projectPath: string,
  relativePath: string,
  expectedDigest: string | undefined
): Promise<void> {
  await assertNoSymlinkPathComponents(projectPath, relativePath);
  const absolutePath = resolveBuiltInAgentSourcePath(projectPath, relativePath);
  let actualDigest: string | undefined;
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Project source is no longer a regular file: ${relativePath}`);
    }
    actualDigest = createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (actualDigest !== expectedDigest) {
    throw new Error(`Project source changed during the external agent run: ${relativePath}`);
  }
}

async function assertNoSymlinkPathComponents(rootPath: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/").filter(Boolean);
  let current = path.resolve(rootPath);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`External agent source path contains a symlink: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function checkpointChangedPaths(diff: FileCopyCheckpointDiff): string[] {
  return uniqueStrings([
    ...diff.changed.map((file) => file.path),
    ...diff.added.map((file) => file.path),
    ...diff.deleted.map((file) => file.path)
  ]).sort((left, right) => left.localeCompare(right));
}

function findUnreportedSourceWrites(
  projectPath: string,
  diff: FileCopyCheckpointDiff,
  reportedWrites: readonly string[]
): string[] {
  const reported = new Set(reportedWrites.map((filePath) => path.resolve(projectPath, filePath)));
  return checkpointChangedPaths(diff).filter((relativePath) =>
    !reported.has(path.resolve(projectPath, relativePath))
  );
}

function resolveBuiltInAgentSourcePath(projectPath: string, relativePath: string): string {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Built-in external agent source path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

async function cleanupBuiltInAgentWorkspace(workspacePath: string | undefined): Promise<void> {
  if (workspacePath !== undefined) {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
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
      (event) => event.type === "stage-failed" ||
        event.type === "stage-completed" ||
        event.type === "run-cancelled" ||
        event.status === "cancelled"
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

function requirePresenterProjectReference(project: DesktopProjectReference): { id: string; path: string } {
  const id = typeof project.id === "string" ? project.id.trim() : "";
  const projectPath = typeof project.path === "string" ? project.path.trim() : "";
  if (id.length === 0 || projectPath.length === 0) {
    throw new Error("Presenter preferences require a project id and path.");
  }
  return {
    id,
    path: path.resolve(projectPath)
  };
}

function defaultPresenterPreferences(reference: { id: string; path: string }): DesktopPresenterPreferences {
  return {
    notesFontSizePx: DEFAULT_NOTES_FONT_SIZE_PX,
    projectId: reference.id,
    projectPath: reference.path
  };
}

function normalizePresenterPreferences(
  value: unknown,
  reference: { id: string; path: string }
): DesktopPresenterPreferences {
  const record = isRecord(value) ? value : {};
  const recentSlideId = typeof record.recentSlideId === "string" && record.recentSlideId.trim().length > 0
    ? record.recentSlideId.trim().slice(0, 256)
    : undefined;
  const notesFontSizePx = Number.isInteger(record.notesFontSizePx) &&
      Number(record.notesFontSizePx) >= MIN_NOTES_FONT_SIZE_PX &&
      Number(record.notesFontSizePx) <= MAX_NOTES_FONT_SIZE_PX
    ? Number(record.notesFontSizePx)
    : DEFAULT_NOTES_FONT_SIZE_PX;
  const selectedDisplay = normalizePresenterDisplayPreference(record.selectedDisplay);

  return {
    ...(recentSlideId ? { recentSlideId } : {}),
    notesFontSizePx,
    projectId: reference.id,
    projectPath: reference.path,
    ...(selectedDisplay ? { selectedDisplay } : {})
  };
}

function normalizeStoredPresenterPreferences(value: unknown): DesktopPresenterPreferences | undefined {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.projectPath !== "string") {
    return undefined;
  }

  const projectId = value.projectId.trim();
  const projectPath = value.projectPath.trim();
  if (projectId.length === 0 || projectPath.length === 0 || !path.isAbsolute(projectPath)) {
    return undefined;
  }

  return normalizePresenterPreferences(value, { id: projectId, path: path.resolve(projectPath) });
}

function normalizePresenterDisplayPreference(value: unknown): DesktopPresenterDisplayPreference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = typeof value.id === "number" ? value.id : undefined;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (id === undefined || !Number.isSafeInteger(id) || id < 0 || label.length === 0 || label.length > 200 || typeof value.internal !== "boolean") {
    return undefined;
  }

  return {
    id,
    internal: value.internal,
    label
  };
}

function matchesPresenterProject(
  preferences: DesktopPresenterPreferences,
  reference: { id: string; path: string }
): boolean {
  return preferences.projectId === reference.id || path.resolve(preferences.projectPath) === reference.path;
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
