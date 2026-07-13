# HTMLslide CLI Spec

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same local project format used by the desktop app.

Initial commands:

- `htmlslide new <name> [--template <id>]` creates a deck project from a built-in template. The default template id is `default`.
- `htmlslide init [--template <id>]` initializes the current folder as a deck project from a built-in template.
- `htmlslide templates list --json` lists built-in deck template metadata.
- `htmlslide open [path] --json` opens a loadable deck project or validated `.deckpkg` in the configured macOS app.
- `htmlslide dev [path] [--port <port>] [--json]` starts a bounded loopback preview server for a deck project.
- `htmlslide check [path] --json` discovers `deck.json` from a project root, nested source path, or direct `deck.json` path, then validates schema, files, notes, and source rules.
- `htmlslide repair --for claude|codex|generic [path] --json` runs the shared check read-only and emits a sanitized, prompt-only repair request. It never invokes an external agent or writes source files, `.htmlslide` reports, or `exports/`.
- `htmlslide export [path] --pdf --html --deckpkg --thumbnails` creates export artifacts plus `exports/export-manifest.json` after a successful check. When an output flag is omitted, the command uses the corresponding `deck.json` `export` value.
- `htmlslide export [path] --no-pdf --no-deckpkg --no-thumbnails` skips selected artifacts while still writing required sidecars such as `notes.json`.

Each explicit `--pdf`/`--no-pdf`, `--html`/`--no-html`, `--deckpkg`/`--no-deckpkg`, or `--thumbnails`/`--no-thumbnails` flag overrides only that manifest default for the current invocation. CLI flags do not rewrite `deck.json`; GUI export selections are persisted back to the manifest.
- `htmlslide package [path] --json` checks a project and exports its portable `.deckpkg` plus required package sidecars.
- `htmlslide present [file] --json` validates a `.deckpkg`, or checks and packages a project, then opens presenter mode in the configured macOS app.
- `htmlslide skill list [--project <path>] --json` lists official skills plus installed integrity state.
- `htmlslide skill add <path-or-url> [--project <path>] [--location project codex claude] [--yes] --json` validates and atomically installs an official, local, or HTTPS skill source.
- `htmlslide skill inspect <name> [--project <path>] --json` returns official metadata and installed ownership/integrity details.
- `htmlslide skill remove <name> [--project <path>] --yes --json` removes only integrity-verified HTMLslide-managed installs.
- `htmlslide mcp [path]` starts the project-scoped stdio MCP server and reserves stdout for MCP protocol messages.
- `htmlslide mcp --list-tools --json` lists registered MCP tool descriptors, safety labels, and implementation status.
- `htmlslide mcp [path] --status --json` validates the project-scoped MCP in-process harness for a deck project and returns the project root plus registered and implemented tool counts.
- `htmlslide setup install-cli` installs or updates the local `htmlslide` command shim.
- `htmlslide setup uninstall-cli` removes an HTMLslide-managed command shim.
- `htmlslide setup status --json` reports shim installation status.
- `htmlslide doctor --json` reports local runtime health.
- `htmlslide agent validate-provider --provider openai|anthropic|compatible --model <model> --api-key-env <ENV_NAME> [--base-url <url>] --json` validates BYOK credential/model reachability without printing or accepting an API key as a CLI argument.
- `htmlslide agent test <engine> [--path <dir>] --json` runs a read-only engine preflight. Supported engines are `claude-code`, `codex-cli`, `gemini-cli`, and `htmlslide-mock`; Claude/Codex checks version, authentication, and the fixed headless contract, while Gemini is detection-only.
- `htmlslide agent run --engine htmlslide-mock --task <task> [--speaker-notes <mode>] --path <project> --json` runs the deterministic agent; `<mode>` is `none`, `bullet-notes`, `full-script`, or `rehearsal-cues`.
- `htmlslide rc byok --project <path> --provider openai|anthropic|compatible --model <model> --api-key-env <ENV_NAME> --task <brief> [--target-slide-count 8..12] [--base-url <url>] [--commit <commit>] [--artifact-url <url-or-label>] --json` validates a real provider, runs the provider-backed agent, forces PDF/deckpkg/thumbnail export, and writes sanitized run-bound evidence under `.htmlslide/reports/rc-evidence-<run-id>/`. It requires the exact 8-12 slide target and a zero-error authoritative Check.
- `pnpm rc:byok-evidence -- --project <path> --provider-validation <validation.json> [--run-id <id>] [--report <agent-report.json>] [--output <evidence.json>]` verifies a completed desktop BYOK run without reading provider credentials.

## Local Dev Preview

`htmlslide dev [path]` binds only to `127.0.0.1`. The default port is `4173`; `--port 0` requests an ephemeral port and is intended for tests and parallel local sessions. The server is a read-only preview surface: it does not write source files, `.htmlslide/`, or `exports/`.

The server exposes only `GET` and `HEAD` requests for:

- `/`: a small HTML index with one link per manifest slide.
- `/<slide.source>`: the project-relative route for that slide, served by the compiler's canonical `buildSlidePreviewDocument` API. Referenced local assets are therefore handled by the shared preview builder rather than by generic static-file serving.

Unknown routes, traversal segments, backslashes, malformed encoded paths, and direct requests for project files return `404`. Other methods return `405` with `Allow: GET, HEAD`.

With `--json`, startup metadata uses the normal success envelope and contains no project path:

```json
{
  "status": "passed",
  "command": "dev",
  "host": "127.0.0.1",
  "port": 4173,
  "origin": "http://127.0.0.1:4173",
  "indexPath": "/",
  "slides": [
    { "id": "001-title", "title": "Title", "path": "/slides/001-title.html" }
  ]
}
```

The process remains alive until `SIGINT` or `SIGTERM`; the exported `startDevServer` helper returns the same metadata plus an async `close()` for deterministic tests.

Exit codes:

- `0` success
- `1` generic error
- `2` validation failed
- `3` export failed
- `4` missing dependency
- `5` permission denied
- `6` agent failed
- `7` project not found
- `8` incompatible schema

All important commands must support JSON output suitable for external agents.
When `--json` is present, missing arguments, unknown options, and other Commander parsing failures return the normal failed JSON envelope with `code: "CLI_ARGUMENT_ERROR"` instead of human-only stderr.

## Export Commit Contract

`htmlslide export` acquires a project-level export lock and builds every requested output from one source snapshot in a private staging directory. It commits artifact files first and atomically replaces the compiler-owned `exports/export-manifest.json` last. Concurrent export attempts for the same project or transaction failures use export-failed exit code `3` and must not publish a new commit marker.

A partial export writes a manifest containing exactly that invocation's artifacts and removes only previously manifest-owned artifacts that the invocation omits. `htmlslide check` treats a missing manifest as a legacy-project warning with mtime fallback; a present but invalid or truncated manifest is an error and fails closed without that fallback.

`htmlslide package` uses the same compiler transaction and exit-code contract as `htmlslide export`. It means deck package creation, not packaging or signing `HTMLslide.app`. A deckpkg contains its own PDF, HTML, notes, settings, and thumbnails; the compiler may also publish required notes and thumbnail sidecars, but does not publish standalone PDF or HTML artifacts for this command.

## Desktop Launch Contract

`htmlslide open` and `htmlslide present` read the app path recorded by CLI provisioning. The runtime invokes macOS `/usr/bin/open` with an argument array and never interpolates a shell command. A missing, malformed, moved, or non-app-bundle target returns missing-dependency exit code `4` with a repair instruction.

- `open` loads and validates project metadata before starting the App. Direct `.deckpkg` input must pass presenter package validation first.
- `present` accepts a project directory or `.deckpkg`. Project input runs `check`, creates a fresh package with the shared compiler, validates it with `@htmlslide/presenter`, and then starts presenter mode.
- Missing projects return `7`; project/schema/package validation failures return `2` or `8`; compiler transaction failures return `3`.
- Successful JSON output contains `status`, `command`, `appPath`, `targetPath`, and `targetKind`. It reports that the launch request was accepted; presenter window lifetime is owned by the App.

## Skill Commands

Without `--project`, skill commands use the global HTMLslide state root (`HTMLSLIDE_HOME` in controlled environments, otherwise `~/.htmlslide`). Project targets must resolve to a valid deck project. `--location` is valid only with `--project` and accepts `project`, `codex`, and `claude`; the default is `project`.

`skill add` accepts an official registry name, a local `SKILL.md`, a local skill directory, or a direct HTTPS Markdown URL. The shared skills package validates metadata, source paths, source size, declared risk, and license compatibility before writing. URL requests use bounded responses and redirects and reject local/private network targets. Warning-level script, network, asset, high-risk, or license declarations require `--yes`; error-level plans are never installable.

Managed installs contain `.htmlslide-managed.json` with deterministic file digests. Updates use staging and rollback. `skill remove` requires `--yes` and refuses unmanaged, modified, invalid, symlinked, or path-escaping targets. `skill list` and `skill inspect` report `verified`, `modified`, `unmanaged`, or `invalid` integrity without executing skill content.

## Templates

Built-in deck templates are resolved by id. Unknown ids must fail before any project files are written. The current public alpha template registry contains:

```json
[
  { "id": "default", "name": "Default", "slideCount": 2 },
  { "id": "swiss-editorial", "name": "Swiss Editorial", "slideCount": 2 },
  { "id": "consulting-clean", "name": "Consulting Clean", "slideCount": 2 },
  { "id": "technical-dark", "name": "Technical Dark", "slideCount": 2 },
  { "id": "product-launch", "name": "Product Launch", "slideCount": 2 },
  { "id": "data-report", "name": "Data Report", "slideCount": 2 }
]
```

`new` and `init` write only source/project files such as `deck.json`, `README.md`, `AGENTS.md`, `slides/`, `notes/`, and `theme/`. They must not write generated `exports/` files or secrets.

## CLI Provisioning

`htmlslide setup install-cli` writes a small executable shim named `htmlslide`.

Target selection:

- `--target-path <path>` writes to an explicit file path.
- `--target-dir <dir>` writes `<dir>/htmlslide`.
- Without an explicit target, the CLI uses `~/.htmlslide/bin/htmlslide`.
- Tests and controlled environments may set `HTMLSLIDE_HOME` to move the default state directory away from the real user home.

Safety rules:

- The installer may update an existing HTMLslide-managed shim.
- The installer must not overwrite a pre-existing unrelated `htmlslide` file, symlink, or directory.
- The uninstaller must remove only an HTMLslide-managed shim.
- Explicit unwritable targets fail with exit code `5`.

App integration:

- `htmlslide setup install-cli --app-path <HTMLslide.app>` records `~/.htmlslide/app-path.json`.
- `--bundle-id`, `--app-version`, and `--updated-at` add app metadata used by the desktop app to detect stale or moved installs.
- The shim reads `~/.htmlslide/app-path.json` at runtime and prefers the app-packaged CLI entry when present.
- If no app CLI is available, the shim falls back to the development/package CLI path recorded when the shim was installed.
- The desktop app chooses a writable target in this order: `HTMLSLIDE_CLI_TARGET_PATH`/`HTMLSLIDE_CLI_TARGET_DIR` overrides, `/opt/homebrew/bin`, `/usr/local/bin`, then `~/.htmlslide/bin`.

`app-path.json` records the app the shim should prefer:

```json
{
  "schemaVersion": 1,
  "appPath": "/Applications/HTMLslide.app",
  "bundleId": "app.htmlslide.alpha",
  "version": "0.1.0",
  "updatedAt": "2026-07-08T10:00:00.000Z"
}
```

Setup commands support `--json`. Successful install output includes:

```json
{
  "status": "passed",
  "command": "setup install-cli",
  "action": "installed",
  "targetPath": "/Users/alice/.htmlslide/bin/htmlslide",
  "targetDir": "/Users/alice/.htmlslide/bin",
  "htmlslideHomeDir": "/Users/alice/.htmlslide",
  "appPathJson": "/Users/alice/.htmlslide/app-path.json",
  "message": "Installed HTMLslide CLI shim at /Users/alice/.htmlslide/bin/htmlslide."
}
```

Actionable setup errors use the generic error envelope with stable fields:

```json
{
  "status": "failed",
  "error": "Refusing to overwrite existing non-HTMLslide command at /usr/local/bin/htmlslide.",
  "code": "CLI_SHIM_CONFLICT",
  "exitCode": 1,
  "suggestedFix": "Choose another --target-path or remove the unrelated command manually.",
  "targetPath": "/usr/local/bin/htmlslide"
}
```

`agent validate-provider --json` returns sanitized provider preflight evidence:

```json
{
  "status": "passed",
  "command": "agent validate-provider",
  "provider": "openai",
  "model": "gpt-5-mini",
  "apiKeyEnv": "OPENAI_API_KEY",
  "credential": {
    "ok": true,
    "providerId": "htmlslide-provider-validation"
  },
  "secretRecorded": false,
  "exitCode": 0
}
```

Validation failures return the same shape with `"status": "failed"`, a sanitized `credential.reason`, and exit code `6`. Missing or invalid CLI inputs use the generic error envelope with stable `AGENT_PROVIDER_*` codes. The command must never accept a raw API key argument and must not include the environment variable value in stdout, stderr, reports, or logs.

`rc:byok-evidence` is a repository release command rather than a provider runner. It performs no provider network calls. It fails unless the provider validation passed, the desktop report and requested run id agree, provider/model and compatible endpoint bindings agree, an explicit 8-12 slide target matches the accepted outline and final deck, provider source writes were applied, the file-copy checkpoint manifest and snapshots exist, authoritative desktop CLI check/export passed, current source fingerprints match the export source digest, and every export-manifest artifact matches its size and SHA-256. Evidence output must stay under the project's `.htmlslide/reports/` directory and contains only sanitized metadata, relative artifact paths, byte sizes, and SHA-256 digests.

`htmlslide rc byok` is the single-command path for producing that run-bound evidence from a real provider. It validates credentials first, runs the shared CLI agent path, forces PDF/deckpkg/thumbnail outputs, and writes a provider-validation record plus sanitized evidence atomically under a run-specific project-local directory. It does not read or write API key values. The completed evidence still requires manual RC confirmation that the candidate commit and artifact labels identify the exact packaged build tested.

`check --json` must return a machine-readable report even when project loading fails. The report shape is:

```json
{
  "status": "failed",
  "projectPath": "/path/or/input",
  "summary": {
    "errors": 1,
    "warnings": 0,
    "suggestions": 0,
    "info": 0
  },
  "issues": [
    {
      "slideId": "deck",
      "severity": "error",
      "type": "missing-slide-source",
      "message": "No deck.json found for /path/or/input.",
      "suggestedFix": "Run htmlslide from a deck project or pass a path containing deck.json.",
      "agentInstruction": "Locate the deck project root before running check or export."
    }
  ]
}
```

`repair --for claude|codex|generic [path] --json` returns the same shared check summary and issue details without the absolute project path. Its `prompt` includes the current slide ids and these mandatory repair constraints: do not edit `exports/`, do not change slide ids, keep the fixed `1920x1080` viewport, compress content before changing layout and reduce font size only as a last resort, and run `htmlslide check --json` after every repair. A failing check returns validation exit code `2`; project-loading failures preserve exit codes `7`, `8`, or `5` as applicable. Invalid `--for` values use the generic exit code `1`. The result also states `readOnly: true`, `externalAgentExecuted: false`, and zero writes for source and `exports/`.
