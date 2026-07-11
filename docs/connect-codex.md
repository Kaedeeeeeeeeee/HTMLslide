# Connect Codex

HTMLslide includes a built-in adapter for running an authenticated, user-owned Codex CLI installation against a local deck project.

## What HTMLslide Checks

The AI Engines page performs local detection for the `codex` command, records its version, runs `codex login status`, and verifies every fixed headless flag against `codex exec --help`. HTMLslide does not read or store account credentials. The adapter becomes ready only when installation, authentication, and command-contract checks all pass.

If the built-in detection does not match a user-managed installation, Generic external agent mode remains available for an explicit custom command template.

## Permissions And Local Execution

HTMLslide starts `codex exec` as a local child process in an OS-temporary copy of the deck source. It uses the user's existing Codex login and does not send credentials or the real project path through the task prompt.

The built-in run uses the `workspace-write` sandbox, an ephemeral session, JSON output, and `--ignore-user-config`. Ignoring user config prevents a local profile from silently adding MCP servers, hooks, or broader behavior; project-local `AGENTS.md` guidance remains available. `workspace-write` is the least Codex mode that permits deck source edits.

This remains user-authorized local command execution, not a complete OS sandbox. Review the requested task before starting the run and review the resulting file diff before keeping it.

## Run, Cancel, And Review

Before Codex starts, HTMLslide creates a reversible checkpoint for `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`, then creates the isolated copy. Codex is instructed not to edit `exports/` or HTMLslide runtime files. When the command exits, HTMLslide rejects source symlinks, confirms the real source still matches the run-start digests, and copies back only allowed deck source. Concurrent editor changes fail without being overwritten.

HTMLslide then runs Check and exports only if Check passes. The review shows changed and added source files and can revert them to the pre-run checkpoint.

Cancel terminates the local Codex process group and prevents later Check or Export work from starting. A retry is a new ephemeral run with a new checkpoint; it does not resume the cancelled session.

## Manual Validation And Release Evidence

Automated tests use a fake `codex` executable. They verify detection, `codex login status`, fixed arguments, sandbox flags, local working directory, log redaction and bounds, cancellation, checkpoint diff, Check/Export gating, and revert without a real login or network access.

That fake evidence is not proof that a real Codex account, subscription, CLI version, or packaged HTMLslide release candidate works. Before making a public Codex compatibility claim for a release:

1. Use the exact packaged RC artifact on the target macOS environment.
2. Complete detection and `codex login status` with the tester's own Codex installation.
3. Run a source-editing deck task without exposing credentials.
4. Cancel a second run and confirm no later Check or Export starts.
5. Inspect the changed-file diff, run Check/Export, and verify checkpoint revert.
6. Attach the result to the completed RC evidence for that artifact.

Until that manual validation is complete, release notes may state that the built-in adapter and fake automation exist, but must not claim validated real-account compatibility.
