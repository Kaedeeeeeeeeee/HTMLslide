# Testing

The standard local checks are:

```bash
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
```

Packaging smoke:

```bash
pnpm package:alpha
pnpm smoke:package:alpha
```

Signed macOS release packaging is handled by GitHub Actions with Apple signing secrets:

```bash
pnpm package:release:macos
```

## Coverage expectations

- Unit tests cover core, CLI, compiler, linter, agent, MCP, skills, and desktop services, including CLI MCP tool discovery, project harness status checks, and stdio client smoke coverage.
- Browser renderer tests cover production `playwright-core` Chromium output, render-root and network isolation, disabled page JavaScript, resource/readiness failures, normalized PDF metadata, unavailable-browser failure, and repeated-byte determinism.
- Compiler regression runs the minimal, text-heavy, data chart, image-heavy, notes, and multi-theme fixture families through Chromium. PNG visual regression compares vector-only full-slide captures at 0.2 percent and real DOM thumbnails at 0.5 percent, writing `before`, `after`, and `diff` artifacts under `dist/visual-regression/` when they fail.
- PDF verification covers page count, normalized metadata, repeated-byte determinism for the pinned Chromium build, and generation from the same staged DOM as thumbnails. It does not claim raster PDF visual regression.
- CLI tests cover BYOK provider validation with fake fetch and fake environment variables so `htmlslide agent validate-provider` remains deterministic and does not print API key values.
- Desktop Electron E2E covers onboarding, project library, mock generation, checks, QA panel role semantics, export, presenter, deckpkg open, CLI setup, and official skills setup.
- Official skills E2E covers the inspectable Skills library, including install-state and deck-type filtering, expanded metadata review, risk flags, install paths, and markdown previews before installation.
- Docs check validates required public docs, GitHub issue template contracts, and the pull request template, including reproducible bug fields, diagnostics prompts, privacy confirmation, and private security reporting links.
- Performance smoke records 20-slide preview, PDF export, checker, and presenter state timings with CI guardrails; alpha/RC hardware baselines remain manual validation data.
- Security check scans tracked source files for common committed secret formats and runs `pnpm audit --audit-level high`.
- Docs build renders the publishable GitHub Pages site into `dist/docs-site` and validates generated local links before upload.
- Version check verifies all workspace package versions match `HTMLSLIDE_APP_VERSION`, keeps `DECK_SCHEMA_VERSION` independent, and rejects production version literals outside the core version contract.
- External adapter unit and desktop service tests use injected runners and controlled fake Claude/Codex executables. They cover exact argv, isolated cwd, command-contract probes, Claude tool/setting restrictions, Codex `workspace-write`/ephemeral/user-config isolation, `codex login status`, runtime readiness gating, adapter identity, metadata-only renderer logs, timeout, process-group cancellation, symlink and concurrent-edit rejection, checkpoint diff, and Check/Export gating. Shared registry E2E covers retry; built-in Codex E2E covers review and revert.
- Electron E2E may run a detected fake built-in Claude or Codex path, plus the Generic command path, without provider credentials or network access. Gemini coverage is detection-only and must prove that it cannot become headless-ready.
- Release-candidate acceptance uses `pnpm rc:checklist` to generate the mandatory manual evidence template for clean-account install, first launch, provider flows, fake external agent automation, real Claude/Codex claim validation or explicit no-claim N/A, Gemini detection-only status, export, external monitor presentation, reopen, revert, CLI uninstall, and post-delete cleanup. A completed real-provider desktop run additionally uses `pnpm rc:byok-evidence` to bind sanitized provider validation, an explicit 8-12 slide run report, compatible endpoint hash, checkpoint snapshot integrity, authoritative check/export, current source fingerprints, and artifact hashes. Release-script tests cover both commands plus release-note rendering and fail-closed evidence cases. Alpha Package and Release macOS upload a prefilled but incomplete checklist next to candidate artifacts so manual evidence stays tied to the exact run.
- Release evidence script tests cover deterministic RC checklist, BYOK evidence verification, and release-note rendering. The BYOK matrix covers wrong run/provider/count, endpoint mismatch, malformed reports/manifests, stale sources/artifacts, checkpoint tampering, project-source secrets, and symlinked report/output paths.
- package smoke validates the private `browser-runtime.json` and bundled Chromium, forces the packaged CLI package operation through that executable rather than the development Playwright cache, and covers manifest artifact size/SHA-256 verification, PDF page count, PNG dimensions, DMG mount, packaged app launch, first-run CLI shim, official skills, moved-app CLI repair, deckpkg argument open, packaged MCP diagnostics, `htmlslide doctor`, and CLI uninstall. The release workflow runs the same smoke against the final Developer ID signed, notarized, and stapled DMG before artifact upload.

Focused Phase 2 export verification:

```bash
pnpm test -- packages/compiler/test/browser-renderer.test.ts packages/compiler/test/export.test.ts
pnpm test:visual:browser
pnpm verify:package:alpha
```

## External Adapter Evidence

CI uses mock providers, fake provider validation responses, and fake external commands. A fake Claude or Codex executable can prove HTMLslide's invocation, permissions, local process control, cancellation, diff, Check/Export, and revert behavior. It cannot prove a real provider account, subscription, installed CLI version, authentication flow, or packaged macOS artifact.

Real Claude Code and Codex compatibility remain manual validation steps. Run them with the tester's own authenticated CLI installation against the exact packaged RC, then attach the version/auth status, edit result, cancellation result, changed-file review, Check/Export result, revert result, and secret-safety notes to that artifact's completed checklist. Do not reuse evidence from a source checkout or another build as RC evidence.

Gemini CLI remains detection-only. Automated tests should verify discovery and non-runnable gating; neither CI nor manual detection is evidence of headless deck editing.

See [dev/testing.md](dev/testing.md) for developer-level details.
