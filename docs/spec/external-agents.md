# External Agents Spec v0.1

HTMLslide can connect to user-owned external coding agents such as Claude Code, Codex CLI, Gemini CLI, or a custom command. Adapters must be local-first, deterministic in tests, and project-boundary aware.

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

## Generic Command Templates

Generic adapters render command templates into argv tokens without a shell. Placeholders use `{{name}}` syntax:

```text
my-agent --cwd "{{projectPath}}" --prompt-file "{{promptFile}}"
```

Each placeholder value renders as one argv token, even when it contains spaces. Path placeholders such as `projectPath`, `projectRoot`, `promptFile`, `scriptFile`, and `writeManifest` must resolve inside the HTMLslide project. `projectPath` and `projectRoot` must resolve exactly to the project root.

Adapters must not execute generated shell text. Tests should use injected runners or controlled Node fake commands in temporary project directories.

Generic command runs can stream stdout/stderr chunks through the adapter while still returning the complete stdout/stderr
buffers when the process exits. The desktop external-agent path records redacted chunks as build-stage run logs so
long-running local commands can surface progress before check/export gates run without persisting API keys or bearer
tokens.

## Desktop Generic Command Runs

The desktop app can run a saved Generic command from Electron main for an opened local deck project. The renderer sends only the project path and user brief; Electron reads the saved AI Engine settings, writes `.htmlslide/runs/<runId>/prompt.md` and `.htmlslide/runs/<runId>/writes.json`, then invokes the Generic command with project-local `{{projectPath}}`, `{{projectRoot}}`, `{{promptFile}}`, and `{{writeManifest}}` placeholders.

After the command exits, HTMLslide reads the write manifest, validates reported source writes, records a file-copy checkpoint diff, runs `htmlslide check --json`, and exports only when check passes. This is user-owned local command execution, not an OS sandbox.

Claude Code, Codex CLI, and Gemini CLI are detection-only until their headless command templates are explicitly defined and tested. Gemini CLI detection checks installation by default; authentication must be validated manually or through a future explicit non-interactive check because supported auth modes include interactive sign-in, `GEMINI_API_KEY`, and Vertex AI environment configuration.

## Project Boundary

External agents may edit source areas described by the project-structure spec, but they must not report writes outside the project root. Runs provide a write manifest, and adapter code rejects any reported write whose resolved path escapes the project, including symlink escapes after the command completes.

For desktop headless runs, reported writes are further restricted to deck source files covered by checkpoint/revert: `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`. Reported writes to `exports/` or `.htmlslide/` fail the run even if the command exits successfully.

Forbidden writes fail the run even when the command exits successfully. The app should then offer checkpoint revert and show the reported path.

## Detector Helpers

Claude, Codex, and Gemini detection is implemented as pure helper logic around an injected command runner. The helpers may call version commands and, where a stable non-interactive surface exists, auth-status commands through the runner. Tests must not require real CLI installs, real login state, or provider network access.

The default command names are:

- Claude Code: `claude`
- Codex CLI: `codex`
- Gemini CLI: `gemini`

Callers may override command names and detector args when a provider changes its CLI surface.

## Failure Types

Adapters use stable failure types:

| Type | Meaning | Remediation |
| --- | --- | --- |
| `agent-not-installed` | CLI is missing or not on `PATH`. | Install the agent CLI, reopen HTMLslide, then detect again. |
| `not-authenticated` | CLI exists but cannot access the user's account. | Log in with the CLI, then reconnect. |
| `subscription-unavailable` | Account, subscription, or API access is unavailable. | Switch AI engine, use API key mode, or resolve provider access. |
| `command-failed` | Agent command exited non-zero. | Open Developer Console, inspect logs, and copy a repair prompt if needed. |
| `user-denied-permission` | User denied a permission request. | Review the requested access and rerun with project-scoped permission. |
| `forbidden-file-write` | Agent reported a write outside the project. | Revert checkpoint, inspect the path, and rerun with stricter instructions. |
| `check-still-failing` | Agent completed but `htmlslide check` still has errors. | Copy the check report into a repair prompt or switch engine. |
| `run-timeout` | Agent exceeded the configured timeout. | Increase timeout, simplify the request, or retry a smaller task. |
| `cancelled` | User or host cancelled the run. | Start a new run when ready. |
| `project-boundary-violation` | Command template references a path outside the project. | Choose project-local prompt, manifest, or output paths. |
| `template-render-error` | Command template is malformed or missing a variable. | Fix placeholders and retry the connection test. |
