# Connect Claude Code

HTMLslide includes a built-in adapter for running an authenticated, user-owned Claude Code installation against a local deck project.

## What HTMLslide Checks

The AI Engines page performs local detection for the `claude` command, records its version, checks authentication without reading or storing account credentials, and verifies every fixed headless flag against `claude --help`. The adapter becomes ready only when installation, authentication, and command-contract checks all pass.

If the built-in detection does not match a user-managed installation, Generic external agent mode remains available for an explicit custom command template.

## Permissions And Local Execution

HTMLslide starts Claude Code as a local child process in an OS-temporary copy of the deck source. It uses the user's existing Claude Code login and does not send credentials or the real project path through the task prompt.

The built-in command runs in non-interactive print mode with session persistence disabled. It grants only `Read`, `Glob`, `Grep`, `Edit`, and `Write`; empty setting sources, strict MCP mode, disabled slash commands, and disabled Chrome integration exclude project/user settings, Bash, network tools, MCP servers, skills, plugins, hooks, and browser integration without disabling the existing OAuth/Keychain login. Edit permission is accepted for the requested run so Claude can change deck source without stopping for an interactive terminal prompt.

This is restricted user-authorized local tooling, not a complete OS sandbox. Review the requested task before starting the run and review the resulting file diff before keeping it.

## Run, Cancel, And Review

Before Claude starts, HTMLslide creates a reversible checkpoint for `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/`, then creates the isolated copy. Claude is instructed not to edit `exports/` or HTMLslide runtime files. When the command exits, HTMLslide rejects source symlinks, confirms the real source still matches the run-start digests, and copies back only allowed deck source. Concurrent editor changes fail without being overwritten.

HTMLslide then runs Check and exports only if Check passes. The review shows changed and added source files and can revert them to the pre-run checkpoint.

Cancel terminates the local Claude process group and prevents later Check or Export work from starting. A retry is a new run with a new checkpoint; it does not resume the cancelled Claude session.

## Manual Validation And Release Evidence

Automated tests use a fake `claude` executable. They verify detection, fixed arguments, permission flags, local working directory, log redaction and bounds, cancellation, checkpoint diff, Check/Export gating, and revert without a real login or network access.

That fake evidence is not proof that a real Claude account, subscription, CLI version, or packaged HTMLslide release candidate works. Before making a public Claude Code compatibility claim for a release:

1. Use the exact packaged RC artifact on the target macOS environment.
2. Complete detection and authentication with the tester's own Claude Code installation.
3. Run a source-editing deck task without exposing credentials.
4. Cancel a second run and confirm no later Check or Export starts.
5. Inspect the changed-file diff, run Check/Export, and verify checkpoint revert.
6. Attach the result to the completed RC evidence for that artifact.

Until that manual validation is complete, release notes may state that the built-in adapter and fake automation exist, but must not claim validated real-account compatibility.
