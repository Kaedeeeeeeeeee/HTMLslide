# Testing

HTMLslide tests start with the package scripts and expand into fixtures as the app is built. CI expects these root commands to exist:

```bash
pnpm install --frozen-lockfile
pnpm docs:check
pnpm docs:build
pnpm version:check
pnpm lint
pnpm typecheck
pnpm test
pnpm perf:smoke
pnpm security:check
pnpm build
pnpm e2e:desktop
```

Required root package contract:

- `packageManager` pinned to a pnpm version.
- `pnpm-lock.yaml` committed.
- `docs:check`, `docs:build`, `version:check`, `lint`, `typecheck`, `test`, `perf:smoke`, `security:check`, `build`, and `e2e:desktop` scripts in `package.json`.
- `test:visual:browser` for focused browser-rendered full-slide screenshot regression.
- `package:alpha`, `smoke:package:alpha`, `package:release:macos`, `rc:checklist`, and `release:notes` scripts before macOS packaging is enabled.

## Test Layers

Use deterministic fixtures and avoid real provider credentials in automated tests.

- Unit tests: path resolver, project loader, manifest parser, schema validator, slide id validator, safe area calculation, issue severity aggregation, export manifest building, skill metadata parsing.
- Schema tests: valid minimal deck, valid full deck, missing slide source, duplicate slide id, invalid viewport, invalid safe area, unsupported schema version.
- CLI E2E tests: `htmlslide new`, `htmlslide check --json`, `htmlslide export --pdf --deckpkg`, `htmlslide mcp --list-tools --json`, `htmlslide mcp <project> --status --json`, `htmlslide agent validate-provider --json` with fake fetch and fake environment variables, MCP stdio client smoke, `htmlslide package`, `htmlslide doctor`.
- Compiler regression tests: golden decks for minimal, text-heavy, data chart, image-heavy, notes, and multi-theme decks, including byte-exact fallback thumbnail PNG baselines for deterministic compiler output.
- Browser visual regression tests: `browser-visual-deck` exports the shared renderer HTML, captures full-slide Chromium screenshots for deterministic vector-only slides, and compares them against browser screenshot goldens.
- Linter tests: `linter-text-overflow`, `linter-safe-area`, `linter-contrast`, `linter-remote-font`, `linter-missing-notes`, and `linter-valid-clean` fixtures.
- Agent tests: use mock model providers, fake BYOK provider factories, injected fake fetch implementations, and fake external commands. Source-write tests must verify accepted source roots, parser shapes, duplicate rejection, traversal denial, artifact/private-runtime denial, and no partial writes after validation failure. OpenAI-compatible provider tests must verify model validation requests, Chat Completions structured-output request bodies, `sourceWrites` schemas for build/repair, token-usage mapping, abort-signal forwarding, malformed output rejection, missing source-write rejection, and API-key/error-message sanitization. Anthropic provider tests must verify model validation headers, forced Messages API tool request bodies, `tool_use.input` parsing, usage mapping, abort-signal forwarding, malformed or missing tool-use rejection, missing source-write rejection, unsafe source-write rejection, and API-key/error-message sanitization. CLI provider-validation tests must verify OpenAI-compatible/compatible validation routing, missing env handling, required compatible base URL handling, nonzero failed-validation exit codes, and no API-key values in stdout or returned JSON. BYOK desktop tests must verify Keychain-gated credential loading, compatible base URL metadata, default OpenAI/OpenAI-compatible/Anthropic adapter wiring through injected fake fetch, no secret leakage in logs/results, provider `sourceWrites` application, sanitized `.htmlslide/reports/agent-run-<runId>.json` output, checkpoint diffs, and check/export gating without real provider credentials. Generic command runs must verify project-local prompt/manifest handling, source-write boundaries, checkpoint diffs, and check/export gating. CI must not require real Claude Code, Codex, Gemini, or provider login.
- MCP tests: verify CLI discovery/status, stdio server startup, tool listing, path boundary enforcement, schema-valid reports, and artifact creation.
- Electron and presenter tests: cover onboarding, workspace choice, mock agent deck creation, preview, checks, export, rehearsal mode, settings, notes, next/previous navigation, timer, and keyboard shortcuts.
- Packaging tests: unsigned CI build, signed/notarized release workflow contract, DMG/package smoke checks, first-run setup, official skill installation, CLI shim install/repair/uninstall, and `htmlslide doctor`.
- Security tests: API keys absent from logs/project files/settings JSON, credential-store save/clear behavior through injected fakes, protected write-manifest boundaries including symlink escapes, MCP traversal denial, third-party skill warnings, remote asset detection, malformed deckpkg rejection, committed-secret scanning, and high-severity dependency audit.
- Performance tests: `pnpm perf:smoke` generates a temporary 20-slide deck, warms and measures desktop project preview loading, reloads a preview after one slide change, exports a 20-slide PDF, checks the 20-slide deck, and measures presenter next-slide state latency. CI enforces broad guardrails to catch obvious regressions; the product targets in the plan remain alpha/RC baseline targets because real UI preview and PDF export timings depend on host hardware.
- Docs publishing tests: `pnpm docs:check` validates required public docs, local Markdown links, forbidden over-promising claims, GitHub issue template contracts for reproducible bugs, rendering bugs, external-agent bugs, feature requests, skill contributions, private security reporting, and the pull request template. `pnpm docs:build` renders `docs/**/*.md` into `dist/docs-site`, writes `.nojekyll`, copies static assets, and validates generated local links before GitHub Pages upload.
- Version tests: `pnpm version:check` verifies every workspace `package.json` stays on the root app version, `packages/core/src/version.ts` exposes the matching `HTMLSLIDE_APP_VERSION`, `DECK_SCHEMA_VERSION` remains semver and independent, and production code does not reintroduce version literals where the core constants should be used.

## Performance Smoke

Run the deterministic package-level performance smoke when touching project preview, compiler export, checker, presenter session, or desktop service paths:

```bash
pnpm perf:smoke
```

The smoke writes `dist/performance/performance-smoke.json` with elapsed times, plan targets, and CI guardrails. Use `HTMLSLIDE_PERF_KEEP=1 pnpm perf:smoke` to keep the generated 20-slide project for local inspection. The smoke approximates the plan's warm project open and single-slide preview targets through `loadProjectPreview`; full window paint timing and physical presenter display latency still belong in the release-candidate manual benchmark.

## Desktop E2E Smoke

Run the intentional Electron smoke path when changing the desktop shell, preload/IPC wiring, project library, or packaging-adjacent app startup behavior:

```bash
pnpm e2e:desktop
```

For local debugging with the app window visible:

```bash
pnpm e2e:desktop:headed
```

The smoke test builds `@htmlslide/desktop`, launches the built Electron main process with Playwright, verifies the app loads without a Vite/framework error overlay, skips onboarding into No AI mode, reaches the project library, creates a No AI source deck, confirms BYOK generation is visibly gated until a provider key is saved, verifies a local OpenAI-compatible fake provider can be saved in AI Engines and used by the New Deck wizard to complete HTMLslide Agent source writes, check, export, and sanitized run reporting, saves a Generic command in AI Engines and runs it from the New Deck wizard through Coding Agent source writes/check/export/diff/revert, verifies recent-project entries can be removed without deleting project files, marks missing recent projects as `Missing files`, creates and generates a Local Mock deck from the New Deck wizard, verifies the sanitized latest agent-run report includes outline, visual-direction, build, and applied-file summaries, mocks the native folder picker, opens `packages/test-fixtures/decks/valid-full`, runs Check and Export through the shared CLI/compiler path, asserts PDF/HTML/deckpkg/notes/thumbnail artifacts exist, verifies Check reports text overflow, missing local assets, and missing speaker notes in the QA panel through named region/status/list/listitem semantics, verifies Present loads the exported deckpkg metadata, display target selector, speaker notes, and a synced no-chrome audience window before exercising navigation/overlays/keyboard exit, verifies standalone `.deckpkg` files enter Presenter through a startup file argument and a macOS `open-file` event without onboarding or folder selection, and verifies Settings can reinstall/copy/uninstall the CLI shim, install official skills in isolated target directories, and display official skill type/risk/license metadata.

GitHub `CI` runs this smoke on `macos-latest` for pull requests and pushes to `main`. The `Alpha Package` workflow also runs it before unsigned packaging so release artifacts are gated on the desktop app path, not only package creation.

Artifacts are written under `tmp/playwright/` so they stay out of release artifacts and normal source diffs. This is a foundation smoke, not full coverage for live OpenAI/Anthropic BYOK credentials, real Claude/Codex/Gemini agents, physical dual-screen placement, or native packaging install flows. Provider-backed BYOK and Generic external-agent command coverage use local fakes and do not require real provider credentials or agent logins in CI.

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

The smoke extracts the generated ZIP, verifies the fallback artifact contains `HTMLslide.app`, checks the app document type and packaged CLI runtime, installs a temporary CLI shim against the ZIP app, verifies `htmlslide doctor --json`, and uninstalls the shim. It then mounts the generated DMG, verifies the packaged app and `Applications` symlink, copies the app to a temporary install directory, verifies the packaged app declares `.deckpkg` as an owned macOS document type, launches it with isolated app data, verifies packaged first-run CLI provisioning and official skill installation into isolated target directories, moves the app to a second temporary install location and relaunches it so the CLI shim's recorded app path is repaired, exports a fixture deck through the packaged CLI, launches the packaged app with that `.deckpkg` as a direct file argument, verifies the renderer reports presenter mode for the expected deck, installs a temporary CLI shim against the packaged CLI runtime, verifies `htmlslide doctor --json`, and uninstalls the shim.

The `Alpha Package` GitHub Actions workflow remains the unsigned CI packaging verifier for scheduled, tagged, and manual runs. The `Release macOS` workflow is the signed/notarized verifier for manual or `v*` tag release runs, and requires Apple Developer ID and notary secrets before it can produce a production DMG. Do not add provider credentials or local machine state to either path.

## Visual Regression

Golden deck output should include PNG comparisons and PDF metadata checks. Start with the plan thresholds unless the baseline proves unrealistic:

- Small thumbnails: at most 0.5 percent diff.
- Full slide screenshots: at most 0.2 percent diff.

The compiler fallback thumbnail path currently uses PNG goldens under `packages/compiler/test/goldens/` because those PNGs are deterministic and generated without browser screenshots. Fallback thumbnails must have zero pixel diff against their goldens. Browser-rendered slide screenshots use Chromium through Playwright, avoid font-dependent visible content in `browser-visual-deck`, and must stay under the full-slide screenshot threshold above.

The compiler golden test decodes PNG pixels and compares fallback thumbnails against `packages/compiler/test/goldens/`. On failure it writes `before.png`, `after.png`, and `diff.png` under `dist/visual-regression/compiler/`; CI and the alpha package workflow upload that directory as a failed-run artifact when present.

Browser visual regression tests write `before.png`, `after.png`, and `diff.png` under `dist/visual-regression/renderer/` on failures. Refresh browser baselines intentionally with:

```bash
HTMLSLIDE_UPDATE_BROWSER_GOLDENS=1 pnpm test -- packages/compiler/test/browser-visual-regression.test.ts
```

Focused browser visual reruns use:

```bash
pnpm test:visual:browser
```

Compiler regression fixtures cover the Phase 19.5 deck families under `packages/test-fixtures/decks/`: `minimal-deck`, `text-heavy-deck`, `data-chart-deck`, `image-heavy-deck`, `notes-deck`, and `multi-theme-deck`. `browser-visual-deck` covers Phase 19.6 browser-rendered full-slide screenshot regression. `golden-export-basic` remains the deep artifact contract fixture for deckpkg contents, manifest mapping, exported URL rewriting, and notes sidecar equality.

## Manual Release Smoke

Each release candidate must be tested once on a clean macOS user account. Generate the evidence template first:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <package-run-url> --artifact-url <dmg-url>
```

The generated file lives under `dist/acceptance/` and is ignored by git. Complete it with Pass, Fail, or N/A plus evidence links before calling the build public. The required manual script is:

1. Start from a clean macOS user account.
2. Install the DMG or unsigned alpha package.
3. Complete first-run setup.
4. Create a deck with the mock/local provider.
5. Validate and create a deck with a BYOK provider when a test key is available.
6. Connect a fake external agent.
7. Export PDF and deckpkg.
8. Present on an external monitor.
9. Reopen the project.
10. Revert an agent run.
11. Uninstall the CLI shim.
12. Delete the app and confirm no unexpected system files remain.

## Contribution Expectations

When changing behavior, update the narrowest relevant tests first. Changes to CLI output need CLI E2E coverage, renderer changes need visual regression fixture updates, skill spec changes need skill docs updates, and core behavior changes need unit/schema coverage.
