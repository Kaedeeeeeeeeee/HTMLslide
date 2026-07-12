import type {
  NewDeckDraft,
  NewDeckExportSelection,
  NewDeckSource,
  ProjectSummary,
  SlideSummary
} from "./model";
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
  FileCopyCheckpointRevertResult,
  VisualDirection
} from "@htmlslide/agent";

export type DesktopSetupState = {
  appName: string;
  version: string;
  platform: string;
  libraryPath: string;
  workspacePath: string;
  onboardingCompleted: boolean;
  initialOpen?: DesktopInitialOpenRequest;
  smoke?: {
    expectOpenDeckpkgPath?: string;
  };
  cli: {
    available: boolean;
    mode: "development" | "packaged" | "missing";
    rootPath?: string;
    cliPath?: string;
  };
  cliIntegration: DesktopCliIntegrationState;
  officialSkills: DesktopOfficialSkillsState;
};

export type DesktopInitialOpenRequest =
  | { kind: "deckpkg"; path: string; requestId: number }
  | { kind: "project"; path: string; requestId: number };

export type DesktopSmokeReadyMarker = {
  status: "passed" | "failed";
  kind: "startup" | "deckpkg-open";
  deckpkgPath?: string;
  expectedDeckpkgPath?: string;
  title?: string;
  slideCount?: number;
  error?: string;
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
};

export type DesktopProjectRecord = Omit<ProjectSummary, "lastOpened"> & {
  lastOpenedAt: string;
  thumbnail?: string;
};

export type DesktopProjectReference = {
  id?: string;
  path?: string;
};

export type DesktopExportOptions = NewDeckExportSelection;

export type DesktopSourceFileSelection = {
  kind: "file";
  name: string;
  path: string;
  size: number;
};

export type DesktopProjectPreview = {
  project: DesktopProjectRecord;
  slides: SlideSummary[];
};

export type DesktopSlidePreviewDocument = {
  projectRoot: string;
  slideId: string;
  title: string;
  sourcePath: string;
  notes: string;
  sourceDigest: string;
  viewport: {
    width: number;
    height: number;
  };
  htmlDocument: string;
};

export type DesktopSaveSlideNotesResult = {
  projectPath: string;
  slideId: string;
  notesPath: string;
  bytes: number;
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
  providerId: "external-agent";
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

export type DesktopAgentEngine = "mock-agent" | "htmlslide-agent" | "external-agent";

export type DesktopAgentRunRequest = {
  engine: DesktopAgentEngine;
  exportOptions?: DesktopExportOptions;
  projectPath: string;
  brief: string;
  targetSlideCount?: number;
  runExport?: boolean;
  maxRepairRounds?: number;
};

export type DesktopAgentRunResult =
  | DesktopMockAgentRunResult
  | DesktopByokAgentRunResult
  | DesktopExternalAgentRunResult;

export type DesktopAgentRunStatus =
  | "queued"
  | "running"
  | "awaiting-user-choice"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DesktopAgentRunSnapshot = {
  runId: string;
  projectPath: string;
  engine: DesktopAgentEngine;
  providerId?: DesktopAgentRunResult["providerId"];
  status: DesktopAgentRunStatus;
  sequence: number;
  startedAt: string;
  completedAt?: string;
  canCancel: boolean;
  canRetry: boolean;
  canPause: false;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  pendingVisualDirections?: VisualDirection[];
  result?: DesktopAgentRunResult;
  error?: string;
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

export type DesktopAudienceSlidePayload = {
  deckTitle: string;
  slideId: string;
  slideTitle: string;
  slideNumber: number;
  slideCount: number;
  screen: "normal" | "black" | "white";
  sourceDocumentHtml?: string;
  imageDataUrl?: string;
  section?: string;
  accent?: string;
};

export type DesktopAudienceWindowRequest = {
  displayId?: number;
  payload: DesktopAudienceSlidePayload;
};

export type DesktopAudienceWindowState = {
  open: boolean;
  displayId?: number;
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
  completeOnboarding(): Promise<{ completed: true }>;
  getCliIntegration(): Promise<DesktopCliIntegrationState>;
  installCliIntegration(): Promise<DesktopCliIntegrationState>;
  installOfficialSkills(): Promise<DesktopOfficialSkillsState>;
  uninstallCliIntegration(): Promise<DesktopCliIntegrationState>;
  copyCliManualInstallCommand(): Promise<{ copied: boolean; command: string }>;
  copyAgentRepairPrompt(prompt: string): Promise<{ copied: boolean }>;
  listProjects(): Promise<DesktopProjectRecord[]>;
  removeRecentProject(project: DesktopProjectReference): Promise<DesktopProjectRecord[]>;
  markRecentProjectMissing(project: DesktopProjectReference): Promise<DesktopProjectRecord[]>;
  getAiEngineSettings(): Promise<AiEngineSettings>;
  saveAiEngineSettings(request: DesktopAiEngineSettingsSaveRequest): Promise<AiEngineSettings>;
  detectExternalAgents(): Promise<ExternalAgentStatus[]>;
  chooseSourceFiles(): Promise<DesktopSourceFileSelection[]>;
  chooseWorkspace(): Promise<string | undefined>;
  openProjectDialog(): Promise<DesktopProjectPreview | undefined>;
  loadProject(projectPath: string): Promise<DesktopProjectPreview>;
  loadSlidePreview(projectPath: string, slideId: string): Promise<DesktopSlidePreviewDocument>;
  saveSlideNotes(projectPath: string, slideId: string, content: string): Promise<DesktopSaveSlideNotesResult>;
  addQaIgnoreRule(projectPath: string, issueType: string): Promise<{ issueTypes: string[] }>;
  createProject(request: NewDeckDraft & { workspacePath?: string; sources?: NewDeckSource[] }): Promise<DesktopCliResult>;
  checkProject(projectPath: string): Promise<DesktopCliResult>;
  exportProject(projectPath: string, options?: DesktopExportOptions): Promise<DesktopCliResult>;
  loadPresenterDeck(projectPath: string): Promise<DesktopPresenterDeckResult>;
  loadPresenterDeckPackage(deckpkgPath: string): Promise<DesktopPresenterDeckResult>;
  onOpenRequest(handler: (request: DesktopInitialOpenRequest) => void): () => void;
  reportSmokeReady(marker: DesktopSmokeReadyMarker): Promise<{ ok: boolean }>;
  listPresenterDisplays(): Promise<DesktopPresenterDisplay[]>;
  onPresenterDisplaysChanged(handler: () => void): () => void;
  openAudienceWindow(request: DesktopAudienceWindowRequest): Promise<DesktopAudienceWindowState>;
  updateAudienceWindow(request: DesktopAudienceWindowRequest): Promise<DesktopAudienceWindowState>;
  closeAudienceWindow(): Promise<DesktopAudienceWindowState>;
  startAgentRun(request: DesktopAgentRunRequest): Promise<DesktopAgentRunSnapshot>;
  getAgentRun(runId: string): Promise<DesktopAgentRunSnapshot | undefined>;
  getActiveAgentRun(projectPath: string): Promise<DesktopAgentRunSnapshot | undefined>;
  cancelAgentRun(runId: string): Promise<DesktopAgentRunSnapshot>;
  chooseVisualDirection(runId: string, directionId: string): Promise<DesktopAgentRunSnapshot>;
  retryAgentRun(runId: string): Promise<DesktopAgentRunSnapshot>;
  onAgentRunUpdate(handler: (snapshot: DesktopAgentRunSnapshot) => void): () => void;
  diffCheckpoint(request: DesktopCheckpointRequest): Promise<FileCopyCheckpointDiff>;
  revertCheckpoint(request: DesktopCheckpointRequest): Promise<DesktopCheckpointRevertResult>;
};

export function getDesktopApi(): HtmlslideDesktopApi | undefined {
  return typeof window === "undefined" ? undefined : window.htmlslideDesktop;
}
