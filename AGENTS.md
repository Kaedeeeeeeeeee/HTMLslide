# HTMLslide Development Rules

This repository builds HTMLslide, a local-first presentation studio for AI-generated HTML/PDF decks.

Before editing core behavior:

- Read [docs/spec/deck.md](docs/spec/deck.md).
- Read [docs/spec/project-structure.md](docs/spec/project-structure.md).
- Read [docs/spec/cli.md](docs/spec/cli.md).

Rules:

- Do not commit secrets, API keys, or provider tokens.
- Do not modify generated `exports/` unless a test explicitly requires it.
- Keep GUI and CLI behavior backed by shared core packages.
- Add or update tests for behavior changes.
- Prefer deterministic fixtures over snapshotting local machine state.
- Run the narrowest relevant test first, then the full relevant suite when practical.

