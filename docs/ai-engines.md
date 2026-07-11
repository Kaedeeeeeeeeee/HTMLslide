# AI Engines

HTMLslide alpha has three visible engine modes.

## No AI

No AI can open projects, preview slides, run Check, export artifacts, and present existing decks. It does not generate new deck content.

## HTMLslide Agent

HTMLslide Agent is the BYOK path. It uses a provider API key stored outside project files and writes project source through the controlled source-write path.

See [BYOK](byok.md).

## External Agent Mode

External agent mode runs a user-owned coding agent as a local process against an opened deck project.

| Adapter | Current product capability | Ready when |
| --- | --- | --- |
| Claude Code | Built-in fixed headless adapter | Local CLI is installed/authenticated and exposes every required headless flag |
| Codex CLI | Built-in fixed headless adapter | `codex login status` succeeds and every required headless flag is available |
| Gemini CLI | Detection-only | Not eligible for HTMLslide headless runs |
| Generic command | User-defined argv template | A valid command template is saved |

The connection guide separates detection and authentication from run readiness. It shows the local command/version, permission summary, whether headless run, cancellation, and diff review are available, and the next remediation step.

### Local Execution And Permissions

Claude Code and Codex CLI run locally in an OS-temporary copy of the deck source using the user's existing CLI login. HTMLslide assembles fixed argv arrays and does not execute interpolated shell text. Only checkpoint-derived changes under `deck.json`, `slides/`, `notes/`, `theme/`, and `assets/` are copied back; unrelated temporary changes are discarded.

The Claude adapter allows only `Read`, `Glob`, `Grep`, `Edit`, and `Write`; empty setting sources and strict MCP mode prevent user/project settings, MCP servers, skills, plugins, hooks, browser integration, Bash, and network tools from broadening the run while preserving existing login. The Codex adapter uses an ephemeral `workspace-write` run and ignores user config. HTMLslide verifies the required command flags before marking either adapter ready. These controls reduce access, but external agents remain user-authorized local tooling rather than complete OS sandboxes.

### Checkpoint, Cancellation, And Review

HTMLslide creates a checkpoint before launch and derives the source diff after the command finishes. HTMLslide, not the external agent, owns Check, Export, the changed-file review, and revert. Cancel terminates the local process group and prevents later Check or Export from starting; retry creates a new run and checkpoint.

Generic command mode keeps its write-manifest contract for user-owned integrations, with the same checkpoint diff used for review. Gemini remains detection-only because its authentication options and non-interactive permission contract have not been defined and tested.

### Evidence Boundary

CI uses fake Claude, Codex, and Generic commands. Automated evidence proves the invocation, permission flags, readiness gating, bounded/redacted logs, cancellation, checkpoint diff, Check/Export gate, review, and revert contracts without provider credentials or network access.

Fake automation does not validate a real account, subscription, installed CLI version, or packaged app. A public Claude Code or Codex compatibility claim requires manual validation with the tester's own authenticated installation and the exact release-candidate artifact. Gemini detection must not be described as headless deck-editing support.

See [Connect Claude Code](connect-claude-code.md), [Connect Codex](connect-codex.md), and [Connect Gemini CLI](connect-gemini.md).
