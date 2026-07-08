import type { NewDeckDraft, ProjectSummary, SlideSummary } from "./model";
import type { AiEngineSettings, ExternalAgentStatus } from "./settings-model";
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
  cli: {
    available: boolean;
    mode: "development" | "packaged" | "missing";
    rootPath?: string;
    cliPath?: string;
  };
  cliIntegration: DesktopCliIntegrationState;
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

export type DesktopCheckpointRequest = {
  projectPath: string;
  runId?: string;
  checkpointId?: string;
  confirmed?: boolean;
};

export type DesktopCheckpointRevertResult = FileCopyCheckpointRevertResult & {
  project?: DesktopProjectPreview;
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
  saveAiEngineSettings(settings: AiEngineSettings): Promise<AiEngineSettings>;
  detectExternalAgents(): Promise<ExternalAgentStatus[]>;
  chooseWorkspace(): Promise<string | undefined>;
  openProjectDialog(): Promise<DesktopProjectPreview | undefined>;
  loadProject(projectPath: string): Promise<DesktopProjectPreview>;
  createProject(request: NewDeckDraft & { workspacePath?: string }): Promise<DesktopCliResult>;
  checkProject(projectPath: string): Promise<DesktopCliResult>;
  exportProject(projectPath: string): Promise<DesktopCliResult>;
  runMockAgent(request: DesktopMockAgentRunRequest): Promise<DesktopMockAgentRunResult>;
  diffCheckpoint(request: DesktopCheckpointRequest): Promise<FileCopyCheckpointDiff>;
  revertCheckpoint(request: DesktopCheckpointRequest): Promise<DesktopCheckpointRevertResult>;
};

export function getDesktopApi(): HtmlslideDesktopApi | undefined {
  return typeof window === "undefined" ? undefined : window.htmlslideDesktop;
}
