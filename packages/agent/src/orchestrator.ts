import { AgentRunCancelledError, AgentRunFailureError, errorMessage, isCancellationError } from "./errors.js";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentExportResult,
  AgentLogLevel,
  AgentOutline,
  AgentRepairResult,
  AgentReviewResult,
  AgentRunErrorInfo,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunInput,
  AgentRunLog,
  AgentRunOutputs,
  AgentRunResult,
  AgentRunSnapshot,
  AgentRunStage,
  AgentRunState,
  AgentRunStatus,
  AgentOrchestratorOptions,
  CheckpointMetadata,
  JsonObject,
  ModelProvider,
  NormalizedBrief,
  VisualDirection,
  VisualDirectionSet
} from "./types.js";

export const defaultAgentStages: AgentRunStage[] = [
  "brief",
  "outline",
  "visual-direction",
  "build",
  "check",
  "repair",
  "export",
  "review"
];

export const agentRunStateTransitions: Record<AgentRunState, AgentRunState[]> = {
  idle: ["briefing", "cancelled"],
  briefing: ["planning", "failed", "cancelled"],
  planning: ["visual_direction", "failed", "cancelled"],
  visual_direction: ["awaiting_user_choice", "building", "failed", "cancelled"],
  awaiting_user_choice: ["building", "failed", "cancelled"],
  building: ["checking", "failed", "cancelled"],
  checking: ["repairing", "exporting", "failed", "cancelled"],
  repairing: ["checking", "failed", "cancelled"],
  exporting: ["reviewing", "failed", "cancelled"],
  reviewing: ["completed", "failed", "cancelled"],
  failed: [],
  completed: [],
  cancelled: []
};

const stageStates: Record<AgentRunStage, AgentRunState> = {
  brief: "briefing",
  outline: "planning",
  "visual-direction": "visual_direction",
  build: "building",
  check: "checking",
  repair: "repairing",
  export: "exporting",
  review: "reviewing"
};

const terminalStatuses = new Set<AgentRunStatus>(["succeeded", "failed", "cancelled"]);

let nextRunNumber = 1;

export const canTransitionAgentRunState = (from: AgentRunState, to: AgentRunState): boolean =>
  from === to || agentRunStateTransitions[from].includes(to);

export const createAgentRunId = (): string => {
  const runId = `run-${String(nextRunNumber).padStart(4, "0")}`;
  nextRunNumber += 1;
  return runId;
};

export const createCheckpointMetadata = (input: {
  runId: string;
  projectRoot: string;
  createdAt: string;
}): CheckpointMetadata => ({
  id: `checkpoint-${input.runId}`,
  runId: input.runId,
  projectRoot: input.projectRoot,
  strategy: "metadata-only",
  createdAt: input.createdAt,
  label: `Before agent run ${input.runId}`,
  sourceRoots: ["deck.json", "slides/", "notes/", "theme/", "assets/"],
  files: [],
  restore: {
    canRevert: false,
    notes: "Metadata-only checkpoint. Future git-diff or file-copy adapters should populate reversible file snapshots."
  }
});

const emptyOutputs = (): AgentRunOutputs => ({
  checks: [],
  repairs: []
});

const checkHasErrors = (check: AgentCheckResult): boolean => check.summary.errors > 0;

const firstVisualDirectionId = (directions: VisualDirection[]): string => {
  const first = directions[0];
  if (first === undefined) {
    throw new AgentRunFailureError({
      code: "invalid-output",
      message: "Visual direction stage returned no directions.",
      stage: "visual-direction"
    });
  }

  return first.id;
};

const filesChangedForOutput = (output: unknown): string[] | undefined => {
  if (typeof output !== "object" || output === null || !("filesChanged" in output)) {
    return undefined;
  }

  const value = (output as { filesChanged?: unknown }).filesChanged;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
};

const issuesFoundForOutput = (output: unknown): number | undefined => {
  if (typeof output !== "object" || output === null || !("issues" in output)) {
    return undefined;
  }

  const value = (output as { issues?: unknown }).issues;
  return Array.isArray(value) ? value.length : undefined;
};

const cloneOutputs = (outputs: AgentRunOutputs): AgentRunOutputs => ({
  ...outputs,
  checks: [...outputs.checks],
  repairs: [...outputs.repairs]
});

export class AgentRunController {
  readonly runId: string;
  readonly done: Promise<AgentRunResult>;

  readonly #input: AgentRunInput;
  readonly #clock: () => Date;
  readonly #abortController = new AbortController();
  readonly #events: AgentRunEvent[] = [];
  readonly #logs: AgentRunLog[] = [];
  readonly #maxRepairRounds: number;

  #sequence = 0;
  #cancelled = false;
  #cancelEventEmitted = false;
  #snapshot: AgentRunSnapshot;

  constructor(input: AgentRunInput, options: AgentOrchestratorOptions = {}) {
    this.#input = input;
    this.#clock = options.clock ?? (() => new Date());
    this.#maxRepairRounds = input.maxRepairRounds ?? options.defaultMaxRepairRounds ?? 3;
    this.runId = input.runId ?? createAgentRunId();
    this.#snapshot = {
      runId: this.runId,
      projectRoot: input.projectRoot,
      providerId: input.provider.id,
      status: "queued",
      state: "idle",
      repairAttempts: 0,
      maxRepairRounds: this.#maxRepairRounds,
      outputs: emptyOutputs(),
      events: this.#events,
      logs: this.#logs
    };
    this.done = this.#execute();
  }

  cancel(reason = "Run cancelled by user."): void {
    if (terminalStatuses.has(this.#snapshot.status)) {
      return;
    }

    this.#cancelled = true;
    this.#snapshot.status = "cancelled";
    this.#snapshot.state = "cancelled";
    this.#snapshot.cancelledAt = this.#now();
    this.#snapshot.cancellationReason = reason;
    this.#snapshot.error = {
      code: "cancelled",
      message: reason,
      stage: this.#snapshot.currentStage
    };
    this.#abortController.abort();
    this.#emitCancelled(reason);
  }

  getStatus(): AgentRunSnapshot {
    return {
      ...this.#snapshot,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
  }

  async #execute(): Promise<AgentRunResult> {
    this.#snapshot.status = "running";
    this.#snapshot.startedAt = this.#now();
    this.#emit("run-created", "brief", "running", "Agent run created.");

    try {
      this.#throwIfCancelled();
      await this.#createCheckpoint();

      const brief = await this.#runStage<NormalizedBrief>("brief", "Normalize the user brief.", {
        brief: this.#input.brief,
        metadata: this.#input.metadata
      });
      this.#snapshot.outputs.brief = brief;

      const outline = await this.#runStage<AgentOutline>("outline", "Generate deck outline.", {
        brief,
        metadata: this.#input.metadata
      });
      this.#snapshot.outputs.outline = outline;

      const visualDirection = await this.#runStage<VisualDirectionSet>(
        "visual-direction",
        "Generate visual directions.",
        {
          brief,
          outline
        }
      );
      const selectedVisualDirectionId = await this.#selectVisualDirection(visualDirection);
      this.#snapshot.outputs.visualDirection = {
        ...visualDirection,
        selectedDirectionId: selectedVisualDirectionId
      };
      this.#snapshot.outputs.selectedVisualDirectionId = selectedVisualDirectionId;

      const build = await this.#runStage<AgentBuildResult>("build", "Build deck source files.", {
        brief,
        outline,
        selectedVisualDirectionId
      });
      this.#snapshot.outputs.build = build;

      let latestCheck = await this.#runCheck();
      while (checkHasErrors(latestCheck) && this.#snapshot.repairAttempts < this.#maxRepairRounds) {
        const attempt = this.#snapshot.repairAttempts + 1;
        const repair = await this.#runStage<AgentRepairResult>("repair", "Repair check issues.", {
          attempt,
          check: latestCheck,
          maxRepairRounds: this.#maxRepairRounds
        });
        this.#snapshot.repairAttempts = attempt;
        this.#snapshot.outputs.repairs.push({
          ...repair,
          attempt
        });
        latestCheck = await this.#runCheck();
      }

      if (checkHasErrors(latestCheck)) {
        throw new AgentRunFailureError({
          code: "check-failed",
          stage: "check",
          message: `Check still has ${latestCheck.summary.errors} error(s) after ${this.#snapshot.repairAttempts} repair attempt(s).`
        });
      }

      const exportResult = await this.#runStage<AgentExportResult>("export", "Export checked deck artifacts.", {
        build,
        check: latestCheck
      });
      this.#snapshot.outputs.export = exportResult;

      const review = await this.#runStage<AgentReviewResult>("review", "Prepare human review summary.", {
        build,
        check: latestCheck,
        export: exportResult
      });
      this.#snapshot.outputs.review = review;

      this.#transition("completed");
      this.#snapshot.status = "succeeded";
      this.#snapshot.completedAt = this.#now();
      this.#emit("run-completed", "review", "succeeded", "Agent run completed.");

      return {
        ok: true,
        status: "succeeded",
        runId: this.runId,
        checkpoint: this.#snapshot.checkpoint,
        outputs: cloneOutputs(this.#snapshot.outputs),
        events: [...this.#events],
        logs: [...this.#logs]
      };
    } catch (error) {
      if (this.#cancelled || isCancellationError(error)) {
        return this.#finishCancelled(errorMessage(error));
      }

      const info =
        error instanceof AgentRunFailureError
          ? error.info
          : ({
              code: "unknown",
              message: errorMessage(error),
              stage: this.#snapshot.currentStage
            } satisfies AgentRunErrorInfo);
      return this.#finishFailed(info);
    }
  }

  async #createCheckpoint(): Promise<void> {
    const createdAt = this.#now();
    const checkpoint =
      (await this.#input.createCheckpoint?.({
        runId: this.runId,
        projectRoot: this.#input.projectRoot,
        createdAt
      })) ??
      createCheckpointMetadata({
        runId: this.runId,
        projectRoot: this.#input.projectRoot,
        createdAt
      });

    this.#snapshot.checkpoint = checkpoint;
    this.#emit("checkpoint-created", "brief", "running", "Checkpoint metadata created.", {
      checkpointId: checkpoint.id,
      metadata: {
        strategy: checkpoint.strategy
      }
    });
    this.#log("info", "Checkpoint metadata created.", "brief", {
      checkpointId: checkpoint.id,
      strategy: checkpoint.strategy
    });
  }

  async #selectVisualDirection(visualDirection: VisualDirectionSet): Promise<string> {
    const existingSelection = visualDirection.selectedDirectionId ?? firstVisualDirectionId(visualDirection.directions);

    if (this.#input.chooseVisualDirection === undefined) {
      this.#emit("user-choice-selected", "visual-direction", "running", "Visual direction auto-selected.", {
        metadata: {
          visualDirectionId: existingSelection
        }
      });
      return existingSelection;
    }

    this.#transition("awaiting_user_choice");
    this.#emit("user-choice-requested", "visual-direction", "running", "Waiting for visual direction choice.");
    const selected = await this.#input.chooseVisualDirection(visualDirection.directions);
    this.#throwIfCancelled();
    this.#emit("user-choice-selected", "visual-direction", "running", "Visual direction selected.", {
      metadata: {
        visualDirectionId: selected
      }
    });
    return selected;
  }

  async #runCheck(): Promise<AgentCheckResult> {
    const check = await this.#runStage<AgentCheckResult>("check", "Run deck checks.", {
      build: this.#snapshot.outputs.build,
      repairs: this.#snapshot.outputs.repairs
    });
    this.#snapshot.outputs.checks.push(check);
    return check;
  }

  async #runStage<TOutput>(stage: AgentRunStage, prompt: string, input: unknown): Promise<TOutput> {
    this.#throwIfCancelled(stage);
    this.#transition(stageStates[stage]);
    this.#snapshot.currentStage = stage;
    this.#emit("stage-started", stage, "running", `${stage} started.`);
    this.#log("info", `${stage} started.`, stage);

    try {
      const response = await this.#input.provider.complete({
        runId: this.runId,
        stage,
        prompt,
        input,
        metadata: this.#input.metadata,
        signal: this.#abortController.signal
      });
      this.#throwIfCancelled(stage);
      this.#emit("stage-completed", stage, "succeeded", response.content, {
        filesChanged: filesChangedForOutput(response.output),
        issuesFound: issuesFoundForOutput(response.output)
      });
      this.#log("info", response.content, stage);
      return response.output as TOutput;
    } catch (error) {
      if (this.#cancelled || isCancellationError(error)) {
        throw error;
      }

      const info: AgentRunErrorInfo = {
        code: "provider-error",
        stage,
        message: errorMessage(error)
      };
      this.#emit("stage-failed", stage, "failed", info.message);
      this.#log("error", info.message, stage);
      throw new AgentRunFailureError(info);
    }
  }

  #throwIfCancelled(stage = this.#snapshot.currentStage): void {
    if (this.#cancelled || this.#abortController.signal.aborted) {
      throw new AgentRunCancelledError(this.#snapshot.cancellationReason ?? "Run cancelled by user.", stage);
    }
  }

  #finishFailed(error: AgentRunErrorInfo): AgentRunResult {
    this.#transition("failed");
    this.#snapshot.status = "failed";
    this.#snapshot.completedAt = this.#now();
    this.#snapshot.error = error;
    this.#emit("run-failed", error.stage ?? this.#snapshot.currentStage ?? "review", "failed", error.message);

    return {
      ok: false,
      status: "failed",
      runId: this.runId,
      checkpoint: this.#snapshot.checkpoint,
      error,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
  }

  #finishCancelled(message: string): AgentRunResult {
    this.#snapshot.status = "cancelled";
    this.#snapshot.state = "cancelled";
    this.#snapshot.cancelledAt ??= this.#now();
    this.#snapshot.completedAt = this.#now();
    this.#snapshot.error = {
      code: "cancelled",
      message,
      stage: this.#snapshot.currentStage
    };
    this.#emitCancelled(message);

    return {
      ok: false,
      status: "cancelled",
      runId: this.runId,
      checkpoint: this.#snapshot.checkpoint,
      error: this.#snapshot.error,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
  }

  #emitCancelled(message: string): void {
    if (this.#cancelEventEmitted) {
      return;
    }

    this.#cancelEventEmitted = true;
    this.#emit("run-cancelled", this.#snapshot.currentStage ?? "brief", "cancelled", message);
    this.#log("warning", message, this.#snapshot.currentStage);
  }

  #transition(nextState: AgentRunState): void {
    if (!canTransitionAgentRunState(this.#snapshot.state, nextState)) {
      this.#log("warning", `Unexpected agent state transition ${this.#snapshot.state} -> ${nextState}.`);
    }
    this.#snapshot.state = nextState;
  }

  #emit(
    type: AgentRunEventType,
    stage: AgentRunStage,
    status: AgentRunStatus,
    summary: string,
    extras: {
      filesChanged?: string[];
      issuesFound?: number;
      checkpointId?: string;
      metadata?: JsonObject;
    } = {}
  ): void {
    this.#sequence += 1;
    this.#events.push({
      runId: this.runId,
      sequence: this.#sequence,
      type,
      stage,
      status,
      summary,
      createdAt: this.#now(),
      filesChanged: extras.filesChanged,
      issuesFound: extras.issuesFound,
      checkpointId: extras.checkpointId,
      metadata: extras.metadata
    });
  }

  #log(level: AgentLogLevel, message: string, stage?: AgentRunStage, metadata?: JsonObject): void {
    this.#logs.push({
      runId: this.runId,
      stage,
      level,
      message,
      createdAt: this.#now(),
      metadata
    });
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

export class AgentOrchestrator {
  readonly #options: AgentOrchestratorOptions;

  constructor(options: AgentOrchestratorOptions = {}) {
    this.#options = options;
  }

  startRun(input: AgentRunInput): AgentRunController {
    return new AgentRunController(input, this.#options);
  }
}

export const startAgentRun = (input: AgentRunInput, options?: AgentOrchestratorOptions): AgentRunController =>
  new AgentOrchestrator(options).startRun(input);

export const runAgent = async (
  input: AgentRunInput,
  options?: AgentOrchestratorOptions
): Promise<AgentRunResult> => startAgentRun(input, options).done;

export const modelProviderToEngine = (
  provider: ModelProvider,
  mode: "byok" | "external" | "mock" = "byok",
  available = true
) => ({
  id: provider.id,
  label: provider.label,
  mode,
  available
});
