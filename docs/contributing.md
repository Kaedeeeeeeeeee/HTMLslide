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

## issue templates

Use GitHub issue forms for bug reports, rendering bugs, external-agent integration bugs, feature requests, and skill contributions. The forms ask for version, platform, reproduction steps, sanitized diagnostics, minimal fixtures, and privacy confirmation so maintainers can locate failures without private deck content.

Public issues must not include API keys, provider tokens, raw provider prompts, private decks, personal data, or unreleased customer material. Report exploitable security issues privately.

## conduct

Follow the [Code of Conduct](code-of-conduct.md). Keep feedback technical, respect private deck content, and use private vulnerability reporting for exploitable security issues.

## tests

Run the narrowest relevant command first, then the broader suite when practical:

```bash
pnpm docs:check
pnpm docs:build
pnpm version:check
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e:desktop
```

See [../CONTRIBUTING.md](../CONTRIBUTING.md) for repository contribution rules.
