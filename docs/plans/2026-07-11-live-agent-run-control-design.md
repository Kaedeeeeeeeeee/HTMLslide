# Live Agent Run Control Design

## Goal

Make the desktop Agent Run Console reflect and control the real task running in Electron main. Starting a run must return immediately, stage events and redacted logs must arrive while work is in progress, cancellation must abort the provider or child process, and retry must create a new run with a new checkpoint.

This milestone covers Local Mock, HTMLslide BYOK, and the configured Generic external command. CLI behavior remains backed by the same core services and is not moved into the renderer.

## Current Problem

The agent core and Generic command runner already accept `AbortSignal`, but the desktop IPC handlers await the complete run before returning. The renderer therefore receives only the final event and log arrays. Its Pause and Cancel controls currently change React state without changing the provider request or child process.

That creates three product failures:

- the console cannot show genuine progress during a long run;
- Cancel leaves work running and can allow late results to overwrite the UI;
- Pause claims a capability that providers and local commands cannot reliably provide.

## Considered Approaches

### Main-owned registry with pushed updates and snapshot recovery

Electron main owns every active controller and process. Start returns a handle, main publishes sequenced snapshots, and the renderer can request the latest snapshot after reload or a missed update. This keeps credentials, process handles, and cancellation authority outside the renderer while supporting live UX.

This is the selected approach.

### Renderer polling

The renderer could poll main for status. It is simpler than push delivery but adds continuous IPC traffic, makes fast log chunks easy to coalesce or miss, and still requires a main-owned registry. It does not improve the security boundary, so it is not selected.

### Per-run MessagePort

A dedicated `MessagePort` would provide strong stream semantics, but lifecycle recovery across renderer reloads is more complex and unnecessary for the current event volume. A narrow Electron event channel plus full snapshots is sufficient.

## Architecture

### Service observer contract

Desktop agent services accept an optional run-control object:

```ts
type DesktopAgentRunControl = {
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  onLog?: (log: AgentRunLog) => void | Promise<void>;
};
```

The agent orchestrator receives equivalent event and log observers. Observers are called only after data has been normalized and sanitized. Observer exceptions and rejected promises must not fail a run.

Local Mock and BYOK use `startAgentRun` so the controller can be cancelled. Generic command runs pass the same signal to the adapter runner. The desktop check/export subprocess boundary is outside the external agent adapter; this milestone checks the signal before each follow-up step and does not start a new check or export after cancellation.

### Main-process registry

`DesktopAgentRunRegistry` owns:

- active `AbortController` instances;
- a sanitized retry request without credentials or raw provider prompts;
- the latest events, logs, status, and terminal result;
- one active run per resolved project path;
- a bounded terminal history for renderer recovery.

Starting returns a `DesktopAgentRunHandle` before the asynchronous service finishes. A second start for the same project is rejected with an actionable error. Runs for different projects may execute independently.

The registry generates the run id before invoking a service and passes it into the request. A terminal result is stored exactly once. Updates have a monotonically increasing registry sequence independent of the orchestrator event sequence.

The renderer treats a newer terminal snapshot as authoritative even when the user has already clicked Cancel. This covers the race where main completed immediately before it handled the cancel request. Once a terminal snapshot is accepted, a late non-terminal snapshot for that run cannot revive it.

### IPC contract

The preload exposes four operations and one subscription:

```ts
startAgentRun(request): Promise<DesktopAgentRunSnapshot>
getAgentRun(runId): Promise<DesktopAgentRunSnapshot | undefined>
getActiveAgentRun(projectPath): Promise<DesktopAgentRunSnapshot | undefined>
cancelAgentRun(runId): Promise<DesktopAgentRunSnapshot>
retryAgentRun(runId): Promise<DesktopAgentRunSnapshot>
onAgentRunUpdate(handler): () => void
```

`startAgentRun` uses an engine discriminant (`mock-agent`, `htmlslide-agent`, or `external-agent`) and the existing project/brief/export options. The old provider-specific preload methods are removed once all renderer and E2E call sites use the shared contract.

Main broadcasts `htmlslide:agent-run-update` only to live, non-destroyed app windows. The payload is a complete sanitized snapshot, which makes each update independently usable and lets the renderer ignore any sequence not newer than its current snapshot. After start or retry returns, the renderer fetches the run once to reconcile a terminal update that may have arrived before the IPC response. A recreated window can query the active run for its canonical project path.

### Snapshot model

A snapshot contains:

- `runId`, `projectPath`, `engine`, `providerId`;
- `status`: `queued`, `running`, `cancelling`, `succeeded`, `failed`, or `cancelled`;
- `sequence`, `startedAt`, optional `completedAt`;
- `canCancel`, `canRetry`, and `canPause: false`;
- accumulated structured `events` and redacted `logs`;
- optional terminal `result` and sanitized `error`.

The full terminal result remains the authority for project preview, check/export status, and checkpoint diff.

## Control Semantics

### Cancel

Cancel is idempotent. For an active run it moves the registry to `cancelling`, aborts the signal, and eventually records `cancelled`. Local Mock and BYOK cancellation reaches the provider through the orchestrator; Keychain lookup and BYOK credential preflight are also cancellation-aware and time-bounded. On macOS and Linux, Generic commands run in an isolated process group: cancellation signals the full tree with `SIGTERM`, escalates to `SIGKILL`, bounds inherited-pipe drain, and records the terminal state only after cleanup.

No new apply, check, export, or project reload step starts after the signal is aborted. A terminal run cannot be cancelled.

### Retry

Retry is available only after `failed` or `cancelled`. It starts a new run with a new id and checkpoint using the recorded engine, project path, brief, and non-secret options. It never resumes an old process and never reuses a credential value.

### Pause

True pause/resume is not portable across HTTP providers and external agent processes. The console exposes Pause as disabled with an accessible explanation that the selected engine does not support pausing. It must not change run state. A future adapter may set `canPause` only after both pause and resume semantics are implemented and tested.

## Renderer Behavior

The renderer subscribes once to run updates. Starting or retrying stores the returned run id and immediately renders the snapshot. Newer snapshots replace the current event/log view. Terminal snapshots apply the result once, refresh the project, and update command statuses.

Cancel stays enabled while a run is active and changes to a disabled cancelling state after invocation. Run/Send and Retry are disabled during active work. Retry is enabled only for the current failed or cancelled run. Open logs expands the first available stage log region and is disabled only when no logs exist.

If the renderer reloads while main still owns a run, `getAgentRun` restores the latest snapshot when the run id is known. Persisting active run ids across full application restarts is outside this milestone because the underlying process/provider cannot be reattached safely.

## Security And Failure Handling

- Credentials stay in Electron main and are never stored in retry metadata or snapshots.
- Provider messages are sanitized before observer delivery. Process output is line-buffered across transport chunks, bounded, then sanitized before observer delivery.
- Keychain lookup and provider validation are cancellation-aware and time-bounded.
- Listener failures cannot fail the agent run.
- Unknown run ids, duplicate project runs, and invalid retries return explicit errors. Cancellation is idempotent, so cancelling a terminal run returns its existing snapshot.
- Terminal history is bounded so logs cannot grow without limit across many runs.
- Per-run service logs, command captures, live snapshots, and terminal result fields are capped before desktop IPC delivery. Provider source-write content never crosses the terminal IPC boundary.

## Verification

Focused tests cover:

- orchestrator observer delivery, ordering, cancellation, and listener isolation;
- registry immediate start, one active run per project, live snapshots, idempotent cancel, retry with a new id, and bounded history;
- Generic command streaming and real signal propagation;
- renderer status mapping for failed and cancelled stages;
- Electron live progress before completion, real cancellation, retry, disabled pause, concurrent-run prevention, log access, and accessibility;
- redaction of pushed logs and terminal failures.

The milestone then runs the desktop build/typecheck, relevant Vitest suites, Electron smoke and accessibility tests, the repository test suite, and alpha package verification before pushing and checking GitHub CI.
