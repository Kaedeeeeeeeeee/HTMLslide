# Built-in External Agent Adapters Design

Date: 2026-07-11

## Goal

Complete the first production path in Phase 5 by allowing an authenticated Claude Code or Codex CLI installation to run a deck task directly from HTMLslide. The desktop app must keep ownership of checkpoints, validation, export, cancellation, and diff review.

## Scope

- Add fixed, tested headless invocations for Claude Code and Codex CLI.
- Keep Generic command mode available for user-owned integrations.
- Keep Gemini CLI detection-only until its authentication and non-interactive permission contract is defined and tested.
- Correct Codex authentication detection to use `codex login status`.
- Surface built-in readiness and run capability in AI Engines and New Deck.
- Preserve the existing shared run registry, bounded log transport, checkpoint, check, export, retry, and revert behavior.

This milestone does not claim that a real provider account has passed release-candidate validation. Fake runners prove the command and desktop contracts; a real account run remains manual release evidence.

## Invocation Contract

Built-in invocations are assembled as argv arrays and passed to the shared command runner. No command text is interpolated and no shell is involved. Electron first copies deck source and project guidance into an OS-temporary workspace; the external process never receives the real project path.

Claude Code runs from the project root with:

```text
claude --print --output-format stream-json --verbose
  --setting-sources "" --strict-mcp-config
  --disable-slash-commands --no-chrome
  --permission-mode acceptEdits
  --tools Read,Glob,Grep,Edit,Write
  --no-session-persistence
  <prompt that points to the project-local task file>
```

The restricted tool set intentionally excludes Bash and network tools. Empty setting sources, strict empty MCP configuration, disabled slash commands, and disabled Chrome integration prevent local settings, MCP servers, skills, plugins, hooks, and browser integration from broadening the run while preserving existing OAuth/Keychain authentication. HTMLslide runs check and export itself after the edit.

Codex CLI runs from the project root with:

```text
codex exec --sandbox workspace-write --ephemeral --ignore-user-config
  --skip-git-repo-check --json --color never -C <temporary-workspace>
  <prompt that points to the project-local task file>
```

`workspace-write` is the least Codex sandbox mode that permits source edits. Ignoring user config prevents a local profile from silently adding MCP servers, hooks, or broader behavior; Codex authentication remains available. The project `AGENTS.md` contract remains discoverable.

Both adapters use the shared timeout, process-group cancellation, bounded stdout/stderr capture, chunk-safe secret redaction, and desktop IPC limits.

## Project And Diff Ownership

Before invocation, Electron creates a file-copy checkpoint over `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`, then creates a second checkpoint in the isolated copy. Built-in adapters do not trust a model-authored write manifest as the source of truth. After a successful command, Electron derives changed source paths from the isolated diff and applies only those allowed paths to the real project. Changes to copied guidance or any other temporary file are discarded. Electron records the resulting real-project diff for reversible cleanup, then runs `htmlslide check` and exports only after a passing check.

Generic command mode keeps its write-manifest boundary for compatibility, while the same checkpoint diff remains the user-visible review surface.

The prompt explicitly prohibits edits to `exports/` and `.htmlslide/`. The temporary workspace excludes real exports, runtime data, repository metadata, and unrelated project files. Built-in agent execution is still user-authorized local tooling, not a complete OS sandbox; the UI and docs must state that boundary.

## Desktop State

- `Claude Code` is runnable only when detection reports installed and authenticated.
- `Codex CLI` is runnable only when detection reports installed and authenticated.
- `Generic command` is runnable only when a valid command template is saved.
- `Gemini CLI` remains manual-validation only.
- External run results carry the selected adapter id so reports and UI never label Claude or Codex as Generic.
- Existing active-run exclusion, live updates, cancel, retry, completion-wins race handling, diff review, and revert apply unchanged.

## Tests

- Unit-test exact Claude and Codex argv, cwd, cancellation, timeout, command failure, and reported output bounds through injected runners.
- Unit-test the corrected Codex `login status` detector command.
- Desktop service tests run fake Claude/Codex commands through checkpoint, check, export, and diff review.
- Renderer model tests prove readiness and New Deck gating for built-in agents.
- Electron E2E covers one detected built-in agent run without real credentials or network access.
- Existing Generic and detection-only Gemini tests remain green.

## Release Evidence

Automated evidence can claim that built-in adapter contracts and fake end-to-end runs pass. Public release claims for Claude Code or Codex require a completed manual RC entry for the exact packaged artifact and the user's own authenticated installation.
