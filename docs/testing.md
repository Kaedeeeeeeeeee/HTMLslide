# Testing

The standard local checks are:

```bash
pnpm docs:check
pnpm docs:build
pnpm lint
pnpm typecheck
pnpm test
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

- Unit tests cover core, CLI, compiler, linter, agent, MCP, skills, and desktop services.
- Desktop Electron E2E covers onboarding, project library, mock generation, checks, export, presenter, deckpkg open, CLI setup, and official skills setup.
- Performance smoke records 20-slide preview, PDF export, checker, and presenter state timings with CI guardrails; alpha/RC hardware baselines remain manual validation data.
- Security check scans tracked source files for common committed secret formats and runs `pnpm audit --audit-level high`.
- Docs build renders the publishable GitHub Pages site into `dist/docs-site` and validates generated local links before upload.
- Release-candidate acceptance uses `pnpm rc:checklist` to generate the mandatory manual evidence template for clean-account install, first launch, provider flows, fake external agent, export, external monitor presentation, reopen, revert, CLI uninstall, and post-delete cleanup.
- package smoke covers DMG mount, packaged app launch, first-run CLI shim, official skills, moved-app CLI repair, deckpkg argument open, packaged CLI export, `htmlslide doctor`, and CLI uninstall. Release workflow contracts cover Developer ID signing, notarization, stapling, and artifact upload wiring.

CI uses mock providers and fake external commands. Real provider credentials and real Claude/Codex login must remain manual validation steps.

See [dev/testing.md](dev/testing.md) for developer-level details.
