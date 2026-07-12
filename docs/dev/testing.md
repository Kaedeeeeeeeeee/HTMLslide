# Testing

HTMLslide tests start with the package scripts and expand into fixtures as the app is built. CI expects these root commands to exist:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm docs:check
pnpm docs:build
pnpm version:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:visual:browser
pnpm perf:smoke
pnpm security:check
pnpm build
pnpm e2e:desktop
pnpm e2e:desktop:a11y
```

Required root package contract:

- `packageManager` pinned to a pnpm version.
- `pnpm-lock.yaml` committed.
- `docs:check`, `docs:build`, `version:check`, `lint`, `typecheck`, `test`, `perf:smoke`, `security:check`, `build`, `e2e:desktop`, and `e2e:desktop:a11y` scripts in `package.json`.
- `test:visual:browser` for focused browser-rendered full-slide screenshot regression.
- `package:alpha`, `smoke:package:alpha`, `package:release:macos`, `rc:checklist`, `rc:checklist:verify`, and `release:notes` scripts before macOS packaging is enabled.

## Test Layers

Use deterministic fixtures and avoid real provider credentials in automated tests.

- Unit tests: path resolver, project loader, manifest parser, schema validator, slide id validator, safe area calculation, issue severity aggregation, export manifest schema/canonical ordering/digest building, fingerprint path boundaries and symlink escapes, skill metadata parsing.
- Schema tests: valid minimal deck, valid full deck, missing slide source, duplicate slide id, invalid viewport, invalid safe area, unsupported schema version.
- CLI E2E tests: `htmlslide new`, `htmlslide open`, `htmlslide check --json`, `htmlslide export --pdf --deckpkg`, `htmlslide package`, `htmlslide present`, skill list/add/remove/inspect, `htmlslide mcp --list-tools --json`, `htmlslide mcp <project> --status --json`, `htmlslide agent validate-provider --json` with fake fetch and fake environment variables, MCP stdio client smoke, and `htmlslide doctor`. Desktop launch tests inject the macOS open runner or use isolated Electron instances; CI does not open a developer's installed App.
- Browser renderer tests: exercise `playwright-core` Chromium DOM rendering, exact thumbnail dimensions, normalized PDF metadata, repeated-byte determinism, disabled page JavaScript, render-root file isolation, blocked network requests, missing/invalid resources, unknown slide ids, and unavailable-browser failures.
- Compiler regression tests: the minimal, text-heavy, data chart, image-heavy, notes, and multi-theme fixtures run through the production Chromium export path. They verify page and thumbnail counts, package mappings, repeated PDF/PNG/deckpkg hashes, and shared browser output while export transaction coverage verifies one source snapshot, project-lock exclusion and token-claimed stale-lock recovery, staging cleanup after failure, destination preflight, preservation of the previous commit after a rejected partial export, manifest-last atomic replacement, deterministic SHA-256 metadata, symlink boundary rejection, and partial-export removal of only old manifest-owned artifacts.
- Browser visual regression tests: `browser-visual-deck` captures deterministic vector-only full-slide PNGs and the corresponding compiler-generated Chromium thumbnail PNGs, then compares both against browser goldens. Preview parity also compares the canonical preview against the exported DOM.
- Linter tests: `linter-text-overflow`, `linter-safe-area`, `linter-contrast`, `linter-remote-font`, `linter-missing-notes`, and `linter-valid-clean` fixtures. Export integrity cases must cover source changes with unchanged/older mtimes, manual artifact edits, partial exports, a missing-manifest warning with legacy mtime fallback, and invalid or truncated manifests failing closed as errors without fallback.
- Agent tests: use mock model providers, fake BYOK provider factories, injected fake fetch implementations, and fake external commands. Source-write tests must verify accepted source roots, parser shapes, duplicate rejection, traversal denial, artifact/private-runtime denial, and no partial writes after validation failure. OpenAI-compatible provider tests must verify model validation requests, Chat Completions structured-output request bodies, `sourceWrites` schemas for build/repair, token-usage mapping, abort-signal forwarding, malformed output rejection, missing source-write rejection, and API-key/error-message sanitization. Anthropic provider tests must verify model validation headers, forced Messages API tool request bodies, `tool_use.input` parsing, usage mapping, abort-signal forwarding, malformed or missing tool-use rejection, missing source-write rejection, unsafe source-write rejection, and API-key/error-message sanitization. CLI provider-validation tests must verify OpenAI-compatible/compatible validation routing, missing env handling, required compatible base URL handling, nonzero failed-validation exit codes, and no API-key values in stdout or returned JSON. BYOK desktop tests must verify Keychain-gated credential loading, compatible base URL metadata, default OpenAI/OpenAI-compatible/Anthropic adapter wiring through injected fake fetch, no secret leakage in logs/results, provider `sourceWrites` application, sanitized `.htmlslide/reports/agent-run-<runId>.json` output, checkpoint diffs, and check/export gating without real provider credentials. Generic command runs must verify project-local prompt/manifest handling, source-write boundaries, checkpoint diffs, and check/export gating. CI must not require real Claude Code, Codex, Gemini, or provider login.
- MCP tests: verify CLI discovery/status, stdio server startup, tool listing, render tools, lexical and real-filesystem path boundary enforcement (including symlink escape rejection), schema-valid reports, and artifact creation.
- Electron and presenter tests: cover onboarding, workspace choice, project and deckpkg launch arguments, second-instance open forwarding, mock/BYOK visual-direction choice before Build, external-agent command runs, preview, checks, export, rehearsal mode, settings, notes, next/previous navigation, timer, keyboard shortcuts, and deckpkg resource-limit rejection.
- Desktop accessibility tests: cover first-run onboarding, Project Library, New Deck provider gating, visual-direction choice cards and keyboard selection, QA Panel issue semantics, presenter rehearsal controls, Settings CLI status, and the official skills library with Playwright role assertions plus axe WCAG A/AA checks.
- Skills library tests: Electron E2E verifies the official skills library exposes install-state and deck-type filters, expandable metadata inspection, risk flags, install paths, and markdown previews before installation, then installs the pack into an isolated HTMLslide home directory and verifies official skill metadata remains inspectable.
- Packaging tests: unsigned CI build, signed/notarized release workflow contract, private `browser-runtime.json` plus bundled Chromium validation, DMG/package smoke checks through that packaged runtime, first-run setup, official skill installation, CLI shim install/repair/uninstall, and `htmlslide doctor`.
- Release evidence script tests: deterministic coverage for `rc:checklist`, `rc:byok-evidence`, `rc:external-agent-evidence`, and `release:notes`, including run-bound metadata, 8-12 slide/provider/report/export consistency, fixed real Claude/Codex evidence shape, package-manifest binding, secret rejection, manual evidence sections, signed-release gates, and empty release-range warnings.
- Security tests: API keys absent from logs/project files/settings JSON, credential-store save/clear behavior through injected fakes, protected write-manifest boundaries including symlink escapes, MCP traversal denial, third-party skill warnings, remote asset detection, malformed deckpkg rejection, committed-secret scanning, and high-severity dependency audit.
- Performance tests: `pnpm perf:smoke` generates a temporary 20-slide deck, warms and measures desktop project preview loading, reloads a preview after one slide change, exports a 20-slide PDF, checks the 20-slide deck, and measures presenter next-slide state latency. CI enforces broad guardrails to catch obvious regressions; the product targets in the plan remain alpha/RC baseline targets because real UI preview and PDF export timings depend on host hardware.
- Docs publishing tests: `pnpm docs:check` validates required public docs, local Markdown links, forbidden over-promising claims, GitHub issue template contracts for reproducible bugs, rendering bugs, external-agent bugs, feature requests, skill contributions, private security reporting, and the pull request template. `pnpm docs:build` renders `docs/**/*.md` into `dist/docs-site`, writes `.nojekyll`, copies static assets, and validates generated local links before GitHub Pages upload.
- Version tests: `pnpm version:check` verifies every workspace `package.json` stays on the root app version, `packages/core/src/version.ts` exposes the matching `HTMLSLIDE_APP_VERSION`, `DECK_SCHEMA_VERSION` and `EXPORT_MANIFEST_SCHEMA_VERSION` remain semver and independent, and production code does not reintroduce version literals where the core constants should be used.

## Performance Smoke

Run the deterministic package-level performance smoke when touching project preview, compiler export, checker, presenter session, or desktop service paths:

```bash
pnpm perf:smoke
```

The smoke writes `dist/performance/performance-smoke.json` with elapsed times, plan targets, and CI guardrails. Use `HTMLSLIDE_PERF_KEEP=1 pnpm perf:smoke` to keep the generated 20-slide project for local inspection. The smoke measures warm project metadata loading through `loadProjectPreview` and changed-slide document generation through `buildSlidePreviewDocument`; full iframe paint timing and physical presenter display latency still belong in the release-candidate manual benchmark.

## Desktop E2E Smoke

Run the intentional Electron smoke path when changing the desktop shell, preload/IPC wiring, project library, or packaging-adjacent app startup behavior:

```bash
pnpm e2e:desktop
```

For local debugging with the app window visible:

```bash
pnpm e2e:desktop:headed
```

The smoke test builds `@htmlslide/desktop`, launches the built Electron main process with Playwright, verifies the app loads without a Vite/framework error overlay, completes executable onboarding through workspace choice, persisted Coding Agent mode selection, CLI installation, official-skills installation, and the Ready summary, then relaunches the same isolated user data to prove setup completion and the AI mode persist. It also covers the global No AI skip path, reaches the project library, creates a No AI source deck, confirms BYOK generation is visibly gated until a provider key is saved, verifies a local OpenAI-compatible fake provider can be saved in AI Engines and used by the New Deck wizard to complete HTMLslide Agent source writes, check, export, and sanitized run reporting, saves a Generic command in AI Engines and runs it from the New Deck wizard through Coding Agent source writes/check/export/diff/revert, verifies recent-project entries can be removed without deleting project files, marks missing recent projects as `Missing files`, creates and generates a Local Mock deck from the New Deck wizard, verifies the sanitized latest agent-run report includes outline, visual-direction, build, and applied-file summaries, mocks the native folder picker, opens `packages/test-fixtures/decks/valid-full`, runs Check and Export through the shared CLI/compiler path, asserts PDF/HTML/deckpkg/notes/thumbnail artifacts exist, verifies Check reports text overflow, missing local assets, and missing speaker notes in the QA panel through named region/status/list/listitem semantics, verifies Present loads the exported deckpkg metadata, display target selector, speaker notes, and a synced no-chrome audience window before exercising navigation/overlays/keyboard exit, verifies standalone `.deckpkg` files enter Presenter through a startup file argument and a macOS `open-file` event without onboarding or folder selection, and verifies Settings can reinstall/copy/uninstall the CLI shim, install official skills in isolated target directories, and display official skill type/risk/license metadata.

GitHub `CI` runs this smoke on the pinned `macos-26` Apple Silicon image for pull requests and pushes to `main`. The `Alpha Package` workflow uses the same pinned image before unsigned packaging so release artifacts are gated on the desktop app path without inheriting future `macos-latest` migrations.

Artifacts are written under `tmp/playwright/` so they stay out of release artifacts and normal source diffs. This is a foundation smoke, not full coverage for live OpenAI/Anthropic BYOK credentials, real Claude/Codex/Gemini agents, physical dual-screen placement, or native packaging install flows. Provider-backed BYOK and Generic external-agent command coverage use local fakes and do not require real provider credentials or agent logins in CI.

## Desktop Accessibility Gate

Run the focused Electron accessibility gate when changing desktop navigation, dialog/panel semantics, status messaging, presenter controls, settings, or official skills UI:

```bash
pnpm e2e:desktop:a11y
```

The gate builds `@htmlslide/desktop`, launches Electron through Playwright, and scans stable desktop chrome states with `@axe-core/playwright` restricted to WCAG 2.0/2.1 A and AA tags. It uses axe legacy mode because Electron does not support the blank aggregation page that the default Playwright integration opens. It pairs axe with explicit role/name/status assertions for onboarding setup progress, Project Library navigation, New Deck provider-key gating, QA Panel summary/tabs/issues, presenter rehearsal transport/progress controls, Settings CLI integration status, and official skills metadata inspection.

The desktop accessibility gate scans the canonical preview host, including its loading and error status semantics, but treats the sandboxed iframe document as untrusted project content outside the app-shell axe scan. Slide content accessibility remains covered by linter fixtures, compiler/renderer tests, and project QA because generated or user-owned deck HTML can validly fail independently from the app shell.

Preview security coverage uses a hostile local fixture to verify that authored scripts and inline handlers cannot reach the privileged workspace, remote requests are denied, local project assets are inlined, and rapid filmstrip selection cannot display a stale response. The preview document is generated through the same renderer contract as export, while the compiler path remains read-only and does not acquire export locks or write artifacts.

## Packaging Verification

Unsigned macOS alpha packaging is intentionally separate from default CI because it requires macOS tooling and can be slower than unit checks:

```bash
pnpm verify:package:alpha
```

This command builds the desktop app, creates the unsigned `.app`, DMG, ZIP, and manifest under `dist/alpha`, performs the package script's built-in existence checks for the Electron main process, preload, and renderer output, then runs the package smoke.

Packaging copies the Chromium application selected from the development Playwright cache into the app's private `cli-runtime/browser-runtime/` directory and writes its relative executable path to `cli-runtime/browser-runtime.json`. The package is incomplete if that config or executable is missing, invalid, outside the private runtime, symlinked, or not executable.

After an alpha package already exists, run the smoke directly with:

```bash
pnpm smoke:package:alpha
```

The smoke verifies the manifest's artifact byte sizes and SHA-256 digests, extracts the generated ZIP, verifies it contains `HTMLslide.app`, checks the app document type, validates `browser-runtime.json` and the private Chromium executable, installs a temporary CLI shim against the ZIP app, verifies `htmlslide doctor --json`, and uninstalls the shim. It then mounts the generated DMG, verifies the packaged app and `Applications` symlink, copies the app to a temporary install directory, verifies the packaged app declares `.deckpkg` as an owned macOS document type, launches it with isolated app data, verifies packaged first-run CLI provisioning and official skill installation into isolated target directories, moves the app to a second temporary install location and relaunches it so the CLI shim's recorded app path is repaired, and creates an asset-bearing deckpkg through the packaged CLI. Every packaged CLI invocation receives `HTMLSLIDE_CHROMIUM_EXECUTABLE` resolved from that app's private runtime, so the smoke must fail rather than use the developer's Playwright cache. It then verifies package-local assets, opens the deckpkg in the packaged app, verifies presenter mode, checks the managed CLI shim and packaged MCP diagnostics, and uninstalls the shim.

The `Alpha Package` GitHub Actions workflow remains the unsigned CI packaging verifier for scheduled, tagged, and manual runs. The `Release macOS` workflow is the signed/notarized verifier for manual or `v*` tag release runs, and requires Apple Developer ID and notary secrets before it can produce a production DMG. Do not add provider credentials or local machine state to either path.

## Visual Regression

The visual gate applies to Chromium-generated PNGs:

- Small thumbnails: at most 0.5 percent diff.
- Full slide screenshots: at most 0.2 percent diff.

`browser-visual-deck` deliberately uses deterministic vector content. Its shared full-slide browser captures use the 0.2 percent threshold. Real compiler thumbnail captures use OS-and-architecture-specific baselines under `goldens/browser-visual-deck/thumbnails/<platform>-<arch>/` with a 0.5 percent threshold because Chromium's SVG raster path differs across host builds. Browser visual regression failures write `before.png`, `after.png`, and `diff.png` under `dist/visual-regression/renderer/`. The PNG comparison helper is also covered for mismatch artifact generation under `dist/visual-regression/compiler/`.

PDF checks are structural, not raster visual regression: tests verify page count, normalized `pdf-lib` metadata, repeated-byte determinism for the pinned Chromium, operating-system image, and font environment, and that PDF and PNG outputs are produced from the same staged print DOM. Cross-machine byte equality is not claimed when the operating system or installed fonts differ. Refresh PNG browser baselines intentionally with:

```bash
HTMLSLIDE_UPDATE_BROWSER_GOLDENS=1 pnpm test -- packages/compiler/test/browser-visual-regression.test.ts
```

Focused browser visual reruns use:

```bash
pnpm test:visual:browser
```

Compiler regression fixtures cover the Phase 19.5 deck families under `packages/test-fixtures/decks/`: `minimal-deck`, `text-heavy-deck`, `data-chart-deck`, `image-heavy-deck`, `notes-deck`, and `multi-theme-deck`. `browser-visual-deck` covers Phase 19.6 browser-rendered full-slide screenshot regression. `golden-export-basic` remains the deep artifact contract fixture for deckpkg contents, manifest mapping, exported URL rewriting, and notes sidecar equality.

For a focused Phase 2 export verification after Chromium is installed, run:

```bash
pnpm test -- packages/compiler/test/browser-renderer.test.ts packages/compiler/test/export.test.ts
pnpm test:visual:browser
```

## Manual Release Smoke

Each release candidate must be tested once on a clean macOS user account. Generate the evidence template first:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <package-run-url> --artifact-url <dmg-url>
```

The generated file lives under `dist/acceptance/` and is ignored by git. Complete it with Pass, Fail, or N/A plus evidence links before calling the build public. The required manual script is:

The generated template includes an explicit `Status:` field for every manual item. Replace `Status: TODO` with exactly `Pass`, `Fail`, or `N/A`. Fill the section's `Evidence:` field for Pass; fill `Notes:` with an explanation for Fail or an explicit reason for N/A. Check every automated gate with `[x]`, replace metadata and blocking-issue placeholders, set the final `Result` status to `Accepted` or `Rejected`, and select exactly one final Result checkbox.

Verify the completed checklist without provider credentials, Apple Developer credentials, or presentation hardware:

```bash
pnpm rc:checklist:verify -- --checklist /path/to/completed-rc-checklist.md --json
```

This command validates the recorded checklist only. It does not run a provider, sign or notarize an app, or claim hardware/manual behavior that was not recorded in the checklist.

1. Start from a clean macOS user account.
2. Install the DMG or unsigned alpha package.
3. Complete first-run setup.
4. Create a deck with the mock/local provider.
5. Validate and create a deck with a BYOK provider when a test key is available.
6. Connect a fake external agent.
7. Record real Claude/Codex/Gemini evidence before claiming direct support, or mark N/A and confirm docs/release notes make no direct support claim.
8. Export PDF and deckpkg.
9. Present on an external monitor.
10. Reopen the project.
11. Revert an agent run.
12. Uninstall the CLI shim.
13. Delete the app and confirm no unexpected system files remain.

## Contribution Expectations

When changing behavior, update the narrowest relevant tests first. Changes to CLI output need CLI E2E coverage, renderer changes need visual regression fixture updates, skill spec changes need skill docs updates, and core behavior changes need unit/schema coverage.
