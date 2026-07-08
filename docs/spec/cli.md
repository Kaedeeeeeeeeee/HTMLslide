# HTMLslide CLI Spec

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same local project format used by the desktop app.

Initial commands:

- `htmlslide new <name>` creates a deck project from the default template.
- `htmlslide init` initializes the current folder as a deck project.
- `htmlslide check [path] --json` validates schema, files, notes, and basic source rules.
- `htmlslide export [path] --pdf --html --deckpkg --thumbnails` creates export artifacts.
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

