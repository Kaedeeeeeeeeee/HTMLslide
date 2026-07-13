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
| Export integrity | Compiler exports use one source snapshot, token-safe project locking, staged rollback, manifest-last commit, partial-export cleanup, and fail-closed validation for invalid manifests. | `pnpm test` |
| Chromium export | Production PDF, real DOM thumbnails, and deckpkg render members share one staged `playwright-core` Chromium session with page JavaScript disabled, render-root-only local files, network blocking, asset/layout readiness, normalized PDF metadata, and fail-closed browser/resource errors. | `pnpm test`, `pnpm test:visual:browser` |
| Code quality | Lint, typecheck, unit tests, compiler regression, CLI tests, and desktop service tests pass. | `pnpm lint`, `pnpm typecheck`, `pnpm test` |
| Performance guardrails | Preview, PDF export, checker, and presenter state smoke metrics stay under guardrails. | `pnpm perf:smoke` |
| Security baseline | Source secret scan and high-severity dependency audit pass. | `pnpm security:check` |
| Canonical preview isolation | Desktop preview uses the shared renderer in a sandboxed, scriptless iframe with deny-by-default CSP, inline local assets, dynamic manifest-viewport scaling, and hostile-content coverage. | `pnpm test`, `pnpm e2e:desktop`, `CI` |
| Desktop UX smoke | New Deck, Project Library, QA, export, presenter, CLI integration, and official skills flows pass in Electron. | `pnpm e2e:desktop` |
| Desktop accessibility smoke | First-run, Project Library, New Deck gating, QA Panel, presenter, Settings, and official skills chrome pass WCAG A/AA axe checks plus role semantics. | `pnpm e2e:desktop:a11y`, `CI` |
| Built-in external adapter contract | Fake Claude/Codex runners verify fixed argv, isolated temporary cwd, command-contract probing, permission flags, bounded metadata-only logs, process-group cancellation, conflict-safe source application, checkpoint diff, and Check/Export gating. Shared external-run E2E covers retry; the built-in Codex E2E covers review and revert. | `pnpm test`, `pnpm e2e:desktop`, `CI` |
| Alpha package | Unsigned DMG/ZIP/manifest plus artifact SHA-256 metadata and a prefilled RC acceptance template are created. The app contains private `browser-runtime.json` plus Chromium, and package smoke forces packaged CLI rendering through that runtime before packaged app and MCP checks. | `pnpm verify:package:alpha`, `Alpha Package` |
| Relocatable release bundle | The final copied release-artifacts directory is revalidated for one release manifest, one DMG, bundle-relative references, security evidence, and matching SHA-256 metadata before upload or GitHub Release publication. | `pnpm release:bundle:verify`, `Release macOS` |
| RC BYOK command contract | The shared `htmlslide rc byok` argument shape, provider-validation-first ordering, fixture-safe JSON contract, and run-bound evidence path are covered by deterministic/fake-provider tests. This proves the command contract only, not live provider success. | CLI contract tests, `CI` |
| Remote CI | Main branch CI and Docs Pages complete for the candidate commit. | GitHub Actions `CI`, `Docs Pages` |

## Automated Alpha Coverage

| Acceptance item | Current automated coverage |
| --- | --- |
| DMG can be produced | `pnpm package:alpha` writes unsigned alpha DMG, ZIP, and manifest with byte-size and SHA-256 artifact metadata. |
| App can launch | Package smoke launches the packaged app in isolated user data. |
| CLI shim can install | Electron E2E and package smoke cover first-run CLI provisioning and uninstall. |
| `htmlslide doctor` passes | CLI tests and package smoke cover doctor through the packaged CLI shim. |
| CLI project/package/presenter surface works | CLI tests cover project discovery, portable package intent, package validation, launch error contracts, and argument-safe macOS App invocation; Electron E2E covers initial and second-instance project opens; package smoke generates its deckpkg with the packaged `htmlslide package` command. |
| Managed skill lifecycle works | Shared skills tests cover local/official/HTTPS resolution, DNS and source limits, warning confirmation, ownership hashes, atomic update, legacy official adoption, and safe removal. CLI E2E and package smoke cover list/add/inspect/remove, while first-run package smoke verifies official ownership records. |
| Packaged MCP diagnostics and source boundaries work | CLI/MCP tests cover source runtime behavior, including directory and file symlink escape rejection; package smoke runs packaged `htmlslide mcp --list-tools --json` and project-scoped `htmlslide mcp --status --json`. |
| New Deck creates a project | CLI tests and Electron E2E cover source project creation. |
| Open Folder opens a project | Electron E2E covers opening fixture and created projects. |
| Project Library shows recent projects | Electron E2E covers recent project management. |
| Local Mock provider completes the flow | Agent tests, CLI tests, and Electron E2E cover deterministic mock generation. |
| BYOK source writes/check/export path | Provider adapters use fake fetch tests; Electron E2E covers a local OpenAI-compatible fake provider through AI Engines, New Deck, source writes, check, export, and sanitized run reports without real credentials. |
| Shared RC BYOK command contract | Deterministic provider fixtures cover accepted arguments, provider validation before generation, PDF/deckpkg/thumbnail export ordering, sanitized JSON, and `.htmlslide/reports/rc-evidence-<run-id>/` binding. Fake-provider coverage does not satisfy the real-provider gate. |
| Generate outline, choose visual direction, and build full deck | Core orchestrator tests cover the selection state; desktop Local Mock and BYOK E2E pause before Build, expose direction cards, and verify the selected direction is used in the final report. External-agent commands keep their command-owned flow. |
| Check finds overflow | Linter fixtures and Electron QA panel E2E cover text overflow issues. |
| Check finds missing asset | Linter fixtures and Electron QA panel E2E cover missing asset issues. |
| Check finds missing notes | Linter fixtures and Electron QA panel E2E cover missing notes issues. |
| QA panel shows issues | Electron E2E covers failing check display. |
| App shell accessibility | Desktop accessibility E2E covers onboarding, Project Library, New Deck gating, canonical preview host states, QA Panel, presenter rehearsal, Settings, and official skills chrome. The sandboxed user-authored preview document is validated separately. |
| Canonical slide preview | Compiler/renderer tests cover deterministic single-slide documents, fixed manifest viewports, theme and local-asset parity, read-only generation, deny-by-default CSP, and removal of runtime scripts/notes. Electron E2E covers selection, scaling, stale-response handling, error recovery, and hostile authored content. |
| PDF output is structurally verified | Compiler tests cover page count, normalized metadata, repeated-byte determinism for a pinned Chromium, operating-system image, and font environment, and production from the same staged Chromium DOM as thumbnails. There is no raster PDF visual-regression or cross-platform byte-equality claim. |
| PNG thumbnails are real DOM captures | Compiler tests cover exact-size Chromium thumbnails, repeated-byte determinism, and vector-only PNG goldens with 0.2 percent full-slide and 0.5 percent thumbnail thresholds. |
| Browser and resource failures stop export | Browser renderer tests cover missing Chromium, blocked network/file escapes, disabled page JavaScript, invalid or missing images, and readiness failures without a PDF/thumbnail fallback. |
| Export integrity metadata is enforced | Core/compiler/linter tests cover deterministic SHA-256 metadata, lock and staging cleanup, partial exports, legacy missing-manifest fallback, artifact edits, and invalid or truncated manifests failing closed. |
| `deckpkg` can open | Presenter tests, Electron E2E, and package smoke cover package opening through direct launch arguments, Electron `open-file` handling, and macOS LaunchServices `open -a` against the packaged app. |
| Malicious or oversized `deckpkg` is rejected | Presenter tests cover archive byte, entry count, per-entry and total uncompressed limits, encryption, unsafe paths, and malformed package metadata before presenter asset expansion. |
| Rehearsal mode works | Presenter tests and Electron E2E cover single-screen rehearsal. |
| Fake built-in Claude/Codex automation | Injected runners and fake executables cover install/auth/flag detection, exact built-in arguments, adapter identity, isolated temporary cwd, source-only application, concurrent-edit and symlink rejection, bounded metadata-only output, timeout/cancel, checkpoint diff, Check/Export gating, diff review, and revert. Shared registry tests cover retry across external runs. This proves HTMLslide's adapter contract only. |
| Fake Generic external adapter automation | Agent adapter tests, desktop service tests, and Electron E2E cover saving a Generic command, running it from New Deck and opened-workspace paths, validating the write manifest, applying reported source writes, Check/Export gating, diff review, and checkpoint revert. |
| External-agent RC evidence verifier | `pnpm rc:external-agent-evidence` accepts only a fixed sanitized real Claude/Codex evidence shape, binds it to the caller-declared commit and the exact package manifest SHA-256, and emits metadata-only evidence. |
| Gemini detection-only boundary | Detector and renderer tests may prove command discovery and that Gemini remains ineligible for headless runs; they must not synthesize authenticated or runnable Gemini status. |
| Unit, CLI, compiler, Electron, and packaging tests pass | Covered by local commands and CI workflows. |

## Manual Release-Candidate Evidence

These items require human evidence for the exact artifact before an alpha build is announced beyond contributor testing:

| Item | Required evidence |
| --- | --- |
| Clean macOS install | Completed checklist from `pnpm rc:checklist` on a clean account or isolated machine. |
| Gatekeeper behavior | Screenshot or note confirming expected unsigned alpha warning or signed release behavior. |
| Real BYOK provider | The exact packaged candidate must run the shared `htmlslide rc byok` command with a real `openai`, `anthropic`, or `compatible` provider. Evidence must show provider validation first, real generation, Check, PDF/deckpkg/thumbnail export, and sanitized run-bound files under `.htmlslide/reports/rc-evidence-<run-id>/`. A fake-provider test or the command contract alone does not satisfy this row. |
| Real Claude Code compatibility claim | The exact packaged RC runs a deck edit through the tester's own authenticated Claude Code installation; evidence includes detected version/auth state, permission summary, completed edit, cancellation behavior, diff review, Check/Export result, revert result, and secret-safety review. |
| Real Codex compatibility claim | The exact packaged RC runs a deck edit through the tester's own authenticated Codex installation; evidence includes detected version and `codex login status`, sandbox/permission summary, completed edit, cancellation behavior, diff review, Check/Export result, revert result, and secret-safety review. |
| Gemini CLI status | Detection may be recorded, but Gemini remains detection-only. A headless editing claim is not permitted until a separate non-interactive authentication and permission contract is implemented, tested, and manually validated. |
| Physical dual-screen presenter | HDMI, USB-C, or AirPlay presentation with speaker screen, audience window, navigation, timer, and sync evidence. |
| Finder default deckpkg ownership | User-level double-click behavior against the installed app, confirming the temporary or release install is the default handler on the tester machine. |
| Post-delete cleanup | Notes showing no unexpected files outside user data, chosen workspace, and intentionally installed CLI/skills artifacts. |

Generate the evidence template with:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <alpha-package-url> --artifact-url <dmg-url>
```

The generated checklist lives under `dist/acceptance/` and is intentionally not committed. The Alpha Package and Release macOS workflows also upload a prefilled, incomplete RC checklist alongside the candidate artifacts so human testers can complete evidence against the exact run. Attach or paste the completed evidence into the release candidate notes.

For the real-provider manual gate, run the shared acceptance command from a shell that has the key in an environment variable, not in the command line:

```bash
umask 077
htmlslide rc byok --project <deck-path> --provider openai|anthropic|compatible --model <model-id> --api-key-env <ENV_NAME> --task <brief> --target-slide-count <8-12> --json
```

Optional candidate binding and run controls are `--base-url <url>`, `--commit <commit>`, `--artifact-url <url>`, and `--speaker-notes <mode>`. Use the command from the exact candidate binary being tested.

The command writes sanitized run-bound evidence under `.htmlslide/reports/rc-evidence-<run-id>/`. The named environment variable and any desktop Keychain-backed credential remain outside the project; API key values are never written to the evidence.

For implementation-level verification of an already captured run, the lower-level verifier remains available:

```bash
pnpm rc:byok-evidence -- --project <deck-path> --provider-validation <validation.json> --run-id <run-id> --commit <commit> --artifact-url <artifact-url>
```

That verifier does not replace the unified real-provider acceptance path once `htmlslide rc byok` is available.

The automated command contract proves only orchestration and sanitization with deterministic test inputs. BYOK release evidence is complete only after the unified command succeeds with a real provider against the exact candidate, its sanitized run-bound evidence is attached to the candidate notes, and the completed checklist confirms that the caller-declared commit/artifact labels identify the exact package tested.

Fake Claude/Codex executables in unit, service, Electron, or packaging tests are automated evidence. They do not satisfy either real-account row above. Manual evidence is valid only for the exact packaged artifact named in the checklist; a result from a source checkout, a different build, or another tester's login does not transfer to the candidate.

## Not Yet Claimed

The alpha docs and release notes must not claim:

- production-ready signed distribution while artifacts are unsigned alpha builds;
- validated real-account Claude Code or Codex compatibility for a candidate that lacks completed manual RC evidence for the exact packaged artifact;
- Gemini CLI headless deck editing while Gemini remains detection-only;
- physical dual-screen reliability from Electron E2E alone;
- real provider safety from fake-fetch tests alone.
- raster PDF visual-regression coverage from structural PDF checks or PNG goldens.

Use [Testing](testing.md), [Release](release.md), and [dev/release.md](dev/release.md) for the detailed command contracts.
