# HTMLslide

HTMLslide is a local-first desktop workbench and CLI for AI-agent-native HTML/PDF slide decks. It keeps deck source in normal project folders, runs checks and exports through a shared CLI/compiler path, and packages presenter artifacts for rehearsal or audience display.

## Quick start

1. Read the public alpha docs: [docs/index.md](docs/index.md).
2. Install the current macOS alpha package from a trusted build artifact.
3. Open `HTMLslide.app`, choose a workspace, and finish setup.
4. Create or open a deck, run Check, export PDF/deckpkg, and open Presenter Mode. For a credential-free walkthrough, follow [First Presentation Walkthrough](docs/examples/first-presentation.md).

## Current alpha status

The current alpha path is useful for testing and contribution, but public production distribution is not complete. Current alpha artifacts are unsigned alpha builds: they are not Developer ID signed, not notarized, and may trigger Gatekeeper warnings.

Automated CI covers unit tests, desktop Electron E2E, package smoke, CLI provisioning, official skills installation, deckpkg opening, and mock/fake provider paths. Real BYOK provider credentials and real Claude/Codex/Gemini integrations require manual validation before release claims.

See [docs/alpha-readiness.md](docs/alpha-readiness.md) for the current automated coverage map and required manual release-candidate evidence.

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm docs:build
pnpm version:check
pnpm build
pnpm e2e:desktop
```

Public documentation is checked and built with:

```bash
pnpm docs:check
pnpm docs:build
pnpm version:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md), and [docs/testing.md](docs/testing.md).
