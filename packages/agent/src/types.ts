import type { CHECKPOINT_SCHEMA_VERSION } from "@htmlslide/core/version";
import type { SpeakerNotesMode } from "@htmlslide/core";

export type AgentRunStage =
  | "brief"
  | "outline"
  | "visual-direction"
  | "build"
  | "check"
  | "repair"
  | "export"
  | "review";

export type AgentRunState =
  | "idle"
  | "briefing"
  | "planning"
  | "visual_direction"
  | "awaiting_user_choice"
  | "building"
  | "checking"
  | "repairing"
  | "exporting"
  | "reviewing"
  | "failed"
  | "completed"
  | "cancelled";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type AgentRunEventType =
  | "run-created"
  | "checkpoint-created"
  | "stage-started"
  | "stage-completed"
  | "stage-failed"
  | "run-completed"
  | "run-failed"
  | "run-cancelled"
  | "user-choice-requested"
  | "user-choice-selected";

export type AgentLogLevel = "debug" | "info" | "warning" | "error";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchema = JsonObject;

export type CredentialStatus =
  | {
      ok: true;
      providerId?: string;
      message?: string;
    }
  | {
      ok: false;
      providerId?: string;
      reason: string;
      recoverable?: boolean;
    };

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CostEstimate = {
  currency: string;
  estimatedMinorUnits: number;
  label?: string;
};

export type ModelRequest<TInput = unknown> = {
  runId: string;
  stage: AgentRunStage;
  prompt: string;
  input: TInput;
  metadata?: JsonObject;
  signal?: AbortSignal;
};

export type ModelResponse<TOutput = unknown> = {
  content: string;
  output: TOutput;
  metadata?: JsonObject;
  usage?: TokenUsage;
};

export type ModelStreamEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "metadata";
      metadata: JsonObject;
    }
  | {
      type: "done";
      response: ModelResponse;
    };

export type ModelProvider = {
  id: string;
  label: string;
  validateCredentials(): Promise<CredentialStatus>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  estimateCost?(request: ModelRequest): Promise<CostEstimate>;
};

export type ToolContext = {
  runId: string;
  projectRoot: string;
  signal?: AbortSignal;
  log(message: string, metadata?: JsonObject): void;
};

export type ToolResult<TOutput = unknown> = {
  ok: boolean;
  output?: TOutput;
  error?: string;
  filesChanged?: string[];
};

export type HTMLslideTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
};

export type AgentEngine = {
  id: string;
  label: string;
  mode: "byok" | "external" | "mock";
  available: boolean;
};

export type AgentRunEvent = {
  stage: AgentRunStage;
  status: AgentRunStatus;
  summary: string;
  createdAt: string;
  runId?: string;
  sequence?: number;
  type?: AgentRunEventType;
  filesChanged?: string[];
  issuesFound?: number;
  nextAction?: string;
  checkpointId?: string;
  metadata?: JsonObject;
};

export type AgentRunLog = {
  runId: string;
  stage?: AgentRunStage;
  level: AgentLogLevel;
  message: string;
  createdAt: string;
  metadata?: JsonObject;
};

export type CheckpointFileStatus = "unknown" | "added" | "modified" | "deleted" | "unchanged";

export type CheckpointFileOrigin = "snapshot" | "agent";

export type CheckpointFile = {
  path: string;
  status: CheckpointFileStatus;
  digest?: string;
  originalDigest?: string;
  currentDigest?: string;
  snapshotPath?: string;
  origin?: CheckpointFileOrigin;
};

export type CheckpointStrategy = "metadata-only" | "git-diff" | "file-copy";

export type CheckpointTextDiffLine = {
  type: "context" | "added" | "removed" | "omitted";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type CheckpointTextDiff = {
  path: string;
  status: Extract<CheckpointFileStatus, "added" | "modified" | "deleted">;
  language: "html" | "css" | "json" | "markdown" | "text";
  lines: CheckpointTextDiffLine[];
  truncated: boolean;
};

export type CheckpointMetadata = {
  id: string;
  runId: string;
  projectRoot: string;
  strategy: CheckpointStrategy;
  createdAt: string;
  label: string;
  sourceRoots: string[];
  files: CheckpointFile[];
  restore: {
    canRevert: boolean;
    notes: string;
  };
  schemaVersion?: typeof CHECKPOINT_SCHEMA_VERSION;
  updatedAt?: string;
  manifestPath?: string;
  snapshotRoot?: string;
};

export type CreateFileCopyCheckpointInput = {
  projectRoot: string;
  runId: string;
  createdAt?: string;
};

export type CheckpointReferenceInput = {
  projectRoot: string;
  runId?: string;
  checkpointId?: string;
};

export type RecordCheckpointChangesInput = CheckpointReferenceInput & {
  filesChanged: string[];
  recordedAt?: string;
};

export type FileCopyCheckpointDiff = {
  checkpoint: CheckpointMetadata;
  changed: CheckpointFile[];
  added: CheckpointFile[];
  deleted: CheckpointFile[];
  unchanged: CheckpointFile[];
  textDiffs: CheckpointTextDiff[];
  summary: {
    changed: number;
    added: number;
    deleted: number;
    unchanged: number;
  };
};

export type FileCopyCheckpointRevertResult = {
  checkpoint: CheckpointMetadata;
  restored: string[];
  deleted: string[];
  preserved: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
};

export type AgentOutlineSlide = {
  id: string;
  title: string;
  kind: "title" | "section" | "content" | "data" | "image" | "quote" | "closing" | "appendix" | "custom";
  goal: string;
};

export type AgentOutline = {
  title: string;
  language: string;
  audience: string;
  durationMinutes: number;
  slides: AgentOutlineSlide[];
};

export type VisualDirection = {
  id: string;
  label: string;
  rationale: string;
  sampleSlideIds: string[];
  sampleSlides?: VisualDirectionSample[];
  tokens: JsonObject;
};

export type VisualDirectionSample = {
  id: string;
  kind: "title" | "content" | "data";
  title: string;
  body: string;
  metric: string;
  chartValues: number[];
};

export type VisualDirectionSet = {
  directions: VisualDirection[];
  selectedDirectionId?: string;
};

export type AgentSourceWrite = {
  path: string;
  content: string;
};

export type AgentBuildResult = {
  filesChanged: string[];
  slidesChanged: string[];
  notesChanged: string[];
  themeChanged: string[];
  sourceWrites?: AgentSourceWrite[];
};

export type AgentCheckIssue = {
  severity: "error" | "warning" | "info";
  type: string;
  message: string;
  path?: string;
  slideId?: string;
  suggestedFix?: string;
};

export type AgentCheckSummary = {
  errors: number;
  warnings: number;
  info: number;
};

export type AgentCheckResult = {
  status: "passed" | "failed";
  summary: AgentCheckSummary;
  issues: AgentCheckIssue[];
};

export type AgentRepairResult = {
  attempt: number;
  filesChanged: string[];
  issuesAddressed: string[];
  sourceWrites?: AgentSourceWrite[];
};

export type AgentExportArtifact = {
  type: "pdf" | "html" | "deckpkg" | "thumbnails" | "speaker-notes";
  path: string;
};

export type AgentExportResult = {
  artifacts: AgentExportArtifact[];
};

export type AgentReviewResult = {
  summary: string;
  filesChanged: string[];
  issuesRemaining: number;
  nextActions: string[];
};

export type NormalizedBrief = {
  title: string;
  brief: string;
  language: string;
  audience: string;
  durationMinutes: number;
};

export type AgentRunOutputs = {
  brief?: NormalizedBrief;
  outline?: AgentOutline;
  visualDirection?: VisualDirectionSet;
  selectedVisualDirectionId?: string;
  build?: AgentBuildResult;
  checks: AgentCheckResult[];
  repairs: AgentRepairResult[];
  export?: AgentExportResult;
  review?: AgentReviewResult;
  usage?: TokenUsage;
  speakerNotesMode?: SpeakerNotesMode;
};

export type AgentRunErrorInfo = {
  message: string;
  stage?: AgentRunStage;
  code: "provider-error" | "check-failed" | "export-failed" | "timeout" | "cancelled" | "invalid-output" | "unknown";
  timeoutMs?: number;
};

export type AgentRunSnapshot = {
  runId: string;
  projectRoot: string;
  providerId: string;
  status: AgentRunStatus;
  state: AgentRunState;
  currentStage?: AgentRunStage;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  repairAttempts: number;
  maxRepairRounds: number;
  checkpoint?: CheckpointMetadata;
  error?: AgentRunErrorInfo;
  outputs: AgentRunOutputs;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
};

export type AgentRunSucceededResult = {
  ok: true;
  status: "succeeded";
  runId: string;
  checkpoint?: CheckpointMetadata;
  outputs: AgentRunOutputs;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
};

export type AgentRunFailedResult = {
  ok: false;
  status: "failed" | "cancelled";
  runId: string;
  checkpoint?: CheckpointMetadata;
  error: AgentRunErrorInfo;
  outputs: AgentRunOutputs;
  events: AgentRunEvent[];
  logs: AgentRunLog[];
};

export type AgentRunResult = AgentRunSucceededResult | AgentRunFailedResult;

export type AppliedMockAgentProjectSlide = {
  id: string;
  title: string;
  source: string;
  notes?: string;
};

export type ApplyMockAgentProjectInput = {
  projectPath: string;
  result: AgentRunResult;
  brief?: string;
};

export type ApplyMockAgentProjectResult = {
  projectPath: string;
  title: string;
  language: string;
  selectedVisualDirectionId?: string;
  filesChanged: string[];
  slideIds: string[];
  slides: AppliedMockAgentProjectSlide[];
  paths: {
    deck: "deck.json";
    slides: string[];
    notes: string[];
    theme: string[];
  };
};

export type AgentRunInput = {
  projectRoot: string;
  brief: string;
  provider: ModelProvider;
  targetSlideCount?: number;
  runId?: string;
  maxRepairRounds?: number;
  runTimeoutMs?: number;
  metadata?: JsonObject;
  speakerNotesMode?: SpeakerNotesMode;
  chooseVisualDirection?: (directions: VisualDirection[]) => Promise<string> | string;
  createCheckpoint?: (input: {
    runId: string;
    projectRoot: string;
    createdAt: string;
  }) => Promise<CheckpointMetadata> | CheckpointMetadata;
};

export type AgentOrchestratorOptions = {
  clock?: () => Date;
  defaultMaxRepairRounds?: number;
  defaultRunTimeoutMs?: number;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  onLog?: (log: AgentRunLog) => void | Promise<void>;
};
