import {
  AgentRunCancelledError,
  AgentRunFailureError,
  AgentRunTimeoutError,
  errorMessage,
  isCancellationError
} from "./errors.js";
import { createFileCopyCheckpoint } from "./checkpoint.js";
import { DEFAULT_SPEAKER_NOTES_MODE, normalizeSpeakerNotesMode, type SpeakerNotesMode } from "@htmlslide/core";
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

export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

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

const countSensitiveStages = new Set<AgentRunStage>(["brief", "outline", "visual-direction", "build", "check", "repair"]);

let nextRunNumber = 1;

export const canTransitionAgentRunState = (from: AgentRunState, to: AgentRunState): boolean =>
  from === to || agentRunStateTransitions[from].includes(to);

export const createAgentRunId = (): string => {
  const runId = `run-${String(nextRunNumber).padStart(4, "0")}`;
  nextRunNumber += 1;
  return runId;
};

const emptyOutputs = (speakerNotesMode: SpeakerNotesMode): AgentRunOutputs => ({
  checks: [],
  repairs: [],
  speakerNotesMode
});

const checkHasErrors = (check: AgentCheckResult): boolean =>
  check.status !== "passed" || check.summary.errors > 0;

const checkFailureMessage = (check: AgentCheckResult, repairAttempts: number): string =>
  `Check failed with status "${check.status === "passed" ? "passed" : "failed"}": ${check.summary.errors} error(s), ` +
  `${check.summary.warnings} warning(s), and ${check.summary.info} info item(s) ` +
  `after ${repairAttempts} repair attempt(s).`;

const validateExportResult = (exportResult: AgentExportResult): void => {
  if (
    typeof exportResult !== "object" ||
    exportResult === null ||
    !Array.isArray(exportResult.artifacts) ||
    exportResult.artifacts.length === 0
  ) {
    throw new AgentRunFailureError({
      code: "export-failed",
      message: "Export returned no artifacts.",
      stage: "export"
    });
  }
};

const normalizeRunTimeoutMs = (value: number | undefined, fallback: number | undefined): number => {
  const timeoutMs = value ?? fallback ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Agent run timeout must be a finite number greater than zero.");
  }
  return Math.max(1, Math.floor(timeoutMs));
};

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

const withTargetSlideCount = <TInput extends Record<string, unknown>>(
  input: TInput,
  targetSlideCount: number | undefined
): TInput & { targetSlideCount?: number } => {
  if (targetSlideCount === undefined) {
    return input;
  }

  return {
    ...input,
    targetSlideCount
  };
};

const withSpeakerNotesMode = <TInput extends Record<string, unknown>>(
  input: TInput,
  speakerNotesMode: SpeakerNotesMode
): TInput & { speakerNotesMode: SpeakerNotesMode } => ({
  ...input,
  speakerNotesMode
});

const validateOutline = (outline: AgentOutline, targetSlideCount: number | undefined): void => {
  if (outline.slides.length === 0) {
    throw new AgentRunFailureError({
      code: "invalid-output",
      message: "Outline stage returned no slides.",
      stage: "outline"
    });
  }

  if (targetSlideCount !== undefined && outline.slides.length !== targetSlideCount) {
    throw new AgentRunFailureError({
      code: "invalid-output",
      message: `Outline stage returned ${outline.slides.length} slide(s); expected exactly ${targetSlideCount}.`,
      stage: "outline"
    });
  }
};

const validateVisualDirections = (visualDirection: VisualDirectionSet): void => {
  if (visualDirection.directions.length === 0) {
    throw new AgentRunFailureError({
      code: "invalid-output",
      message: "Visual direction stage returned no directions.",
      stage: "visual-direction"
    });
  }
};

export class AgentRunController {
  readonly runId: string;
  readonly done: Promise<AgentRunResult>;

  readonly #input: AgentRunInput;
  readonly #clock: () => Date;
  readonly #abortController = new AbortController();
  readonly #events: AgentRunEvent[] = [];
  readonly #logs: AgentRunLog[] = [];
  readonly #maxRepairRounds: number;
  readonly #runTimeoutMs: number;
  readonly #onEvent: AgentOrchestratorOptions["onEvent"];
  readonly #onLog: AgentOrchestratorOptions["onLog"];
  readonly #speakerNotesMode: SpeakerNotesMode;

  #sequence = 0;
  #cancelled = false;
  #cancelEventEmitted = false;
  #timedOut = false;
  #terminalResult: AgentRunResult | undefined;
  #snapshot: AgentRunSnapshot;
  #checkpointStartup: Promise<void> | undefined;

  constructor(input: AgentRunInput, options: AgentOrchestratorOptions = {}) {
    this.#input = input;
    this.#clock = options.clock ?? (() => new Date());
    this.#maxRepairRounds = input.maxRepairRounds ?? options.defaultMaxRepairRounds ?? 3;
    this.#runTimeoutMs = normalizeRunTimeoutMs(input.runTimeoutMs, options.defaultRunTimeoutMs);
    this.#onEvent = options.onEvent;
    this.#onLog = options.onLog;
    this.#speakerNotesMode = normalizeSpeakerNotesMode(input.speakerNotesMode ?? DEFAULT_SPEAKER_NOTES_MODE);
    this.runId = input.runId ?? createAgentRunId();
    this.#snapshot = {
      runId: this.runId,
      projectRoot: input.projectRoot,
      providerId: input.provider.id,
      status: "queued",
      state: "idle",
      repairAttempts: 0,
      maxRepairRounds: this.#maxRepairRounds,
      outputs: emptyOutputs(this.#speakerNotesMode),
      events: this.#events,
      logs: this.#logs
    };
    this.done = this.#executeWithTimeout();
  }

  cancel(reason = "Run cancelled by user."): void {
    if (terminalStatuses.has(this.#snapshot.status)) {
      return;
    }

    const safeReason = errorMessage(reason);
    this.#cancelled = true;
    this.#snapshot.status = "cancelled";
    this.#snapshot.state = "cancelled";
    this.#snapshot.cancelledAt = this.#now();
    this.#snapshot.cancellationReason = safeReason;
    this.#snapshot.error = {
      code: "cancelled",
      message: safeReason,
      stage: this.#snapshot.currentStage
    };
    this.#abortController.abort();
    this.#emitCancelled(safeReason);
  }

  getStatus(): AgentRunSnapshot {
    return {
      ...this.#snapshot,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
  }

  async #executeWithTimeout(): Promise<AgentRunResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<AgentRunResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (this.#snapshot.status === "cancelled") {
          resolve(this.#finishCancelled(this.#snapshot.cancellationReason ?? "Run cancelled by user."));
          return;
        }

        this.#timedOut = true;
        const timeoutError = new AgentRunTimeoutError(this.#runTimeoutMs, this.#snapshot.currentStage ?? "brief");
        this.#abortController.abort();
        const finishTimeout = (): void => resolve(this.#finishFailed({
          code: "timeout",
          message: timeoutError.message,
          stage: timeoutError.stage,
          timeoutMs: timeoutError.timeoutMs
        }));

        // Checkpoint creation is local work that may still be writing the project
        // runtime when the deadline fires. Let it settle before exposing the
        // timeout result, while provider stages still return immediately.
        if (this.#checkpointStartup !== undefined) {
          void this.#checkpointStartup.then(finishTimeout, finishTimeout);
        } else {
          finishTimeout();
        }
      }, this.#runTimeoutMs);
    });

    try {
      return await Promise.race([this.#execute(), timeoutResult]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async #execute(): Promise<AgentRunResult> {
    this.#snapshot.status = "running";
    this.#snapshot.startedAt = this.#now();
    this.#emit("run-created", "brief", "running", "Agent run created.");

    try {
      this.#throwIfCancelled();
      const checkpointStartup = this.#createCheckpoint();
      this.#checkpointStartup = checkpointStartup;
      try {
        await checkpointStartup;
      } finally {
        if (this.#checkpointStartup === checkpointStartup) {
          this.#checkpointStartup = undefined;
        }
      }

      const brief = await this.#runStage<NormalizedBrief>("brief", "Normalize the user brief.", {
        brief: this.#input.brief,
        metadata: this.#input.metadata
      });
      this.#snapshot.outputs.brief = brief;

      const outline = await this.#runStage<AgentOutline>("outline", "Generate deck outline.", {
        brief,
        metadata: this.#input.metadata
      }, (output) => validateOutline(output, this.#input.targetSlideCount));
      this.#snapshot.outputs.outline = outline;

      const visualDirection = await this.#runStage<VisualDirectionSet>(
        "visual-direction",
        "Generate visual directions.",
        {
          brief,
          outline
        },
        validateVisualDirections
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
          message: checkFailureMessage(latestCheck, this.#snapshot.repairAttempts)
        });
      }

      const exportResult = await this.#runStage<AgentExportResult>("export", "Export checked deck artifacts.", {
        build,
        check: latestCheck
      }, validateExportResult);
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

      const result: AgentRunResult = {
        ok: true,
        status: "succeeded",
        runId: this.runId,
        checkpoint: this.#snapshot.checkpoint,
        outputs: cloneOutputs(this.#snapshot.outputs),
        events: [...this.#events],
        logs: [...this.#logs]
      };
      this.#terminalResult = result;
      return result;
    } catch (error) {
      if (this.#timedOut) {
        return this.#finishFailed(this.#timeoutErrorInfo());
      }

      if (this.#cancelled || isCancellationError(error)) {
        return this.#finishCancelled(errorMessage(error));
      }

      const info =
        error instanceof AgentRunFailureError
          ? {
              ...error.info,
              message: errorMessage(error.info.message)
            }
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
    const checkpointInput = {
        runId: this.runId,
        projectRoot: this.#input.projectRoot,
        createdAt
    };
    const checkpoint = await (this.#input.createCheckpoint === undefined
      ? createFileCopyCheckpoint(checkpointInput)
      : this.#input.createCheckpoint(checkpointInput));

    this.#snapshot.checkpoint = checkpoint;
    this.#emit("checkpoint-created", "brief", "running", "Checkpoint created.", {
      checkpointId: checkpoint.id,
      metadata: {
        strategy: checkpoint.strategy
      }
    });
    this.#log("info", "Checkpoint created.", "brief", {
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

  async #runStage<TOutput>(
    stage: AgentRunStage,
    prompt: string,
    input: Record<string, unknown>,
    validateOutput?: (output: TOutput) => void
  ): Promise<TOutput> {
    this.#throwIfCancelled(stage);
    this.#transition(stageStates[stage]);
    this.#snapshot.currentStage = stage;
    this.#emit("stage-started", stage, "running", `${stage} started.`);
    this.#log("info", `${stage} started.`, stage);

    try {
      const response = await this.#input.provider.complete({
        runId: this.runId,
        stage,
        prompt: this.#promptForStage(stage, prompt),
        input: withTargetSlideCount(withSpeakerNotesMode(input, this.#speakerNotesMode), this.#input.targetSlideCount),
        metadata: withTargetSlideCount(
          withSpeakerNotesMode(this.#input.metadata ?? {}, this.#speakerNotesMode),
          this.#input.targetSlideCount
        ),
        signal: this.#abortController.signal
      });
      this.#throwIfCancelled(stage);
      const output = response.output as TOutput;
      validateOutput?.(output);
      this.#emit("stage-completed", stage, "succeeded", response.content, {
        filesChanged: filesChangedForOutput(output),
        issuesFound: issuesFoundForOutput(output)
      });
      this.#log("info", response.content, stage);
      return output;
    } catch (error) {
      if (this.#cancelled || isCancellationError(error)) {
        throw error;
      }

      if (error instanceof AgentRunFailureError) {
        const info: AgentRunErrorInfo = {
          ...error.info,
          message: errorMessage(error.info.message)
        };
        this.#emit("stage-failed", stage, "failed", info.message);
        this.#log("error", info.message, stage);
        throw new AgentRunFailureError(info);
      }

      const code: AgentRunErrorInfo["code"] = stage === "check"
        ? "check-failed"
        : stage === "export"
          ? "export-failed"
          : "provider-error";
      const detail = errorMessage(error);
      const info: AgentRunErrorInfo = {
        code,
        stage,
        message: `${this.#input.provider.label} failed during ${stage}${detail ? `: ${detail}` : "."}`
      };
      this.#emit("stage-failed", stage, "failed", info.message);
      this.#log("error", info.message, stage);
      throw new AgentRunFailureError(info);
    }
  }

  #promptForStage(stage: AgentRunStage, prompt: string): string {
    const targetSlideCount = this.#input.targetSlideCount;
    if (targetSlideCount === undefined || !countSensitiveStages.has(stage)) {
      return prompt;
    }

    return `${prompt} The deck must contain exactly ${targetSlideCount} slide(s).`;
  }

  #throwIfCancelled(stage = this.#snapshot.currentStage): void {
    if (this.#cancelled || this.#abortController.signal.aborted) {
      throw new AgentRunCancelledError(this.#snapshot.cancellationReason ?? "Run cancelled by user.", stage);
    }
  }

  #timeoutErrorInfo(): AgentRunErrorInfo {
    const timeoutError = new AgentRunTimeoutError(this.#runTimeoutMs, this.#snapshot.currentStage ?? "brief");
    return {
      code: "timeout",
      message: timeoutError.message,
      stage: timeoutError.stage,
      timeoutMs: timeoutError.timeoutMs
    };
  }

  #finishFailed(error: AgentRunErrorInfo): AgentRunResult {
    if (this.#terminalResult !== undefined) {
      return this.#terminalResult;
    }

    this.#transition("failed");
    this.#snapshot.status = "failed";
    this.#snapshot.completedAt = this.#now();
    this.#snapshot.error = error;
    this.#emit("run-failed", error.stage ?? this.#snapshot.currentStage ?? "review", "failed", error.message);

    const result: AgentRunResult = {
      ok: false,
      status: "failed",
      runId: this.runId,
      checkpoint: this.#snapshot.checkpoint,
      error,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
    this.#terminalResult = result;
    return result;
  }

  #finishCancelled(message: string): AgentRunResult {
    if (this.#terminalResult !== undefined) {
      return this.#terminalResult;
    }

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

    const result: AgentRunResult = {
      ok: false,
      status: "cancelled",
      runId: this.runId,
      checkpoint: this.#snapshot.checkpoint,
      error: this.#snapshot.error,
      outputs: cloneOutputs(this.#snapshot.outputs),
      events: [...this.#events],
      logs: [...this.#logs]
    };
    this.#terminalResult = result;
    return result;
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
    const event: AgentRunEvent = {
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
    };
    this.#events.push(event);
    this.#notifyObserver(this.#onEvent, event);
  }

  #log(level: AgentLogLevel, message: string, stage?: AgentRunStage, metadata?: JsonObject): void {
    const log: AgentRunLog = {
      runId: this.runId,
      stage,
      level,
      message,
      createdAt: this.#now(),
      metadata
    };
    this.#logs.push(log);
    this.#notifyObserver(this.#onLog, log);
  }

  #notifyObserver<T>(observer: ((record: T) => void | Promise<void>) | undefined, record: T): void {
    try {
      if (observer !== undefined) {
        void Promise.resolve(observer(record)).catch(() => undefined);
      }
    } catch {
      // Observer failures must not affect the run or recursively create logs.
    }
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
