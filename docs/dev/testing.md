# Testing

HTMLslide tests start with the package scripts and expand into fixtures as the app is built. CI expects these root commands to exist:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Required root package contract:

- `packageManager` pinned to a pnpm version.
- `pnpm-lock.yaml` committed.
- `lint`, `typecheck`, `test`, and `build` scripts in `package.json`.
- `package:alpha` script before unsigned alpha packaging is enabled.

## Test Layers

Use deterministic fixtures and avoid real provider credentials in automated tests.

- Unit tests: path resolver, project loader, manifest parser, schema validator, slide id validator, safe area calculation, issue severity aggregation, export manifest building, skill metadata parsing.
- Schema tests: valid minimal deck, valid full deck, missing slide source, duplicate slide id, invalid viewport, invalid safe area, unsupported schema version.
- CLI E2E tests: `htmlslide new`, `htmlslide check --json`, `htmlslide export --pdf --deckpkg`, `htmlslide package`, `htmlslide doctor`.
- Compiler regression tests: golden decks for minimal, text-heavy, data chart, image-heavy, notes, and multi-theme decks.
- Linter tests: overflow, safe area, contrast, remote font, missing notes, and valid clean fixtures.
- Agent tests: use mock model providers and fake external commands. CI must not require real Claude Code, Codex, or provider login.
- MCP tests: verify server startup, tool listing, path boundary enforcement, schema-valid reports, and artifact creation.
- Electron and presenter tests: cover onboarding, workspace choice, mock agent deck creation, preview, checks, export, rehearsal mode, settings, notes, next/previous navigation, timer, and keyboard shortcuts.
- Packaging tests: unsigned CI build, DMG/package smoke checks, first-run setup, CLI shim install/repair/uninstall, and `htmlslide doctor`.
- Security tests: API keys absent from logs/project files, protected-mode write boundaries, MCP traversal denial, third-party skill warnings, remote asset detection, malformed deckpkg rejection.
- Performance tests: track warm project open, single-slide render, 20-slide export, 20-slide check, and presenter next-slide latency.

## Desktop E2E Smoke

Run the intentional Electron smoke path when changing the desktop shell, preload/IPC wiring, project library, or packaging-adjacent app startup behavior:

```bash
pnpm e2e:desktop
```

For local debugging with the app window visible:

```bash
pnpm e2e:desktop:headed
```

The smoke test builds `@htmlslide/desktop`, launches the built Electron main process with Playwright, verifies the app loads without a Vite/framework error overlay, skips onboarding into No AI mode, reaches the project library, mocks the native folder picker, and opens `packages/test-fixtures/decks/valid-full`.

Artifacts are written under `tmp/playwright/` so they stay out of release artifacts and normal source diffs. This is a foundation smoke, not full coverage for first-run setup, BYOK providers, presenter mode, or native packaging install flows.

## Packaging Verification

Unsigned macOS alpha packaging is intentionally separate from default CI because it requires macOS tooling and can be slower than unit checks:

```bash
pnpm verify:package:alpha
```

This command delegates to the existing alpha package flow. On macOS it builds the desktop app, creates the unsigned `.app`, DMG, ZIP, and manifest under `dist/alpha`, and performs the package script's built-in existence checks for the Electron main process, preload, and renderer output.

The `Alpha Package` GitHub Actions workflow remains the CI packaging verifier for scheduled, tagged, and manual runs. Do not add provider credentials or local machine state to this path.

## Visual Regression

Golden deck output should include PNG comparisons and PDF metadata checks. Start with the plan thresholds unless the baseline proves unrealistic:

- Small thumbnails: at most 0.5 percent diff.
- Full slide screenshots: at most 0.2 percent diff.

When a diff fails in CI, upload `before.png`, `after.png`, and `diff.png` as workflow artifacts.

## Manual Release Smoke

Each release candidate should be tested once on a clean macOS user account:

1. Install the DMG or unsigned alpha package.
2. Launch the app.
3. Complete first-run setup.
4. Create a deck with the mock/local provider.
5. Create a deck with a BYOK provider when a test key is available.
6. Connect a fake external agent.
7. Export PDF and deckpkg.
8. Present on an external monitor.
9. Reopen the project.
10. Revert an agent run.
11. Uninstall the CLI shim.
12. Delete the app and confirm no unexpected system files remain.

## Contribution Expectations

When changing behavior, update the narrowest relevant tests first. Changes to CLI output need CLI E2E coverage, renderer changes need visual regression fixture updates, skill spec changes need skill docs updates, and core behavior changes need unit/schema coverage.
