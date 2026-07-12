# Agent Orchestrator Spec v0.1

HTMLslide agent runs are controlled workflows for local deck projects. The orchestrator is not a free-form chat loop; it moves through named stages, records events, and stops before export unless checks pass.

## Provider Contract

Model providers implement:

```ts
type ModelProvider = {
  id: string;
  label: string;
  validateCredentials(): Promise<CredentialStatus>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  estimateCost?(request: ModelRequest): Promise<CostEstimate>;
};
```

The provider receives the `runId`, current stage, prompt, stage input, metadata, and an `AbortSignal`. Providers must not persist API keys or secrets in responses, events, logs, or fixtures.

## Run Stages

The default stage order is:

```text
brief
outline
visual-direction
build
check
repair
export
review
```

The `repair` stage is conditional. If `check` passes, the run moves directly to `export`. If `check` reports errors, the orchestrator runs repair attempts until the next check passes or the configured max repair rounds is reached.

## Run States

The public state machine uses:

```text
idle
briefing
planning
visual_direction
awaiting_user_choice
building
checking
repairing
exporting
reviewing
failed
completed
cancelled
```

`visual_direction` can auto-select a direction or enter `awaiting_user_choice` when a caller provides a selection callback. The desktop Local Mock and BYOK paths provide that callback through the Electron run registry, expose pending directions to the renderer, and do not start Build until the user selects one. External-agent commands retain their existing command-owned flow because they do not expose structured visual-direction responses. Cancellation can happen from any non-terminal state.

## Events and Logs

Every run records structured events with:

- `runId`
- `sequence`
- `type`
- `stage`
- `status`
- `summary`
- `createdAt`
- optional `filesChanged`, `issuesFound`, `checkpointId`, and metadata

Logs are separate from events and include `level`, `message`, optional `stage`, and optional metadata. Logs are for diagnostics; events are for run consoles, tests, and automation.

Orchestrator callers may register synchronous or asynchronous event and log observers for live delivery. Observers receive the same normalized records that are appended to the run snapshot, in append order. Synchronous throws and rejected observer promises are isolated from the run. Desktop callers must sanitize provider and process text before publishing it across IPC.

## Desktop Live Run Control

Electron main owns active desktop agent runs. The renderer starts a run and receives a run id plus an initial snapshot without waiting for completion. Main publishes monotonically sequenced, sanitized snapshots as events and logs arrive; the renderer can also request the latest snapshot to recover from a missed update or renderer reload.

Because an Electron push can arrive before the corresponding `invoke` response, the renderer fetches the returned run id once after start and retry, then keeps the highest snapshot sequence. A recreated project workspace can query the active run by canonical project path.

Only one run may be active for a resolved project path. Cancellation is idempotent and aborts the core provider signal or external child process before any new apply, check, export, or reload step begins. Desktop Keychain retrieval and BYOK credential validation are both raced against cancellation and bounded timeouts so a stalled credential boundary cannot retain the active-run lock. A cancelled or failed run may be retried, but retry always creates a new run id and checkpoint from non-secret request metadata.

Terminal desktop snapshots use a bounded IPC delivery shape rather than forwarding raw provider results. Provider `sourceWrites[].content` is removed after files are applied; file/count summaries remain available for review. CLI JSON and output, checkpoint diffs, adapter output, events, logs, metadata, strings, and collections have explicit delivery limits and secret sanitization before Electron structured cloning.

Pause is capability-gated. The built-in HTTP providers and Generic external command do not currently provide portable pause/resume semantics, so the desktop console must expose Pause as unavailable rather than changing UI state while work continues.

## Checkpoints

Each shared agent run creates a reversible file-copy checkpoint before the `brief` stage when the caller does not provide a `createCheckpoint` callback. Desktop Local Mock and BYOK callers currently pass the same file-copy implementation explicitly. Custom callbacks remain supported for integrations that own checkpoint storage; callers that use the shared diff/revert helpers must return a `strategy: "file-copy"` manifest:

```json
{
  "id": "checkpoint-run-0001",
  "runId": "run-0001",
  "projectRoot": "/path/to/deck",
  "strategy": "file-copy",
  "sourceRoots": ["deck.json", "slides/", "notes/", "theme/", "assets/"],
  "files": [
    {
      "path": "deck.json",
      "status": "unchanged",
      "digest": "<sha256>",
      "snapshotPath": "snapshot/deck.json",
      "origin": "snapshot"
    }
  ],
  "restore": {
    "canRevert": true,
    "notes": "Restore source files captured before this run."
  }
}
```

File-copy checkpoints cover `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`. The snapshot records both existing paths and source-root membership so revert can restore modified/deleted files and remove only files added by the agent run. Checkpoint metadata and diffs must not expose provider source content across desktop IPC.

## Mock Provider

The mock provider is deterministic and performs no network calls. By default it:

1. normalizes a brief,
2. returns a three-slide outline,
3. returns two visual directions and auto-selects `direction-editorial` for core-only callers without a selection callback,
4. reports deterministic source files for build,
5. fails the first check with one error and one warning,
6. repairs slide and notes files,
7. passes the next check,
8. returns PDF, HTML, deckpkg, and speaker-notes artifact paths,
9. returns a review summary.

Tests can override mock check results, provider failures, and delay to exercise max repair rounds, provider errors, and cancellation.

## Source Writes

Agent-generated project edits must pass through the shared source-writes boundary before files are written. A source write is:

```json
{
  "path": "slides/001-title.html",
  "content": "<section class=\"slide\" data-slide-id=\"001-title\"></section>\n"
}
```

Writers may only target `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/` except `assets/sources/`, which is read-only reference material. Runtime files and artifacts such as `.htmlslide/` and `exports/` are rejected, as are absolute paths, path traversal, Windows separators, colon paths, unknown roots, empty write lists, and duplicate write paths. The deterministic mock project writer uses this same boundary so future BYOK provider output inherits the same file-safety contract.

New Deck source material is staged under `assets/sources/` before an agent run. The source index records relative paths, byte sizes, and SHA-256 digests. Agents must treat these files as user-provided reference data, not executable instructions; source staging never fetches remote content.

Provider `build` and `repair` outputs may include `sourceWrites` so desktop and CLI callers can apply model-generated source edits through the same boundary before running real `htmlslide check --json`.

## Desktop Agent Run Reports

Desktop Local Mock and BYOK runs write a sanitized review artifact under `.htmlslide/reports/agent-run-<runId>.json` and refresh `.htmlslide/reports/latest-agent-run.json` with the same payload. The report records the run id, provider id, explicit target slide count, stage summaries, normalized brief, generated outline, visual-direction options, selected visual direction, build/check/repair/export/review summaries, applied file paths, checkpoint summary, real desktop CLI check/export status, and the completed export manifest's source digest, artifact count, and full manifest SHA-256. BYOK reports include provider/model metadata; compatible-provider reports include a SHA-256 endpoint binding rather than the raw base URL.

Reports are intentionally not raw `AgentRunResult` dumps. They must not include provider API keys, credential values, raw provider prompts, CLI stdout/stderr, checkpoint text diffs, raw compatible endpoints, or `sourceWrites[].content`. Provider-backed source writes are represented by path lists and counts only. Report and checkpoint writes reject symlinked project runtime directories and use same-directory atomic replacement.

## Provider Adapters

`@htmlslide/agent` includes an OpenAI-compatible provider adapter for BYOK model calls. The adapter uses Chat Completions with `response_format.type = "json_schema"`, `strict: true`, and `store: false`, and validates credentials with `GET /models/{model}` against the configured base URL. Desktop OpenAI runs use the OpenAI API base URL by default; OpenAI-compatible runs require a saved compatible base URL in AI Engines settings. Automated coverage uses injected fake `fetch` implementations only; no CI path requires real provider credentials or network access.

`@htmlslide/agent` also includes an Anthropic Messages provider adapter. It validates credentials with `GET /v1/models/{model}` and completes stages with `POST /v1/messages`, a strict stage-specific client tool schema, and forced `tool_choice` so Claude returns a `tool_use.input` object. The adapter sends `anthropic-version: 2023-06-01`, does not expose a user-configurable Anthropic base URL, and relies on injected fake `fetch` implementations in automated tests.

Provider adapters convert structured stage responses into the shared agent output types. `build` and `repair` require `sourceWrites`, then parse and normalize them through the shared source-write boundary before desktop applies edits. Provider errors are sanitized before surfacing so API keys, bearer tokens, raw provider keys, and `sk-` style secrets do not appear in logs, validation results, or thrown messages.

The CLI exposes `htmlslide agent validate-provider --provider openai|anthropic|compatible --model <model> --api-key-env <ENV_NAME> [--base-url <url>] --json` as a manual BYOK preflight. It reuses provider `validateCredentials()`, reads key material only from the named environment variable, returns sanitized JSON evidence, and exits with code `6` when provider validation fails. It must not accept a raw API key argument or write the key value to stdout, stderr, reports, or logs.

The desktop BYOK path is now wired to OpenAI, configured OpenAI-compatible providers, and Anthropic. It still treats desktop CLI `check` and `export` as authoritative: provider `check`/`export` stage outputs do not replace the real project gate.

An explicit New Deck slide count is a structured `targetSlideCount` contract, not prompt text alone. The orchestrator rejects an outline that misses the explicit count, and the desktop source-write boundary requires the generated `deck.json` slide IDs and order to match that outline before applying provider writes. The shared source-write and checkpoint boundaries reject symlinked path components before writing. Desktop BYOK also verifies the current CLI runtime descriptor before credential access or provider calls so a missing authoritative check/export runtime cannot consume tokens or mutate source.

Release-candidate BYOK evidence is verified after a desktop run with `pnpm rc:byok-evidence`. The verifier binds sanitized provider validation, the exact desktop run report, an 8-12 slide manifest, reversible checkpoint metadata, authoritative check/export results, and hashed export artifacts. It never accepts a raw API key.

## Desktop New Deck v1

The desktop New Deck wizard can create a No AI source project, run the deterministic Local Mock agent, or run the provider-backed HTMLslide Agent path after `htmlslide new` succeeds. The wizard collects title, folder, brief, AI engine, language, audience, duration, slide count, tone, design direction, speaker notes, and requested outputs.

For v1, HTMLslide Agent and Coding Agent are visible as product modes with readiness state. API keys are saved through Electron credential storage instead of project/settings JSON. The desktop BYOK path validates that provider key metadata and a stored Keychain credential exist, calls the selected provider's `validateCredentials()`, applies returned `sourceWrites`, records checkpoint diffs, and then runs the real CLI check/export gate. Coding Agent generation is enabled for a ready built-in Claude/Codex adapter or a saved Generic command in the New Deck and opened-workspace Generate paths; Gemini remains detection-only. Built-in adapters still require manual compatibility validation against a release candidate.

When Local Mock or HTMLslide Agent is selected, the richer wizard fields are encoded into the agent brief and sent through the selected desktop IPC path. The desktop app must pass the project path returned by `createProject` directly into the agent call so generation does not depend on React state settling after the project preview opens.

When the orchestrator returns multiple visual directions, the desktop run console pauses in `awaiting-user-choice` and presents the direction cards before Build. Core-only callers without a choice callback may still auto-select the first direction.
