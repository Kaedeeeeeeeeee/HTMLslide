# Testing

HTMLslide tests start with the package scripts and expand into fixtures as the app is built. CI expects these root commands to exist:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:desktop
```

Required root package contract:

- `packageManager` pinned to a pnpm version.
- `pnpm-lock.yaml` committed.
- `lint`, `typecheck`, `test`, `build`, and `e2e:desktop` scripts in `package.json`.
- `package:alpha` and `smoke:package:alpha` scripts before unsigned alpha packaging is enabled.

## Test Layers

Use deterministic fixtures and avoid real provider credentials in automated tests.

- Unit tests: path resolver, project loader, manifest parser, schema validator, slide id validator, safe area calculation, issue severity aggregation, export manifest building, skill metadata parsing.
- Schema tests: valid minimal deck, valid full deck, missing slide source, duplicate slide id, invalid viewport, invalid safe area, unsupported schema version.
- CLI E2E tests: `htmlslide new`, `htmlslide check --json`, `htmlslide export --pdf --deckpkg`, `htmlslide package`, `htmlslide doctor`.
- Compiler regression tests: golden decks for minimal, text-heavy, data chart, image-heavy, notes, and multi-theme decks, including byte-exact fallback thumbnail PNG baselines for deterministic compiler output.
- Linter tests: `linter-text-overflow`, `linter-safe-area`, contrast, remote font, missing notes, and valid clean fixtures.
- Agent tests: use mock model providers, fake BYOK provider factories, injected fake fetch implementations, and fake external commands. Source-write tests must verify accepted source roots, parser shapes, duplicate rejection, traversal denial, artifact/private-runtime denial, and no partial writes after validation failure. OpenAI-compatible provider tests must verify model validation requests, Chat Completions structured-output request bodies, `sourceWrites` schemas for build/repair, token-usage mapping, abort-signal forwarding, malformed output rejection, missing source-write rejection, and API-key/error-message sanitization. Anthropic provider tests must verify model validation headers, forced Messages API tool request bodies, `tool_use.input` parsing, usage mapping, abort-signal forwarding, malformed or missing tool-use rejection, missing source-write rejection, unsafe source-write rejection, and API-key/error-message sanitization. BYOK desktop tests must verify Keychain-gated credential loading, compatible base URL metadata, default OpenAI/OpenAI-compatible/Anthropic adapter wiring through injected fake fetch, no secret leakage in logs/results, provider `sourceWrites` application, sanitized `.htmlslide/reports/agent-run-<runId>.json` output, checkpoint diffs, and check/export gating without real provider credentials. Generic command runs must verify project-local prompt/manifest handling, source-write boundaries, checkpoint diffs, and check/export gating. CI must not require real Claude Code, Codex, or provider login.
- MCP tests: verify server startup, tool listing, path boundary enforcement, schema-valid reports, and artifact creation.
- Electron and presenter tests: cover onboarding, workspace choice, mock agent deck creation, preview, checks, export, rehearsal mode, settings, notes, next/previous navigation, timer, and keyboard shortcuts.
- Packaging tests: unsigned CI build, DMG/package smoke checks, first-run setup, CLI shim install/repair/uninstall, and `htmlslide doctor`.
- Security tests: API keys absent from logs/project files/settings JSON, credential-store save/clear behavior through injected fakes, protected-mode write boundaries, MCP traversal denial, third-party skill warnings, remote asset detection, malformed deckpkg rejection.
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

The smoke test builds `@htmlslide/desktop`, launches the built Electron main process with Playwright, verifies the app loads without a Vite/framework error overlay, skips onboarding into No AI mode, reaches the project library, creates a No AI source deck, confirms BYOK generation is visibly gated until a provider key is saved, verifies recent-project entries can be removed without deleting project files, marks missing recent projects as `Missing files`, creates and generates a Local Mock deck from the New Deck wizard, verifies the sanitized latest agent-run report includes outline, visual-direction, build, and applied-file summaries, mocks the native folder picker, opens `packages/test-fixtures/decks/valid-full`, runs Check and Export through the shared CLI/compiler path, asserts PDF/HTML/deckpkg/notes/thumbnail artifacts exist, verifies Check reports text overflow, missing local assets, and missing speaker notes in the QA panel, verifies Present loads the exported deckpkg metadata, display target selector, speaker notes, and a synced no-chrome audience window before exercising navigation/overlays/keyboard exit, verifies standalone `.deckpkg` files enter Presenter through a startup file argument and a macOS `open-file` event without onboarding or folder selection, and verifies Settings can reinstall/copy/uninstall the CLI shim in an isolated target directory.

GitHub `CI` runs this smoke on `macos-latest` for pull requests and pushes to `main`. The `Alpha Package` workflow also runs it before unsigned packaging so release artifacts are gated on the desktop app path, not only package creation.

Artifacts are written under `tmp/playwright/` so they stay out of release artifacts and normal source diffs. This is a foundation smoke, not full coverage for live OpenAI/Anthropic BYOK credentials, real Claude/Codex agents, physical dual-screen placement, or native packaging install flows. Provider-backed BYOK coverage and Generic external-agent command coverage live in desktop service tests with injected fakes.

## Packaging Verification

Unsigned macOS alpha packaging is intentionally separate from default CI because it requires macOS tooling and can be slower than unit checks:

```bash
pnpm verify:package:alpha
```

This command builds the desktop app, creates the unsigned `.app`, DMG, ZIP, and manifest under `dist/alpha`, performs the package script's built-in existence checks for the Electron main process, preload, and renderer output, then runs the package smoke.

After an alpha package already exists, run the smoke directly with:

```bash
pnpm smoke:package:alpha
```

The smoke mounts the generated DMG, verifies the packaged app and `Applications` symlink, copies the app to a temporary install directory, verifies the packaged app declares `.deckpkg` as an owned macOS document type, launches it with isolated app data, verifies packaged first-run CLI provisioning into an isolated target directory, exports a fixture deck through the packaged CLI, launches the packaged app with that `.deckpkg` as a direct file argument, verifies the renderer reports presenter mode for the expected deck, installs a temporary CLI shim against the packaged CLI runtime, verifies `htmlslide doctor --json`, and uninstalls the shim.

The `Alpha Package` GitHub Actions workflow remains the CI packaging verifier for scheduled, tagged, and manual runs. Do not add provider credentials or local machine state to this path.

## Visual Regression

Golden deck output should include PNG comparisons and PDF metadata checks. Start with the plan thresholds unless the baseline proves unrealistic:

- Small thumbnails: at most 0.5 percent diff.
- Full slide screenshots: at most 0.2 percent diff.

The compiler fallback thumbnail path currently uses byte-exact PNG goldens under `packages/compiler/test/goldens/` because those PNGs are deterministic and generated without browser screenshots. Browser-rendered slide screenshots should use the percentage thresholds above.

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
10. Remove the project from Recent and confirm the source folder remains on disk.
11. Move or delete a recent project source file and confirm the Project Library marks it as Missing files.
12. Revert an agent run.
13. Uninstall the CLI shim.
14. Delete the app and confirm no unexpected system files remain.

## Contribution Expectations

When changing behavior, update the narrowest relevant tests first. Changes to CLI output need CLI E2E coverage, renderer changes need visual regression fixture updates, skill spec changes need skill docs updates, and core behavior changes need unit/schema coverage.
