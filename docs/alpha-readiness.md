# Alpha Readiness

HTMLslide public alpha readiness is tracked against the product acceptance checklist in `HTMLslide_Product_Development_Plan.md`.

This page is the release-facing status map. It separates automated evidence from manual release-candidate evidence so the project does not over-claim support that has not been tested on real machines, real provider accounts, or physical displays.

## Current Verdict

HTMLslide is suitable for contributor and tester alpha builds. It is not yet a production-ready public distribution.

Current alpha artifacts are unsigned. They are not Developer ID signed, not notarized, and may trigger Gatekeeper warnings. A build should not be described as public-release-ready until the release-candidate checklist is completed for the exact artifact under test.

## Automated Evidence

These gates are expected before each alpha candidate:

| Area | Evidence | Command or workflow |
| --- | --- | --- |
| Public docs contract | Required alpha docs exist and avoid over-promising claims. | `pnpm docs:check` |
| Docs site | Static GitHub Pages site builds with valid local links. | `pnpm docs:build` |
| Version contract | App, packages, and schema constants remain aligned. | `pnpm version:check` |
| Code quality | Lint, typecheck, unit tests, compiler regression, CLI tests, and desktop service tests pass. | `pnpm lint`, `pnpm typecheck`, `pnpm test` |
| Performance guardrails | Preview, PDF export, checker, and presenter state smoke metrics stay under guardrails. | `pnpm perf:smoke` |
| Security baseline | Source secret scan and high-severity dependency audit pass. | `pnpm security:check` |
| Desktop UX smoke | New Deck, Project Library, QA, export, presenter, CLI integration, and official skills flows pass in Electron. | `pnpm e2e:desktop` |
| Alpha package | Unsigned DMG/ZIP/manifest are created and smoked from the packaged app and packaged CLI. | `pnpm verify:package:alpha` |
| Remote CI | Main branch CI and Docs Pages complete for the candidate commit. | GitHub Actions `CI`, `Docs Pages` |

## Automated Alpha Coverage

| Acceptance item | Current automated coverage |
| --- | --- |
| DMG can be produced | `pnpm package:alpha` writes unsigned alpha DMG, ZIP, and manifest. |
| App can launch | Package smoke launches the packaged app in isolated user data. |
| CLI shim can install | Electron E2E and package smoke cover first-run CLI provisioning and uninstall. |
| `htmlslide doctor` passes | CLI tests and package smoke cover doctor through the packaged CLI shim. |
| New Deck creates a project | CLI tests and Electron E2E cover source project creation. |
| Open Folder opens a project | Electron E2E covers opening fixture and created projects. |
| Project Library shows recent projects | Electron E2E covers recent project management. |
| Local Mock provider completes the flow | Agent tests, CLI tests, and Electron E2E cover deterministic mock generation. |
| BYOK source writes/check/export path | Provider adapters use fake fetch tests; desktop BYOK wiring is covered without real credentials. |
| Generate outline, visual direction, and full deck | Agent orchestrator tests and desktop mock generation cover the staged flow. |
| Check finds overflow | Linter fixtures and Electron QA panel E2E cover text overflow issues. |
| Check finds missing asset | Linter fixtures and Electron QA panel E2E cover missing asset issues. |
| Check finds missing notes | Linter fixtures and Electron QA panel E2E cover missing notes issues. |
| QA panel shows issues | Electron E2E covers failing check display. |
| PDF page count is correct | Compiler tests cover PDF export metadata and page count. |
| PNG thumbnails are produced | Compiler tests and export fixtures cover deterministic thumbnails. |
| `deckpkg` can open | Presenter tests, Electron E2E, and package smoke cover package opening. |
| Rehearsal mode works | Presenter tests and Electron E2E cover single-screen rehearsal. |
| Fake external adapter automation | Agent adapter tests and desktop fake-command paths cover deterministic external-agent behavior. |
| Unit, CLI, compiler, Electron, and packaging tests pass | Covered by local commands and CI workflows. |

## Manual Release-Candidate Evidence

These items require human evidence for the exact artifact before an alpha build is announced beyond contributor testing:

| Item | Required evidence |
| --- | --- |
| Clean macOS install | Completed checklist from `pnpm rc:checklist` on a clean account or isolated machine. |
| Gatekeeper behavior | Screenshot or note confirming expected unsigned alpha warning or signed release behavior. |
| Real BYOK provider | At least one real provider account, test prompt, generated deck, check/export result, and secret-safety review. |
| Real Claude or Codex claim | Detection plus a manually validated real integration path before support is claimed. |
| Physical dual-screen presenter | HDMI, USB-C, or AirPlay presentation with speaker screen, audience window, navigation, timer, and sync evidence. |
| Finder/LaunchServices deckpkg open | User-level double-click or `open` behavior against the installed app. |
| Post-delete cleanup | Notes showing no unexpected files outside user data, chosen workspace, and intentionally installed CLI/skills artifacts. |

Generate the evidence template with:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <alpha-package-url> --artifact-url <dmg-url>
```

The generated checklist lives under `dist/acceptance/` and is intentionally not committed. Attach or paste the completed evidence into the release candidate notes.

## Not Yet Claimed

The alpha docs and release notes must not claim:

- production-ready signed distribution while artifacts are unsigned alpha builds;
- full Claude Code or Codex headless deck editing before real adapter validation is complete;
- physical dual-screen reliability from Electron E2E alone;
- real provider safety from fake-fetch tests alone.

Use [Testing](testing.md), [Release](release.md), and [dev/release.md](dev/release.md) for the detailed command contracts.
