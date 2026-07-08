# HTMLslide CLI Spec

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same local project format used by the desktop app.

Initial commands:

- `htmlslide new <name>` creates a deck project from the default template.
- `htmlslide init` initializes the current folder as a deck project.
- `htmlslide check [path] --json` discovers `deck.json` from a project root, nested source path, or direct `deck.json` path, then validates schema, files, notes, and source rules.
- `htmlslide export [path] --pdf --html --deckpkg --thumbnails` creates export artifacts after a successful check.
- `htmlslide export [path] --no-pdf --no-deckpkg --no-thumbnails` skips selected artifacts while still writing required sidecars such as `notes.json`.
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
