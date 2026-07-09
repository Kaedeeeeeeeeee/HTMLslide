# Testing

The standard local checks are:

```bash
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
- Visual regression tests compare deterministic fallback thumbnails and browser-rendered full-slide Chromium screenshots, writing `before`, `after`, and `diff` artifacts under `dist/visual-regression/` when they fail.
- CLI tests cover BYOK provider validation with fake fetch and fake environment variables so `htmlslide agent validate-provider` remains deterministic and does not print API key values.
- Desktop Electron E2E covers onboarding, project library, mock generation, checks, QA panel role semantics, export, presenter, deckpkg open, CLI setup, and official skills setup.
- Official skills E2E covers the inspectable Skills library, including install-state and deck-type filtering, expanded metadata review, risk flags, install paths, and markdown previews before installation.
- Docs check validates required public docs, GitHub issue template contracts, and the pull request template, including reproducible bug fields, diagnostics prompts, privacy confirmation, and private security reporting links.
- Performance smoke records 20-slide preview, PDF export, checker, and presenter state timings with CI guardrails; alpha/RC hardware baselines remain manual validation data.
- Security check scans tracked source files for common committed secret formats and runs `pnpm audit --audit-level high`.
- Docs build renders the publishable GitHub Pages site into `dist/docs-site` and validates generated local links before upload.
- Version check verifies all workspace package versions match `HTMLSLIDE_APP_VERSION`, keeps `DECK_SCHEMA_VERSION` independent, and rejects production version literals outside the core version contract.
- Release-candidate acceptance uses `pnpm rc:checklist` to generate the mandatory manual evidence template for clean-account install, first launch, provider flows, fake external agent, real Claude/Codex/Gemini claim validation or explicit no-claim N/A, export, external monitor presentation, reopen, revert, CLI uninstall, and post-delete cleanup. Alpha Package and Release macOS upload a prefilled but incomplete checklist next to candidate artifacts so manual evidence stays tied to the exact run.
- package smoke covers DMG mount, packaged app launch, first-run CLI shim, official skills, moved-app CLI repair, deckpkg argument open, packaged CLI export, packaged MCP diagnostics, `htmlslide doctor`, and CLI uninstall. Release workflow contracts cover Developer ID signing, notarization, stapling, and artifact upload wiring.

CI uses mock providers, fake provider validation responses, and fake external commands. Real provider credentials and real Claude/Codex/Gemini login must remain manual validation steps.

See [dev/testing.md](dev/testing.md) for developer-level details.
