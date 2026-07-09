# Testing

The standard local checks are:

```bash
pnpm docs:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:desktop
```

Packaging smoke:

```bash
pnpm package:alpha
pnpm smoke:package:alpha
```

## Coverage expectations

- Unit tests cover core, CLI, compiler, linter, agent, MCP, skills, and desktop services.
- Desktop Electron E2E covers onboarding, project library, mock generation, checks, export, presenter, deckpkg open, CLI setup, and official skills setup.
- package smoke covers DMG mount, packaged app launch, first-run CLI shim, official skills, moved-app CLI repair, deckpkg argument open, packaged CLI export, `htmlslide doctor`, and CLI uninstall.

CI uses mock providers and fake external commands. Real provider credentials and real Claude/Codex login must remain manual validation steps.

See [dev/testing.md](dev/testing.md) for developer-level details.
