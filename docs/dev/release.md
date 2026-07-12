# Release

HTMLslide uses SemVer for app releases and a separate schema version for deck format compatibility.

- `0.x`: breaking changes are allowed with migration notes.
- `1.0`: stable project format and CLI contract.
- `schemaVersion`: versioned independently from `appVersion`.

## CI Workflows

- `CI`: runs `pnpm install --frozen-lockfile`, installs Playwright Chromium, then runs `pnpm docs:check`, `pnpm docs:build`, `pnpm version:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:visual:browser`, `pnpm perf:smoke`, `pnpm security:check`, and `pnpm build` on Ubuntu, plus `pnpm e2e:desktop` and `pnpm e2e:desktop:a11y` on macOS for Electron workspace/presenter smoke and app-shell accessibility coverage.
- `Docs Pages`: runs on manual dispatch, pushes to `main`, and `v*` tags. It checks public docs, builds `dist/docs-site`, uploads a Pages artifact, and deploys it with GitHub Pages.
- `Alpha Package`: runs on manual dispatch, nightly schedule, and `v*` tags. It installs Playwright Chromium, repeats the CI checks including browser visual regression, runs macOS desktop Electron E2E and desktop accessibility E2E before packaging, runs `pnpm package:alpha`, smokes the generated package through its bundled browser runtime, and uploads unsigned artifacts.
- `Release macOS`: runs on manual dispatch and `v*` tags. It installs Playwright Chromium, repeats docs check/docs build/version check/lint/typecheck/test/browser visual/perf/security/build/Electron E2E/desktop accessibility E2E, imports a Developer ID certificate from GitHub Actions secrets, runs `pnpm package:release:macos`, notarizes and staples the DMG, mounts and smokes the final signed package through its bundled browser runtime, generates release notes from git history with `pnpm release:notes`, uploads signed artifacts, and attaches them to the matching GitHub Release for tag builds.

GitHub-hosted action implementations use Node 24 runtimes, while HTMLslide project commands continue to run on the declared Node 22 toolchain. Validation, documentation, and security jobs pin the `ubuntu-24.04` OS label; Electron E2E, accessibility, alpha packaging, and signed release jobs pin the currently verified Apple Silicon `macos-26` OS label. This prevents `*-latest` from silently changing the OS major or architecture, but GitHub can still update Xcode, browsers, and other software within each image line.

Both workflows intentionally fail early if the root package scaffold is missing required scripts. Add those scripts in the app scaffold rather than weakening workflow checks.

## Versioning Contract

HTMLslide uses SemVer for app/package releases and a separate deck schema version for project compatibility:

```bash
pnpm version:check
```

The root `package.json` version and every workspace package version must match `HTMLSLIDE_APP_VERSION` in `packages/core/src/version.ts`. Artifact schema versions live in the same file but stay domain-specific: `DECK_SCHEMA_VERSION` for deck manifests, `DECK_PACKAGE_SCHEMA_VERSION` for deckpkg/notes/presenter-settings, `EXPORT_MANIFEST_SCHEMA_VERSION` for compiler-owned export commit markers, `CHECK_REPORT_SCHEMA_VERSION` for checker reports, `AGENT_RUN_REPORT_SCHEMA_VERSION` for desktop agent-run reports, and `CHECKPOINT_SCHEMA_VERSION` for file-copy checkpoints. These versions are intentionally independent from app/package version, so a patch release does not imply a deck-format migration.

CLI version output, generated project manifests, compiler sidecars, official skills, performance fixtures, release notes, and packaging scripts must read those constants rather than declaring local `0.1.0` literals. The packaging scripts run `pnpm version:check` before building artifacts, and tag builds must use `v<package.json version>`.

## Unsigned Alpha Packaging

The alpha packaging contract is:

```bash
pnpm package:alpha
```

The script runs the desktop build and creates current-architecture macOS alpha artifacts under:

- `dist/alpha/HTMLslide-<version>-unsigned-alpha-<arch>.dmg`
- `dist/alpha/HTMLslide-<version>-unsigned-alpha-<arch>.zip`
- `dist/alpha/HTMLslide-<version>-unsigned-alpha-<arch>.json`

Alpha packaging uses the installed Electron macOS runtime and `hdiutil`/`ditto`, so it must run on macOS. The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder-style tooling does not silently sign with a local Developer ID identity.
The JSON manifest records the artifact paths plus per-artifact filename, byte size, and SHA-256 digest. Package smoke recomputes those values against the DMG and ZIP before launching the app.

The development compiler resolves Chromium from the Playwright browser cache. Packaging copies the tested Chromium headless-shell runtime into `HTMLslide.app` under the private CLI `browser-runtime/` directory and writes a relative executable path to `browser-runtime.json`. Both unsigned and signed packages must fail packaging if the source browser is unavailable or the copied runtime is missing, invalid, escaping the private CLI runtime, symlinked, or not executable. Export never downloads Chromium at runtime and has no PDF/thumbnail fallback.

The alpha bundle may be ad-hoc signed to keep the local app bundle internally valid, but it is not Developer ID signed, notarized, or stapled. Treat it as an internal/tester artifact, not a production release. Testers may see Gatekeeper warnings and may need to right-click Open for the first launch.

The DMG contains `HTMLslide.app` and an `Applications` symlink. The ZIP is provided as a fallback transport artifact for CI downloads and is also extracted during smoke verification.

After packaging, run the package smoke:

```bash
pnpm smoke:package:alpha
```

The smoke extracts the ZIP when present, verifies it contains `HTMLslide.app`, checks the `.deckpkg` document type, validates private `browser-runtime.json` and Chromium, installs a temporary shim from the ZIP app, verifies `htmlslide doctor --json`, verifies packaged MCP diagnostics with `htmlslide mcp --list-tools --json` and project-scoped `htmlslide mcp --status --json`, and uninstalls it. It then mounts the DMG, copies `HTMLslide.app` into a temporary install directory, verifies the packaged app declares `.deckpkg` as an owned macOS document type, launches the packaged app with isolated user data, verifies packaged first-run CLI provisioning and official skill installation into isolated target directories, moves the app to a second temporary install location, relaunches it to repair the recorded app path used by the CLI shim, and creates a fixture deckpkg through the packaged CLI with an empty developer browser cache. That package command must discover Chromium from the installed app's `browser-runtime.json`; using the developer Playwright cache is not acceptable package evidence. The smoke validates the deckpkg PDF page count and all thumbnail dimensions, launches the packaged app with the resulting `.deckpkg`, waits for presenter mode, opens the same package through macOS LaunchServices, verifies the managed CLI shim and packaged MCP diagnostics, and uninstalls the shim. It never writes to real `/Applications` or the user's real `~/.htmlslide`, and it does not change the tester's default Finder handler for `.deckpkg`.

## Alpha Checklist

Before calling an alpha build public, generate an acceptance checklist and record the release-candidate evidence:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <alpha-package-url> --artifact-url <dmg-url>
```

The generated Markdown file under `dist/acceptance/` is intentionally ignored by git. Attach or paste the completed checklist into the release candidate notes. It records the mandatory manual script from Phase 19.16: clean macOS account, DMG install, first launch, mock/local deck creation, BYOK when available, fake external agent, real Claude/Codex/Gemini claim validation or an explicit no-claim N/A, PDF/deckpkg export, external-monitor presentation, reopen, agent-run revert, CLI uninstall, and post-delete file cleanup.

For a real Claude Code or Codex CLI compatibility claim, start from the fixed sanitized example at [`docs/examples/external-agent-rc-evidence-input.json`](../examples/external-agent-rc-evidence-input.json), replace only its fake provider/run metadata with the tester's sanitized results, and verify it against the exact candidate package manifest:

```bash
pnpm rc:external-agent-evidence -- \
  --evidence /path/to/external-agent-evidence-input.json \
  --package-manifest /path/to/HTMLslide-alpha-manifest.json \
  --commit <candidate-commit> \
  --artifact-url <candidate-artifact-url> \
  --output /path/to/external-agent-acceptance-evidence.json
```

The verifier rejects raw logs, secrets, absolute paths, unsupported fields, mismatched provider auth commands, incomplete Check/Export/Revert evidence, and package manifests whose signing/channel contract is inconsistent. Its output contains only sanitized metadata and input/package SHA-256 digests; it does not prove the manual run occurred by itself, so the human tester must retain the evidence link and exact artifact notes in the RC checklist.

The Alpha Package and Release macOS workflows also generate a prefilled RC checklist in their uploaded artifact bundle. Treat that file as a run-bound evidence template, not completed acceptance, until a tester fills in the manual results.

Also verify:

- DMG/package installs and the app launches.
- CLI shim installs and `htmlslide doctor` passes.
- Official skills install during first-run setup.
- New Deck, Open Folder, and Project Library work.
- Mock provider full flow passes.
- At least one real provider is manually validated when credentials are available.
- The exact real-provider desktop run produces 8-12 slides and passes `pnpm rc:byok-evidence -- --project <deck> --provider-validation <validation.json> --run-id <run-id> --commit <commit> --artifact-url <artifact-url>`.
- Outline, visual directions, and full deck generation work.
- Checks find `text-overflow`, missing asset, and missing notes issues.
- Chromium PDF page count, normalized metadata, and repeated-export determinism match the deck; PNG full-slide and real DOM thumbnail goldens stay within 0.2 percent and 0.5 percent respectively. PDF acceptance is structural and same-DOM Chromium evidence, not raster visual regression.
- deckpkg opens from a direct file argument in both Electron E2E and packaged-app smoke, from a macOS `open-file` event in Electron E2E, through LaunchServices `open -a` in packaged-app smoke, and through Finder default double-click in a manual test.
- Rehearsal mode works.
- Audience window opens and syncs in Electron E2E; physical dual-screen presenter placement has been manually tested.
- Fake external agent automation passes.
- At least one real Claude/Codex/Gemini integration is manually validated before claiming support.
- Unit, CLI E2E, compiler regression, Electron E2E, and packaging smoke tests pass.

## Signed Releases

Signed and notarized macOS releases are intentionally out of the unsigned alpha workflow. Production releases use `.github/workflows/release-macos.yml` and the release packaging contract:

```bash
pnpm package:release:macos
```

Run the release-only configuration contract locally without signing credentials:

```bash
pnpm release:contract:check
```

The release script uses `build/package/release-macos.json` and writes:

- `dist/release/HTMLslide-<version>-signed-notarized-<arch>.dmg`
- `dist/release/HTMLslide-<version>-signed-notarized-<arch>.json`

The hosted signed release workflow currently publishes Apple Silicon (`arm64`) artifacts only. Intel and universal macOS release artifacts are not yet part of the production workflow.

The release manifest uses the same per-artifact filename, byte size, and SHA-256 metadata as alpha builds.
Manual `workflow_dispatch` runs can pass the optional `release_tag` input to label the uploaded RC checklist. Tag-triggered runs always use the pushed tag. Manual runs without an input use `manual-<run_number>` so checklist metadata remains run-bound instead of `TODO`.
The release workflow also writes `release-artifacts/RELEASE_NOTES.md` for tag builds and uses it as the GitHub Release body. Run the same generator locally when preparing a candidate:

```bash
pnpm release:notes -- --tag vX.Y.Z --output dist/release/RELEASE_NOTES.md
```

The workflow requires these repository or organization secrets:

- `APPLE_DEVELOPER_ID_APPLICATION`
- `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `KEYCHAIN_PASSWORD`

The first workflow gate runs `scripts/release/validate-release-contract.mjs` before dependency installation. It checks the release-only package config, required script names, secret presence, and the certificate secret's base64/DER shape without printing secret values. The certificate secret must be a base64-encoded Developer ID Application `.p12`; only keychain import and identity matching can prove that it is the requested identity. The workflow imports it into a temporary keychain, signs the app with hardened runtime, signs the DMG, submits the DMG with `xcrun notarytool --wait`, staples and validates the DMG with `xcrun stapler`, checks the manifest for `channel: release`, `arch: arm64`, `signing: developer-id`, `notarized: true`, and `stapled: true`, then mounts the signed DMG and runs the packaged Chromium export smoke before publishing.

The config-only portion can be run locally without Developer ID credentials:

```bash
pnpm release:contract:check
```

Signing and notarization secrets must be company-owned repository or organization secrets, never committed files or personal local credentials.

The workflow-generated `HTMLslide-release-rc-acceptance.md` is a run-bound checklist template, not completed acceptance evidence. A tag-triggered run can create or update a GitHub Release after its automated gates, but it does not infer or verify the human checklist result. Do not treat that release as public acceptance until a tester completes the checklist and runs `pnpm rc:checklist:verify`, or links equivalent recorded evidence in the release notes.

## Release Notes

Release notes should include:

- User-visible changes.
- Breaking changes and migrations.
- Deck schema changes.
- Known limitations.
- Manual validation performed.
- Git commit range since the previous `v*` tag.
- Links to unsigned or signed artifacts as appropriate.

## Docs Publishing

Build the publishable documentation site locally before changing release docs:

```bash
pnpm docs:build
```

The build writes static HTML to `dist/docs-site`, includes `.nojekyll` for GitHub Pages, copies docs assets, and fails on generated local links that do not resolve. The `Docs Pages` workflow deploys this directory from `main` and `v*` tags. Roll back docs by reverting the source Markdown or the docs build workflow and rerunning the workflow.
