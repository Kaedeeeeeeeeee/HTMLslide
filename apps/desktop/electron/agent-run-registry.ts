import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  sanitizeProviderText,
  type AgentRunEvent,
  type AgentRunLog,
  type AgentRunResult,
  type CheckpointMetadata,
  type FileCopyCheckpointDiff,
  type VisualDirection
} from "@htmlslide/agent";
import type { AgentAdapterRunResult } from "@htmlslide/agent-adapters";
import type {
  CliRunResult,
  DesktopByokAgentRunResult,
  DesktopExternalAgentRunResult,
  DesktopMockAgentRunResult
} from "./desktop-services.js";

export type DesktopAgentEngine = "mock-agent" | "htmlslide-agent" | "external-agent";

export type DesktopAgentRunRequest = {
  engine: DesktopAgentEngine;
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
  providerId: DesktopAgentRunResult["providerId"];
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

export type DesktopAgentRunExecutionControl = {
  signal: AbortSignal;
  onEvent: (event: AgentRunEvent) => void;
  onLog: (log: AgentRunLog) => void;
  chooseVisualDirection: (directions: VisualDirection[]) => Promise<string>;
};

export type DesktopAgentRunExecutor = (
  request: DesktopAgentRunRequest & { runId: string },
  control: DesktopAgentRunExecutionControl
) => Promise<DesktopAgentRunResult>;

type StoredRun = {
  abortController: AbortController;
  done?: Promise<void>;
  logLimitReached: boolean;
  pendingVisualDirectionChoice?: PendingVisualDirectionChoice;
  request: DesktopAgentRunRequest;
  snapshot: DesktopAgentRunSnapshot;
};

type PendingVisualDirectionChoice = {
  directions: VisualDirection[];
  resolve: (directionId: string) => void;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
  settled: boolean;
};

type DesktopAgentRunRegistryOptions = {
  execute: DesktopAgentRunExecutor;
  maxLogsPerRun?: number;
  maxTerminalRuns?: number;
  now?: () => Date;
  onUpdate?: (snapshot: DesktopAgentRunSnapshot) => void;
  runIdFactory?: () => string;
};

const activeStatuses = new Set<DesktopAgentRunStatus>(["queued", "running", "awaiting-user-choice", "cancelling"]);
const MAX_DESKTOP_LOG_MESSAGE_CHARS = 8_192;
const MAX_DESKTOP_LOG_RECORDS = 100;
const MAX_DESKTOP_EVENT_RECORDS = 200;
const MAX_DESKTOP_IPC_TEXT_CHARS = 8_192;
const MAX_DESKTOP_CLI_OUTPUT_CHARS = 32_768;
const MAX_DESKTOP_DIFF_FILES = 200;
const MAX_DESKTOP_TEXT_DIFFS = 50;
const MAX_DESKTOP_TEXT_DIFF_LINES = 400;
const MAX_DESKTOP_TEXT_DIFF_LINE_CHARS = 1_024;

type IpcCompactionLimits = {
  maxArrayItems: number;
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxStringChars: number;
  maxTextChars: number;
};

type IpcCompactionState = {
  remainingNodes: number;
  remainingTextChars: number;
  seen: WeakSet<object>;
};

const DEFAULT_IPC_LIMITS: IpcCompactionLimits = {
  maxArrayItems: 200,
  maxDepth: 8,
  maxNodes: 5_000,
  maxObjectKeys: 100,
  maxStringChars: MAX_DESKTOP_IPC_TEXT_CHARS,
  maxTextChars: 256_000
};

const JSON_IPC_LIMITS: IpcCompactionLimits = {
  maxArrayItems: 200,
  maxDepth: 8,
  maxNodes: 4_000,
  maxObjectKeys: 100,
  maxStringChars: 4_096,
  maxTextChars: 128_000
};

const METADATA_IPC_LIMITS: IpcCompactionLimits = {
  maxArrayItems: 50,
  maxDepth: 5,
  maxNodes: 300,
  maxObjectKeys: 50,
  maxStringChars: 2_048,
  maxTextChars: 8_192
};

const truncateSanitizedText = (value: string, maxChars: number): string => {
  const sanitized = sanitizeProviderText(value);
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  const marker = "\n[truncated for desktop delivery]";
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }
  return `${sanitized.slice(0, maxChars - marker.length)}${marker}`;
};

const compactIpcValue = <T>(
  value: T,
  limits: IpcCompactionLimits = DEFAULT_IPC_LIMITS,
  state: IpcCompactionState = {
    remainingNodes: limits.maxNodes,
    remainingTextChars: limits.maxTextChars,
    seen: new WeakSet<object>()
  },
  depth = 0
): T => {
  if (typeof value === "string") {
    const availableChars = Math.max(0, Math.min(limits.maxStringChars, state.remainingTextChars));
    const compact = availableChars === 0 ? "" : truncateSanitizedText(value, availableChars);
    state.remainingTextChars -= compact.length;
    return compact as T;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const objectValue = value as object;
  if (state.seen.has(objectValue) || depth >= limits.maxDepth || state.remainingNodes <= 0) {
    return (Array.isArray(value) ? [] : {}) as T;
  }
  state.seen.add(objectValue);
  state.remainingNodes -= 1;

  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxArrayItems)
      .map((item) => compactIpcValue(item, limits, state, depth + 1)) as T;
  }

  const compact: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, limits.maxObjectKeys);
  for (const [rawKey, item] of entries) {
    const availableChars = Math.max(0, Math.min(128, state.remainingTextChars));
    const key = availableChars === 0 ? "" : truncateSanitizedText(rawKey, availableChars);
    state.remainingTextChars -= key.length;
    compact[key] = compactIpcValue(item, limits, state, depth + 1);
  }
  return compact as T;
};

const providerIdForEngine = (engine: DesktopAgentEngine): DesktopAgentRunResult["providerId"] => {
  if (engine === "mock-agent") {
    return "htmlslide-mock";
  }
  if (engine === "htmlslide-agent") {
    return "htmlslide-byok";
  }
  return "external-agent";
};

const resultStatus = (result: DesktopAgentRunResult): Extract<DesktopAgentRunStatus, "succeeded" | "failed" | "cancelled"> => {
  if (result.summary.status === "cancelled") {
    return "cancelled";
  }
  return result.ok ? "succeeded" : "failed";
};

export class DesktopAgentRunRegistry {
  readonly #execute: DesktopAgentRunExecutor;
  readonly #maxLogsPerRun: number;
  readonly #maxTerminalRuns: number;
  readonly #now: () => Date;
  readonly #onUpdate?: (snapshot: DesktopAgentRunSnapshot) => void;
  readonly #runIdFactory: () => string;
  readonly #runs = new Map<string, StoredRun>();
  readonly #activeProjectRuns = new Map<string, string>();
  readonly #terminalOrder: string[] = [];

  constructor(options: DesktopAgentRunRegistryOptions) {
    this.#execute = options.execute;
    this.#maxLogsPerRun = Math.max(10, options.maxLogsPerRun ?? 500);
    this.#maxTerminalRuns = Math.max(1, options.maxTerminalRuns ?? 20);
    this.#now = options.now ?? (() => new Date());
    this.#onUpdate = options.onUpdate;
    this.#runIdFactory = options.runIdFactory ?? (() => `run-${randomUUID()}`);
  }

  start(request: DesktopAgentRunRequest): DesktopAgentRunSnapshot {
    const normalized = this.#normalizeRequest(request);
    const activeRunId = this.#activeProjectRuns.get(normalized.projectPath);
    if (activeRunId) {
      throw new Error(`An agent run is already active for this project (${activeRunId}).`);
    }

    const runId = this.#runIdFactory();
    if (this.#runs.has(runId)) {
      throw new Error(`Agent run id already exists: ${runId}`);
    }

    const record: StoredRun = {
      abortController: new AbortController(),
      logLimitReached: false,
      request: normalized,
      snapshot: {
        runId,
        projectPath: normalized.projectPath,
        engine: normalized.engine,
        providerId: providerIdForEngine(normalized.engine),
        status: "running",
        sequence: 1,
        startedAt: this.#now().toISOString(),
        canCancel: true,
        canRetry: false,
        canPause: false,
        events: [],
        logs: []
      }
    };

    this.#runs.set(runId, record);
    this.#activeProjectRuns.set(normalized.projectPath, runId);
    this.#publish(record);
    record.done = this.#run(record);
    return this.#clone(record.snapshot);
  }

  get(runId: string): DesktopAgentRunSnapshot | undefined {
    const record = this.#runs.get(runId);
    return record ? this.#clone(record.snapshot) : undefined;
  }

  getActive(projectPath: string): DesktopAgentRunSnapshot | undefined {
    const runId = this.#activeProjectRuns.get(this.#canonicalProjectPath(projectPath));
    return runId ? this.get(runId) : undefined;
  }

  cancel(runId: string, reason = "Run cancelled by user."): DesktopAgentRunSnapshot {
    const record = this.#require(runId);
    if (!activeStatuses.has(record.snapshot.status)) {
      return this.#clone(record.snapshot);
    }

    if (!record.abortController.signal.aborted) {
      record.snapshot.status = "cancelling";
      record.snapshot.canCancel = false;
      record.snapshot.error = sanitizeProviderText(reason);
      this.#rejectPendingVisualDirection(record, reason);
      record.abortController.abort(reason);
      this.#changed(record);
    }

    return this.#clone(record.snapshot);
  }

  chooseVisualDirection(runId: string, directionId: string): DesktopAgentRunSnapshot {
    const record = this.#require(runId);
    const pending = record.pendingVisualDirectionChoice;
    if (record.snapshot.status !== "awaiting-user-choice" || pending === undefined) {
      throw new Error(`Agent run is not awaiting a visual direction choice: ${runId}`);
    }
    if (typeof directionId !== "string" || directionId.trim().length === 0) {
      throw new Error("A visual direction id is required.");
    }

    const selected = pending.directions.find((direction) => direction.id === directionId);
    if (selected === undefined) {
      throw new Error(`Unknown visual direction id: ${directionId}`);
    }

    this.#resolvePendingVisualDirection(record, selected.id);
    record.snapshot.status = "running";
    this.#changed(record);
    return this.#clone(record.snapshot);
  }

  retry(runId: string): DesktopAgentRunSnapshot {
    const record = this.#require(runId);
    if (record.snapshot.status !== "failed" && record.snapshot.status !== "cancelled") {
      throw new Error("Only failed or cancelled agent runs can be retried.");
    }
    return this.start(record.request);
  }

  cancelAll(reason = "HTMLslide is shutting down."): void {
    for (const record of this.#runs.values()) {
      if (activeStatuses.has(record.snapshot.status)) {
        this.cancel(record.snapshot.runId, reason);
      }
    }
  }

  async cancelAllAndWait(reason = "HTMLslide is shutting down.", timeoutMs = 2_500): Promise<void> {
    const pending = [...this.#runs.values()]
      .filter((record) => activeStatuses.has(record.snapshot.status))
      .map((record) => record.done)
      .filter((done): done is Promise<void> => Boolean(done));
    this.cancelAll(reason);
    if (pending.length === 0) {
      return;
    }

    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)))
    ]);
  }

  async #run(record: StoredRun): Promise<void> {
    const { runId } = record.snapshot;
    try {
      const result = await this.#execute(
        { ...record.request, runId },
        {
          signal: record.abortController.signal,
          onEvent: (event) => this.#recordEvent(record, event),
          onLog: (log) => this.#recordLog(record, log),
          chooseVisualDirection: (directions) => this.#requestVisualDirection(record, directions)
        }
      );
      this.#rejectPendingVisualDirection(record, "Agent run ended before visual direction selection.");
      const compactResult = this.#compactResult(result);
      record.snapshot.result = compactResult;
      record.snapshot.providerId = result.providerId;
      record.snapshot.events = [...compactResult.events];
      record.snapshot.logs = [...compactResult.logs];
      record.snapshot.status = record.abortController.signal.aborted ? "cancelled" : resultStatus(result);
      const resultError = "error" in result ? result.error : undefined;
      record.snapshot.error = record.snapshot.status === "failed"
        ? sanitizeProviderText(resultError ?? "Agent run failed.")
        : record.snapshot.status === "cancelled"
          ? sanitizeProviderText(record.snapshot.error ?? resultError ?? "Run cancelled by user.")
          : undefined;
    } catch (error) {
      this.#rejectPendingVisualDirection(record, error instanceof Error ? error.message : String(error));
      record.snapshot.status = record.abortController.signal.aborted ? "cancelled" : "failed";
      record.snapshot.error = sanitizeProviderText(error instanceof Error ? error.message : String(error));
    }

    record.snapshot.completedAt = this.#now().toISOString();
    record.snapshot.canCancel = false;
    record.snapshot.canRetry = record.snapshot.status === "failed" || record.snapshot.status === "cancelled";
    this.#activeProjectRuns.delete(record.snapshot.projectPath);
    this.#terminalOrder.push(runId);
    this.#changed(record);
    this.#pruneTerminalHistory();
  }

  #recordEvent(record: StoredRun, event: AgentRunEvent): void {
    if (!activeStatuses.has(record.snapshot.status)) {
      return;
    }
    const index = record.snapshot.events.findIndex(
      (candidate) => candidate.runId === event.runId && candidate.sequence === event.sequence
    );
    if (index >= 0) {
      record.snapshot.events[index] = this.#compactEvent(event);
    } else {
      record.snapshot.events = this.#boundedEvents([...record.snapshot.events, event]);
    }
    this.#changed(record);
  }

  #recordLog(record: StoredRun, log: AgentRunLog): void {
    if (!activeStatuses.has(record.snapshot.status)) {
      return;
    }
    if (record.logLimitReached) {
      return;
    }
    const logLimit = Math.min(this.#maxLogsPerRun, MAX_DESKTOP_LOG_RECORDS);
    if (record.snapshot.logs.length >= logLimit - 1) {
      record.logLimitReached = true;
      record.snapshot.logs.push({
        runId: record.snapshot.runId,
        level: "warning",
        message: `Live log limit reached (${logLimit} records). Open the project run report for complete diagnostics.`,
        createdAt: this.#now().toISOString()
      });
      this.#changed(record);
      return;
    }
    record.snapshot.logs.push(this.#compactLog(log));
    this.#changed(record);
  }

  #normalizeRequest(request: DesktopAgentRunRequest): DesktopAgentRunRequest {
    if (!request || !["mock-agent", "htmlslide-agent", "external-agent"].includes(request.engine)) {
      throw new Error("Unknown agent engine. Choose Local Mock, HTMLslide Agent, or External Agent.");
    }
    if (typeof request.projectPath !== "string" || request.projectPath.trim().length === 0) {
      throw new Error("A local project path is required for an agent run.");
    }
    if (typeof request.brief !== "string") {
      throw new Error("Agent run brief must be a string.");
    }
    if (
      request.targetSlideCount !== undefined &&
      (!Number.isInteger(request.targetSlideCount) || request.targetSlideCount < 1 || request.targetSlideCount > 100)
    ) {
      throw new Error("Agent run target slide count must be an integer between 1 and 100.");
    }
    const projectPath = this.#canonicalProjectPath(request.projectPath);
    const brief = request.brief.trim() || "Create or revise this HTMLslide deck.";
    return { ...request, projectPath, brief };
  }

  #canonicalProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  #require(runId: string): StoredRun {
    const record = this.#runs.get(runId);
    if (!record) {
      throw new Error(`Unknown agent run: ${runId}`);
    }
    return record;
  }

  #changed(record: StoredRun): void {
    record.snapshot.sequence += 1;
    this.#publish(record);
  }

  #publish(record: StoredRun): void {
    if (!this.#onUpdate) {
      return;
    }
    try {
      this.#onUpdate(this.#clone(record.snapshot));
    } catch {
      // Renderer delivery must not change the run outcome.
    }
  }

  #clone(snapshot: DesktopAgentRunSnapshot): DesktopAgentRunSnapshot {
    return {
      ...snapshot,
      projectPath: truncateSanitizedText(snapshot.projectPath, MAX_DESKTOP_IPC_TEXT_CHARS),
      events: this.#boundedEvents(snapshot.events),
      logs: this.#boundedFinalLogs(snapshot.logs, snapshot.runId),
      ...(snapshot.pendingVisualDirections
        ? { pendingVisualDirections: compactIpcValue(snapshot.pendingVisualDirections) }
        : {}),
      ...(snapshot.result ? { result: structuredClone(snapshot.result) } : {}),
      ...(snapshot.error
        ? { error: truncateSanitizedText(snapshot.error, MAX_DESKTOP_IPC_TEXT_CHARS) }
        : {})
    };
  }

  #compactResult(result: DesktopAgentRunResult): DesktopAgentRunResult {
    const base = {
      ok: result.ok,
      projectPath: truncateSanitizedText(result.projectPath, MAX_DESKTOP_IPC_TEXT_CHARS),
      stages: compactIpcValue(result.stages),
      events: this.#boundedEvents(result.events),
      logs: this.#boundedFinalLogs(result.logs, result.summary.runId)
    };

    if (result.providerId === "htmlslide-mock") {
      return {
        ...base,
        providerId: result.providerId,
        summary: compactIpcValue(result.summary),
        agent: this.#compactAgentResult(result.agent),
        ...(result.applied ? { applied: compactIpcValue(result.applied) } : {}),
        ...(result.checkpointDiff ? { checkpointDiff: this.#compactCheckpointDiff(result.checkpointDiff) } : {}),
        ...(result.check ? { check: this.#compactCliResult(result.check) } : {}),
        ...(result.export ? { export: this.#compactCliResult(result.export) } : {}),
        ...(result.project ? { project: compactIpcValue(result.project) } : {}),
        ...(result.agentReportPath
          ? { agentReportPath: truncateSanitizedText(result.agentReportPath, MAX_DESKTOP_IPC_TEXT_CHARS) }
          : {})
      };
    }

    if (result.providerId === "htmlslide-byok") {
      return {
        ...base,
        providerId: result.providerId,
        summary: compactIpcValue(result.summary),
        settings: compactIpcValue(result.settings),
        ...(result.agent ? { agent: this.#compactAgentResult(result.agent) } : {}),
        ...(result.applied ? { applied: compactIpcValue(result.applied) } : {}),
        ...(result.checkpointDiff ? { checkpointDiff: this.#compactCheckpointDiff(result.checkpointDiff) } : {}),
        ...(result.check ? { check: this.#compactCliResult(result.check) } : {}),
        ...(result.export ? { export: this.#compactCliResult(result.export) } : {}),
        ...(result.project ? { project: compactIpcValue(result.project) } : {}),
        ...(result.error ? { error: truncateSanitizedText(result.error, MAX_DESKTOP_IPC_TEXT_CHARS) } : {}),
        ...(result.agentReportPath
          ? { agentReportPath: truncateSanitizedText(result.agentReportPath, MAX_DESKTOP_IPC_TEXT_CHARS) }
          : {})
      };
    }

    return {
      ...base,
      providerId: result.providerId,
      summary: compactIpcValue(result.summary),
      ...(result.adapter ? { adapter: this.#compactAdapterResult(result.adapter) } : {}),
      ...(result.checkpointDiff ? { checkpointDiff: this.#compactCheckpointDiff(result.checkpointDiff) } : {}),
      ...(result.check ? { check: this.#compactCliResult(result.check) } : {}),
      ...(result.export ? { export: this.#compactCliResult(result.export) } : {}),
      ...(result.project ? { project: compactIpcValue(result.project) } : {}),
      ...(result.error ? { error: truncateSanitizedText(result.error, MAX_DESKTOP_IPC_TEXT_CHARS) } : {})
    };
  }

  #requestVisualDirection(record: StoredRun, directions: VisualDirection[]): Promise<string> {
    if (!Array.isArray(directions) || directions.length === 0) {
      return Promise.reject(new Error("Visual direction choice requires at least one direction."));
    }
    if (record.pendingVisualDirectionChoice !== undefined) {
      return Promise.reject(new Error("An agent run already has a pending visual direction choice."));
    }
    if (record.abortController.signal.aborted) {
      return Promise.reject(new Error("Agent run was cancelled before visual direction selection."));
    }

    let pending!: PendingVisualDirectionChoice;
    const promise = new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        this.#rejectPendingVisualDirection(record, this.#abortReason(record.abortController.signal));
      };
      record.abortController.signal.addEventListener("abort", onAbort, { once: true });
      pending = {
        directions,
        resolve,
        reject,
        cleanup: () => record.abortController.signal.removeEventListener("abort", onAbort),
        settled: false
      };
    });

    record.pendingVisualDirectionChoice = pending;
    record.snapshot.pendingVisualDirections = compactIpcValue(directions);
    record.snapshot.status = "awaiting-user-choice";
    this.#changed(record);
    return promise;
  }

  #resolvePendingVisualDirection(record: StoredRun, directionId: string): void {
    const pending = record.pendingVisualDirectionChoice;
    if (pending === undefined || pending.settled) {
      return;
    }
    pending.settled = true;
    record.pendingVisualDirectionChoice = undefined;
    delete record.snapshot.pendingVisualDirections;
    pending.cleanup();
    pending.resolve(directionId);
  }

  #rejectPendingVisualDirection(record: StoredRun, reason: string): void {
    const pending = record.pendingVisualDirectionChoice;
    if (pending === undefined || pending.settled) {
      if (record.snapshot.pendingVisualDirections !== undefined) {
        delete record.snapshot.pendingVisualDirections;
      }
      return;
    }
    pending.settled = true;
    record.pendingVisualDirectionChoice = undefined;
    delete record.snapshot.pendingVisualDirections;
    pending.cleanup();
    pending.reject(new Error(sanitizeProviderText(reason)));
  }

  #abortReason(signal: AbortSignal): string {
    const reason = signal.reason;
    return reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Run cancelled by user.";
  }

  #compactAgentResult(agent: AgentRunResult): AgentRunResult {
    const build = agent.outputs.build
      ? {
          filesChanged: agent.outputs.build.filesChanged,
          slidesChanged: agent.outputs.build.slidesChanged,
          notesChanged: agent.outputs.build.notesChanged,
          themeChanged: agent.outputs.build.themeChanged
        }
      : undefined;
    const repairs = agent.outputs.repairs.map((repair) => ({
      attempt: repair.attempt,
      filesChanged: repair.filesChanged,
      issuesAddressed: repair.issuesAddressed
    }));
    const outputs = compactIpcValue({
      ...(agent.outputs.brief ? { brief: agent.outputs.brief } : {}),
      ...(agent.outputs.outline ? { outline: agent.outputs.outline } : {}),
      ...(agent.outputs.visualDirection ? { visualDirection: agent.outputs.visualDirection } : {}),
      ...(agent.outputs.selectedVisualDirectionId
        ? { selectedVisualDirectionId: agent.outputs.selectedVisualDirectionId }
        : {}),
      ...(build ? { build } : {}),
      checks: agent.outputs.checks,
      repairs,
      ...(agent.outputs.export ? { export: agent.outputs.export } : {}),
      ...(agent.outputs.review ? { review: agent.outputs.review } : {})
    });
    const base = {
      ok: agent.ok,
      status: agent.status,
      runId: truncateSanitizedText(agent.runId, MAX_DESKTOP_IPC_TEXT_CHARS),
      ...(agent.checkpoint ? { checkpoint: this.#compactCheckpoint(agent.checkpoint) } : {}),
      outputs,
      events: this.#boundedEvents(agent.events),
      logs: this.#boundedFinalLogs(agent.logs, agent.runId)
    };

    if (agent.ok) {
      return {
        ...base,
        ok: true,
        status: "succeeded"
      };
    }
    return {
      ...base,
      ok: false,
      error: compactIpcValue(agent.error)
    } as AgentRunResult;
  }

  #compactCliResult(result: CliRunResult): CliRunResult {
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: truncateSanitizedText(result.stdout, MAX_DESKTOP_CLI_OUTPUT_CHARS),
      stderr: truncateSanitizedText(result.stderr, MAX_DESKTOP_CLI_OUTPUT_CHARS),
      ...(result.json !== undefined ? { json: compactIpcValue(result.json, JSON_IPC_LIMITS) } : {}),
      ...(result.error ? { error: truncateSanitizedText(result.error, MAX_DESKTOP_IPC_TEXT_CHARS) } : {})
    };
  }

  #compactAdapterResult(adapter: AgentAdapterRunResult): AgentAdapterRunResult {
    const base = {
      ok: adapter.ok,
      status: adapter.status,
      adapter: compactIpcValue(adapter.adapter),
      ...(adapter.command ? { command: compactIpcValue(adapter.command) } : {}),
      cwd: truncateSanitizedText(adapter.cwd, MAX_DESKTOP_IPC_TEXT_CHARS),
      ...(adapter.stdout !== undefined
        ? { stdout: truncateSanitizedText(adapter.stdout, MAX_DESKTOP_CLI_OUTPUT_CHARS) }
        : {}),
      ...(adapter.stderr !== undefined
        ? { stderr: truncateSanitizedText(adapter.stderr, MAX_DESKTOP_CLI_OUTPUT_CHARS) }
        : {}),
      ...(adapter.reportedWrites ? { reportedWrites: compactIpcValue(adapter.reportedWrites) } : {})
    };
    if (adapter.ok) {
      return { ...base, ok: true, status: "completed" } as AgentAdapterRunResult;
    }
    return {
      ...base,
      ok: false,
      status: adapter.status,
      failure: compactIpcValue(adapter.failure)
    } as AgentAdapterRunResult;
  }

  #compactCheckpoint(checkpoint: CheckpointMetadata): CheckpointMetadata {
    return compactIpcValue(checkpoint, {
      ...DEFAULT_IPC_LIMITS,
      maxArrayItems: MAX_DESKTOP_DIFF_FILES,
      maxStringChars: 2_048,
      maxTextChars: 128_000
    });
  }

  #compactCheckpointDiff(diff: FileCopyCheckpointDiff): FileCopyCheckpointDiff {
    let remainingLines = MAX_DESKTOP_TEXT_DIFF_LINES;
    const textDiffs = diff.textDiffs.slice(0, MAX_DESKTOP_TEXT_DIFFS).map((textDiff) => {
      const lineCount = Math.min(remainingLines, textDiff.lines.length);
      remainingLines -= lineCount;
      return {
        path: truncateSanitizedText(textDiff.path, 2_048),
        status: textDiff.status,
        language: textDiff.language,
        lines: textDiff.lines.slice(0, lineCount).map((line) => ({
          ...line,
          text: truncateSanitizedText(line.text, MAX_DESKTOP_TEXT_DIFF_LINE_CHARS)
        })),
        truncated: textDiff.truncated || lineCount < textDiff.lines.length
      };
    });

    return {
      checkpoint: this.#compactCheckpoint(diff.checkpoint),
      changed: compactIpcValue(diff.changed.slice(0, MAX_DESKTOP_DIFF_FILES)),
      added: compactIpcValue(diff.added.slice(0, MAX_DESKTOP_DIFF_FILES)),
      deleted: compactIpcValue(diff.deleted.slice(0, MAX_DESKTOP_DIFF_FILES)),
      unchanged: compactIpcValue(diff.unchanged.slice(0, MAX_DESKTOP_DIFF_FILES)),
      textDiffs,
      summary: { ...diff.summary }
    };
  }

  #boundedEvents(events: AgentRunEvent[]): AgentRunEvent[] {
    const selected = events.length <= MAX_DESKTOP_EVENT_RECORDS
      ? events
      : [
          ...events.slice(0, MAX_DESKTOP_EVENT_RECORDS / 2),
          ...events.slice(-(MAX_DESKTOP_EVENT_RECORDS / 2))
        ];
    return selected.map((event) => this.#compactEvent(event));
  }

  #compactEvent(event: AgentRunEvent): AgentRunEvent {
    return {
      stage: event.stage,
      status: event.status,
      summary: truncateSanitizedText(event.summary, MAX_DESKTOP_IPC_TEXT_CHARS),
      createdAt: truncateSanitizedText(event.createdAt, MAX_DESKTOP_IPC_TEXT_CHARS),
      ...(event.runId ? { runId: truncateSanitizedText(event.runId, MAX_DESKTOP_IPC_TEXT_CHARS) } : {}),
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
      ...(event.type ? { type: event.type } : {}),
      ...(event.filesChanged ? { filesChanged: compactIpcValue(event.filesChanged) } : {}),
      ...(event.issuesFound !== undefined ? { issuesFound: event.issuesFound } : {}),
      ...(event.nextAction
        ? { nextAction: truncateSanitizedText(event.nextAction, MAX_DESKTOP_IPC_TEXT_CHARS) }
        : {}),
      ...(event.checkpointId
        ? { checkpointId: truncateSanitizedText(event.checkpointId, MAX_DESKTOP_IPC_TEXT_CHARS) }
        : {}),
      ...(event.metadata ? { metadata: compactIpcValue(event.metadata, METADATA_IPC_LIMITS) } : {})
    };
  }

  #boundedFinalLogs(logs: AgentRunLog[], runId: string): AgentRunLog[] {
    const logLimit = Math.min(this.#maxLogsPerRun, MAX_DESKTOP_LOG_RECORDS);
    if (logs.length <= logLimit) {
      return logs.map((log) => this.#compactLog(log));
    }
    return [
      ...logs.slice(0, logLimit - 1).map((log) => this.#compactLog(log)),
      {
        runId,
        level: "warning",
        message: `Log output truncated to ${logLimit} records for desktop delivery.`,
        createdAt: this.#now().toISOString()
      }
    ];
  }

  #compactLog(log: AgentRunLog): AgentRunLog {
    return {
      runId: truncateSanitizedText(log.runId, MAX_DESKTOP_IPC_TEXT_CHARS),
      ...(log.stage ? { stage: log.stage } : {}),
      level: log.level,
      message: truncateSanitizedText(log.message, MAX_DESKTOP_LOG_MESSAGE_CHARS),
      createdAt: truncateSanitizedText(log.createdAt, MAX_DESKTOP_IPC_TEXT_CHARS),
      ...(log.metadata ? { metadata: compactIpcValue(log.metadata, METADATA_IPC_LIMITS) } : {})
    };
  }

  #pruneTerminalHistory(): void {
    while (this.#terminalOrder.length > this.#maxTerminalRuns) {
      const oldest = this.#terminalOrder.shift();
      if (oldest) {
        this.#runs.delete(oldest);
      }
    }
  }
}
