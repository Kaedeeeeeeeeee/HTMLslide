import type { NewDeckDraft, ProjectSummary, SlideSummary } from "./model";
import type { AiEngineSettings, ExternalAgentStatus } from "./settings-model";
import type { PresenterDeck } from "@htmlslide/presenter/session";
import type { AgentAdapterRunResult } from "@htmlslide/agent-adapters";
import type {
  AgentRunEvent,
  AgentRunLog,
  AgentRunResult,
  AgentRunStage,
  AgentRunStatus,
  ApplyMockAgentProjectResult,
  FileCopyCheckpointDiff,
  FileCopyCheckpointRevertResult
} from "@htmlslide/agent";

export type DesktopSetupState = {
  appName: string;
  version: string;
  platform: string;
  libraryPath: string;
  workspacePath: string;
  initialOpen?: DesktopInitialOpenRequest;
  cli: {
    available: boolean;
    mode: "development" | "packaged" | "missing";
    rootPath?: string;
    cliPath?: string;
  };
  cliIntegration: DesktopCliIntegrationState;
};

export type DesktopInitialOpenRequest = {
  kind: "deckpkg";
  path: string;
};

export type DesktopCliIntegrationState = {
  available: boolean;
  mode: "development" | "packaged" | "missing";
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

export type DesktopProjectRecord = Omit<ProjectSummary, "lastOpened"> & {
  lastOpenedAt: string;
  thumbnail?: string;
};

export type DesktopProjectPreview = {
  project: DesktopProjectRecord;
  slides: SlideSummary[];
};

export type DesktopCliResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
  project?: DesktopProjectPreview;
};

export type DesktopCheckReport = {
  status?: "passed" | "failed";
  projectPath?: string;
  summary?: {
    errors?: number;
    warnings?: number;
    info?: number;
    suggestions?: number;
  };
  issues?: Array<{
    slideId?: string;
    severity?: "error" | "warning" | "info" | "suggestion";
    type?: string;
    message?: string;
    path?: string;
    selector?: string;
    measurement?: string | number | boolean | Record<string, string | number | boolean>;
    suggestedFix?: string;
    agentInstruction?: string;
  }>;
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
  check?: DesktopCliResult;
  export?: DesktopCliResult;
  project?: DesktopProjectPreview;
  summary: DesktopMockAgentRunSummary;
};

export type DesktopByokAgentRunRequest = DesktopMockAgentRunRequest;

export type DesktopByokAgentRunSummary = DesktopMockAgentRunSummary & {
  provider: "openai" | "anthropic" | "compatible";
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
    provider: "openai" | "anthropic" | "compatible";
    model: string;
    baseUrl?: string;
  };
  stages: DesktopMockAgentStageSummary[];
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  agent?: AgentRunResult;
  applied?: DesktopByokAgentAppliedResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: DesktopCliResult;
  export?: DesktopCliResult;
  project?: DesktopProjectPreview;
  error?: string;
  summary: DesktopByokAgentRunSummary;
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
  check?: DesktopCliResult;
  export?: DesktopCliResult;
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

export type DesktopPresenterDeckIssue = {
  severity: string;
  type: string;
  message: string;
  path?: string;
  slideId?: string;
};

export type DesktopPresenterDeckOrigin = "project-export" | "deckpkg-file";

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

export type DesktopAiEngineSettingsSaveRequest = {
  settings: AiEngineSettings;
  apiKeyInput?: string;
  clearKey?: boolean;
};

export type HtmlslideDesktopApi = {
  appName: string;
  platform: string;
  shell: "electron";
  getSetup(): Promise<DesktopSetupState>;
  getCliIntegration(): Promise<DesktopCliIntegrationState>;
  installCliIntegration(): Promise<DesktopCliIntegrationState>;
  uninstallCliIntegration(): Promise<DesktopCliIntegrationState>;
  copyCliManualInstallCommand(): Promise<{ copied: boolean; command: string }>;
  listProjects(): Promise<DesktopProjectRecord[]>;
  getAiEngineSettings(): Promise<AiEngineSettings>;
  saveAiEngineSettings(request: DesktopAiEngineSettingsSaveRequest): Promise<AiEngineSettings>;
  detectExternalAgents(): Promise<ExternalAgentStatus[]>;
  chooseWorkspace(): Promise<string | undefined>;
  openProjectDialog(): Promise<DesktopProjectPreview | undefined>;
  loadProject(projectPath: string): Promise<DesktopProjectPreview>;
  createProject(request: NewDeckDraft & { workspacePath?: string }): Promise<DesktopCliResult>;
  checkProject(projectPath: string): Promise<DesktopCliResult>;
  exportProject(projectPath: string): Promise<DesktopCliResult>;
  loadPresenterDeck(projectPath: string): Promise<DesktopPresenterDeckResult>;
  loadPresenterDeckPackage(deckpkgPath: string): Promise<DesktopPresenterDeckResult>;
  onOpenDeckPackage(handler: (request: DesktopInitialOpenRequest) => void): () => void;
  listPresenterDisplays(): Promise<DesktopPresenterDisplay[]>;
  runMockAgent(request: DesktopMockAgentRunRequest): Promise<DesktopMockAgentRunResult>;
  runByokAgent(request: DesktopByokAgentRunRequest): Promise<DesktopByokAgentRunResult>;
  runExternalAgent(request: DesktopExternalAgentRunRequest): Promise<DesktopExternalAgentRunResult>;
  diffCheckpoint(request: DesktopCheckpointRequest): Promise<FileCopyCheckpointDiff>;
  revertCheckpoint(request: DesktopCheckpointRequest): Promise<DesktopCheckpointRevertResult>;
};

export function getDesktopApi(): HtmlslideDesktopApi | undefined {
  return typeof window === "undefined" ? undefined : window.htmlslideDesktop;
}
