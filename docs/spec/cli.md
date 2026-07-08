# HTMLslide CLI Spec

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same local project format used by the desktop app.

Initial commands:

- `htmlslide new <name>` creates a deck project from the default template.
- `htmlslide init` initializes the current folder as a deck project.
- `htmlslide check [path] --json` discovers `deck.json` from a project root, nested source path, or direct `deck.json` path, then validates schema, files, notes, and source rules.
- `htmlslide export [path] --pdf --html --deckpkg --thumbnails` creates export artifacts after a successful check.
- `htmlslide export [path] --no-pdf --no-deckpkg --no-thumbnails` skips selected artifacts while still writing required sidecars such as `notes.json`.
- `htmlslide setup install-cli` installs or updates the local `htmlslide` command shim.
- `htmlslide setup uninstall-cli` removes an HTMLslide-managed command shim.
- `htmlslide setup status --json` reports shim installation status.
- `htmlslide doctor --json` reports local runtime health.

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
- The shim reads `~/.htmlslide/app-path.json` at runtime and prefers the app-packaged CLI entry when present.
- If no app CLI is available, the shim falls back to the development/package CLI path recorded when the shim was installed.

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
