# Contributing

HTMLslide welcomes scoped contributions that preserve local-first project boundaries.

## development contract

- Read `HTMLslide_Product_Development_Plan.md`.
- Read relevant specs in `docs/spec/`.
- Do not commit secrets, provider tokens, private decks, or generated logs containing sensitive data.
- Keep GUI and CLI behavior backed by shared packages.
- Add tests for behavior changes.

## no secrets

API keys must never be committed or written to fixtures, reports, crash logs, or workflow artifacts.

## tests

Run the narrowest relevant command first, then the broader suite when practical:

```bash
pnpm docs:check
pnpm docs:build
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e:desktop
```

See [../CONTRIBUTING.md](../CONTRIBUTING.md) for repository contribution rules.
