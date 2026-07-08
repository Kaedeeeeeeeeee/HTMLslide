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

`visual_direction` can auto-select a direction or enter `awaiting_user_choice` when a caller provides a selection callback. Cancellation can happen from any non-terminal state.

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

## Checkpoint Metadata

Each run creates checkpoint metadata before the `brief` stage. The default foundation is metadata-only:

```json
{
  "id": "checkpoint-run-0001",
  "runId": "run-0001",
  "projectRoot": "/path/to/deck",
  "strategy": "metadata-only",
  "sourceRoots": ["deck.json", "slides/", "notes/", "theme/", "assets/"],
  "files": [],
  "restore": {
    "canRevert": false,
    "notes": "Metadata-only checkpoint. Future git-diff or file-copy adapters should populate reversible file snapshots."
  }
}
```

Future checkpoint adapters should use `git-diff` for git projects or `file-copy` for non-git projects. Revert-capable checkpoints must cover `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/` without deleting user-added source material that was not part of the snapshot.

## Mock Provider

The mock provider is deterministic and performs no network calls. By default it:

1. normalizes a brief,
2. returns a three-slide outline,
3. returns two visual directions and auto-selects `direction-editorial`,
4. reports deterministic source files for build,
5. fails the first check with one error and one warning,
6. repairs slide and notes files,
7. passes the next check,
8. returns PDF, HTML, deckpkg, and speaker-notes artifact paths,
9. returns a review summary.

Tests can override mock check results, provider failures, and delay to exercise max repair rounds, provider errors, and cancellation.

## Desktop New Deck v1

The desktop New Deck wizard can create a No AI source project or run the deterministic Local Mock agent immediately after `htmlslide new` succeeds. The wizard collects title, folder, brief, AI engine, language, audience, duration, slide count, tone, design direction, speaker notes, and requested outputs.

For v1, HTMLslide Agent and Coding Agent are visible as product modes with readiness state, but their generation submit path is blocked until provider-backed BYOK and external-agent run IPC exist. This prevents the alpha app from silently treating those modes as source-only generation.

When Local Mock is selected, the richer wizard fields are encoded into the agent brief and sent through the existing `runMockAgent` IPC path. The desktop app must pass the project path returned by `createProject` directly into the mock-agent call so generation does not depend on React state settling after the project preview opens.

Visual-direction selection remains auto-selected by the orchestrator until the product ships a dedicated visual-direction choice screen.
