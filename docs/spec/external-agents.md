# External Agents Spec v0.1

HTMLslide can run user-owned external coding agents against a local deck project. Claude Code and Codex CLI have built-in headless adapters, Generic command mode remains available for user-defined integrations, and Gemini CLI remains detection-only. Adapters must be local-first, deterministic in automated tests, and project-boundary aware.

## Adapter Capabilities

Adapters expose a shared capability map:

- `detectInstalled`: check whether the external command is available.
- `detectAuthenticated`: check whether the command can run under the user's logged-in account.
- `headlessRun`: run without opening an interactive terminal.
- `streamLogs`: surface raw logs to the app.
- `installSkills`: install project-local HTMLslide skill guidance.
- `configureMCP`: connect the HTMLslide MCP server.
- `openExternal`: open a fallback terminal or external app.
- `cancelRun`: cancel an in-flight run.
- `readDiff`: inspect changed files after the run.

Detection results use `ready`, `not-installed`, `not-authenticated`, or `unavailable` status plus a remediation-ready failure when the adapter cannot run.

Capability and readiness are adapter-specific:

| Adapter | Detection | HTMLslide headless run | Readiness requirement |
| --- | --- | --- | --- |
| Claude Code | Install and authentication | Built-in fixed invocation | Installed and authenticated |
| Codex CLI | Install and authentication through `codex login status` | Built-in fixed invocation | Installed and authenticated |
| Gemini CLI | Install only | Not available | Detection-only; authentication and non-interactive permissions require a future tested contract |
| Generic command | Saved template validation | User-defined argv template | Valid saved template |

## Built-in Claude And Codex Invocations

Built-in invocations are assembled as argv arrays and passed directly to the shared command runner. HTMLslide does not interpolate shell text and does not wrap the command in a shell. The child process runs locally in an OS-temporary copy containing deck source and project guidance, and uses the user's existing CLI installation and login. The real project path is not passed to the child process.

Claude Code runs with:

```text
claude --print --output-format stream-json --verbose
  --setting-sources "" --strict-mcp-config
  --disable-slash-commands --no-chrome
  --permission-mode acceptEdits
  --tools Read,Glob,Grep,Edit,Write
  --no-session-persistence
  <prompt that points to the project-local task file>
```

The Claude adapter permits project file inspection and edits through `Read`, `Glob`, `Grep`, `Edit`, and `Write`. Empty setting sources, strict empty MCP configuration, disabled slash commands, and disabled Chrome integration prevent project/user settings, MCP servers, skills, plugins, hooks, and browser integration from broadening the run while preserving the user's existing OAuth or Keychain login. `acceptEdits` allows the requested deck edits without interactive approval prompts, but it does not turn the process into a complete OS sandbox.

Codex CLI runs with:

```text
codex exec --sandbox workspace-write --ephemeral --ignore-user-config
  --skip-git-repo-check --json --color never -C <temporary-workspace>
  <prompt that points to the project-local task file>
```

`workspace-write` is the least Codex sandbox mode that permits source edits. The run is ephemeral, and `--ignore-user-config` prevents local profiles from silently adding MCP servers, hooks, or broader behavior while preserving the CLI's existing authentication. Project-local `AGENTS.md` guidance remains discoverable.

The prompt tells both built-in agents to edit only deck source and not to modify `exports/` or HTMLslide-owned runtime data. That prompt is defense in depth, not the source of truth for review or rollback.

## Generic Command Templates

Generic adapters render command templates into argv tokens without a shell. Placeholders use `{{name}}` syntax:

```text
my-agent --cwd "{{projectPath}}" --prompt-file "{{promptFile}}"
```

Each placeholder value renders as one argv token, even when it contains spaces. Path placeholders such as `projectPath`, `projectRoot`, `promptFile`, `scriptFile`, and `writeManifest` must resolve inside the HTMLslide project. `projectPath` and `projectRoot` must resolve exactly to the project root.

Adapters must not execute generated shell text. Tests should use injected runners or controlled Node fake commands in temporary project directories.

External command runs can stream stdout/stderr chunks through the adapter while retaining bounded stdout/stderr diagnostic captures when the process exits. The command runner continues draining both pipes after each capture reaches its limit. The adapter redactor carries known secret prefixes across stream chunks before delivery. The desktop external-agent path frames chunks into bounded complete lines before redaction and build-stage log delivery. This preserves live progress without allowing a secret split across transport chunks, an unbounded line, an API key, or a bearer token into desktop IPC.

External-agent child processes receive a small runtime environment by default (`PATH`, user/temp locale paths, and `HTMLSLIDE_HOME`). Full parent-environment inheritance is never used by the built-in or Generic adapters; callers must explicitly provide any additional environment values, and those values are treated as sensitive for output redaction.

Generic live chunks are published as bounded, sanitized desktop run snapshots over the shared agent-run update channel. Built-in Claude/Codex stdout and stderr are reduced to metadata-only progress/diagnostic events; raw structured output is omitted from renderer results. The renderer does not receive command handles, environment variables, credentials, prompt-file contents, or unsanitized stdout/stderr.

## Desktop External Agent Runs

The desktop app starts external agents from Electron main for an opened local deck project. The renderer sends only the selected adapter, project path, and user brief. The main-process IPC boundary loads and validates the requested project before the run registry can start, so a renderer request cannot launch an agent against an arbitrary directory. Electron owns the run registry, writes project-local run inputs, creates the checkpoint, copies source into an OS-temporary workspace, launches the child process there, applies only the verified source diff back to the real project, and publishes bounded sanitized progress snapshots.

Before invocation, HTMLslide creates a file-copy checkpoint over the real `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`, then checkpoints the isolated copy. After a successful built-in Claude or Codex command, HTMLslide derives changed paths from the isolated diff instead of trusting model-authored output. It rejects source symlinks, verifies the real source still matches the run-start digests, and only then copies back allowed source paths. Concurrent user/editor changes fail the run without applying agent output. Changes to copied guidance or other temporary files are discarded. HTMLslide then records the real-project diff, runs `htmlslide check --json`, and exports only after Check passes. The real diff is the review surface, and the real checkpoint supplies the revert source.

Generic mode keeps its project-local `.htmlslide/runs/<runId>/prompt.md` and `.htmlslide/runs/<runId>/writes.json` contract. HTMLslide validates the reported write manifest for compatibility and compares it with the real checkpoint diff before Check or Export starts; any changed source file missing from the manifest fails the run. The checkpoint diff remains the user-visible review and revert surface.

Desktop runs pass an `AbortSignal` from the Electron main-process run registry into the adapter. On macOS and Linux the command runner owns an isolated process group, so cancellation and timeout send `SIGTERM` to the full command tree and escalate the group to `SIGKILL` after the grace period. Windows retains the direct-process fallback until a native tree-termination adapter is added. The run becomes terminal only after process-tree cleanup and bounded pipe drain, and the desktop service must not start Check or Export once aborted. Retry creates a new run id and checkpoint.

These are user-authorized local command executions, not complete OS sandboxes. The AI Engines connection guide must show the detected command and version, authentication state, run readiness, permission summary, local-execution warning, cancellation and diff-review availability, and the next remediation step.

Gemini CLI detection checks installation only. A successful `gemini --version` result does not prove authentication or deck-editing readiness because supported auth modes include interactive sign-in, `GEMINI_API_KEY`, and Vertex AI environment configuration. Gemini remains detection-only until an explicit non-interactive authentication and permission contract is implemented and tested.

## Project Boundary

External agents may edit source areas described by the project-structure spec. Built-in Claude and Codex adapters operate on an isolated copy and apply only checkpoint-derived source writes; Generic commands additionally report writes through their manifest and must account for every changed source file. Any resolved source path that escapes the project, including a symlink escape discovered after the command completes, is a boundary violation.

For desktop headless runs, the review and revert boundary is restricted to deck source covered by the checkpoint: `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`. Generic manifest entries outside that boundary fail the run even if the command exits successfully. Built-in adapters discard temporary changes outside the allowed source set and never apply them to the real project.

After the run completes, `Accept changes` persists the review decision under `.htmlslide/reports/agent-review-<run-id>.json` and closes the review panel. The source checkpoint remains available for a later `Revert changes` action; reverting removes the matching acceptance record. Reopening the project must preserve the accepted/revertable state, so acceptance is not a renderer-only session flag.

Every desktop external-agent run also writes `.htmlslide/reports/agent-run-<run-id>.json` and updates `latest-agent-run.json`. The report contains only the selected provider id/version, authentication command/status, permission summary, relative changed source files, Check/Export status, diff-review state, and revert state. It never contains a temporary workspace path, prompt contents, raw agent output, credentials, or tokens. The release verifier accepts this report only after it contains a distinct successful run with Check, Export, diff review, and revert marked `passed`, plus a cancelled run with no post-cancel Check or Export. Fixture input remains supported through the fixture-only path.

Forbidden writes fail the run even when the command exits successfully. The app should then offer checkpoint revert and show the path.

## Detector Helpers

Claude, Codex, and Gemini detection is implemented as pure helper logic around an injected command runner. Claude uses its stable auth-status command, Codex uses `codex login status`, and Gemini omits authentication detection. Tests must not require real CLI installs, real login state, or provider network access.

The default command names are:

- Claude Code: `claude`
- Codex CLI: `codex`
- Gemini CLI: `gemini`

Callers may override command names and detector args when a provider changes its CLI surface.

## Evidence Boundary

Automated tests use injected runners and controlled fake Claude/Codex executables. They can prove exact argv and working-directory construction, readiness gating, bounded/redacted log transport, timeout and process-group cancellation, checkpoint diffing, Check/Export gating, review, retry, and revert without credentials or network access.

Fake evidence does not prove that a real provider account, subscription, CLI version, login, or packaged macOS artifact works. A public compatibility claim for Claude Code or Codex CLI requires a completed manual release-candidate entry using the exact packaged artifact and the tester's own authenticated installation. Gemini detection evidence must not be promoted into a headless-run claim.

## Failure Types

Adapters use stable failure types:

| Type | Meaning | Remediation |
| --- | --- | --- |
| `agent-not-installed` | CLI is missing or not on `PATH`. | Install the agent CLI, reopen HTMLslide, then detect again. |
| `not-authenticated` | CLI exists but cannot access the user's account. | Log in with the CLI, then reconnect. |
| `subscription-unavailable` | Account, subscription, or API access is unavailable. | Switch AI engine, use API key mode, or resolve provider access. |
| `command-failed` | Agent command exited non-zero. | Open Developer Console, inspect logs, and copy a repair prompt if needed. |
| `user-denied-permission` | User denied a permission request. | Review the requested access and rerun with project-scoped permission. |
| `forbidden-file-write` | Agent changed or reported a write outside allowed deck source. | Revert checkpoint, inspect the path, and rerun with stricter instructions. |
| `check-still-failing` | Agent completed but `htmlslide check` still has errors. | Copy the check report into a repair prompt or switch engine. |
| `run-timeout` | Agent exceeded the configured timeout. | Increase timeout, simplify the request, or retry a smaller task. |
| `cancelled` | User or host cancelled the run. | Start a new run when ready. |
| `project-boundary-violation` | Command or path resolves outside the project. | Choose project-local inputs and inspect unexpected writes. |
| `template-render-error` | Generic command template is malformed or missing a variable. | Fix placeholders and retry the connection test. |
