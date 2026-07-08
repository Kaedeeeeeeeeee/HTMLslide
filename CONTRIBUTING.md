# Contributing

HTMLslide is a local-first presentation studio for AI-generated HTML/PDF decks. The product plan prioritizes deterministic project formats, shared CLI/GUI behavior, mockable agent flows, and safe local boundaries.

## Before Editing

- Read `HTMLslide_Product_Development_Plan.md`.
- When available, read `docs/spec/deck.md`, `docs/spec/cli.md`, and `docs/spec/skills.md`.
- Keep generated exports out of normal feature patches unless a test fixture explicitly requires them.
- Do not commit API keys, provider tokens, private deck contents, or logs containing secrets.
- Do not add undeclared external network access.

## Development Contract

Root package scripts are expected to expose:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Unsigned alpha packaging additionally expects:

```bash
pnpm package:alpha
```

Run the narrowest relevant test first, then the broader suite when practical.

## Testing Rules

- Core behavior changes need unit or schema tests.
- CLI output changes need CLI E2E tests.
- Renderer/compiler changes need golden fixture or visual regression updates.
- Linter issue changes need dedicated fixtures.
- Agent orchestration tests must use mock providers.
- External agent tests must use fake commands in CI.
- MCP and file-write tests must verify project-boundary enforcement.
- Security-sensitive changes must verify secrets are not written to logs or project files.

## Pull Requests

PRs should include a short summary, tests run, screenshots or artifact links for UI/export changes, and any breaking changes. Keep PRs scoped to one ownership area where possible.

## Skill and Template Contributions

Official skill packs must use compatible licenses such as Apache-2.0 or MIT. Third-party skills with incompatible licenses must not be bundled in the official repo; they can be listed for user-initiated install only when license and risk information is visible.
