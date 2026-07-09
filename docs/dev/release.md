# Release

HTMLslide uses SemVer for app releases and a separate schema version for deck format compatibility.

- `0.x`: breaking changes are allowed with migration notes.
- `1.0`: stable project format and CLI contract.
- `schemaVersion`: versioned independently from `appVersion`.

## CI Workflows

- `CI`: runs `pnpm install --frozen-lockfile`, `pnpm docs:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm perf:smoke`, `pnpm security:check`, and `pnpm build` on Ubuntu, plus `pnpm e2e:desktop` on macOS for Electron workspace/presenter smoke coverage.
- `Alpha Package`: runs on manual dispatch, nightly schedule, and `v*` tags. It repeats the CI checks including `pnpm perf:smoke` and `pnpm security:check`, runs macOS desktop Electron E2E before packaging, runs `pnpm package:alpha`, smokes the generated package, and uploads unsigned artifacts.
- `Release macOS`: runs on manual dispatch and `v*` tags. It repeats docs/lint/typecheck/test/perf/security/build/Electron E2E, imports a Developer ID certificate from GitHub Actions secrets, runs `pnpm package:release:macos`, notarizes and staples the DMG, generates release notes from git history with `pnpm release:notes`, uploads signed artifacts, and attaches them to the matching GitHub Release for tag builds.

Both workflows intentionally fail early if the root package scaffold is missing required scripts. Add those scripts in the app scaffold rather than weakening workflow checks.

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

The alpha bundle may be ad-hoc signed to keep the local app bundle internally valid, but it is not Developer ID signed, notarized, or stapled. Treat it as an internal/tester artifact, not a production release. Testers may see Gatekeeper warnings and may need to right-click Open for the first launch.

The DMG contains `HTMLslide.app` and an `Applications` symlink. The ZIP is provided as a fallback transport artifact for CI downloads and manual inspection.

After packaging, run the package smoke:

```bash
pnpm smoke:package:alpha
```

The smoke mounts the DMG, copies `HTMLslide.app` into a temporary install directory, verifies the packaged app declares `.deckpkg` as an owned macOS document type, launches the packaged app with isolated user data, verifies packaged first-run CLI provisioning and official skill installation into isolated target directories, moves the app to a second temporary install location, relaunches it to repair the recorded app path used by the CLI shim, exports a fixture deck through the packaged CLI, launches the packaged app with that `.deckpkg` as a direct file argument, waits for the renderer to confirm presenter mode opened the expected deck, installs a temporary HTMLslide-managed CLI shim, verifies `htmlslide doctor --json` through that shim, and uninstalls it. It never writes to real `/Applications` or the user's real `~/.htmlslide`.

## Alpha Checklist

Before calling an alpha build public, generate an acceptance checklist and record the release-candidate evidence:

```bash
pnpm rc:checklist -- --channel alpha --ci-run-url <ci-url> --package-run-url <alpha-package-url> --artifact-url <dmg-url>
```

The generated Markdown file under `dist/acceptance/` is intentionally ignored by git. Attach or paste the completed checklist into the release candidate notes. It records the mandatory manual script from Phase 19.16: clean macOS account, DMG install, first launch, mock/local deck creation, BYOK when available, fake external agent, PDF/deckpkg export, external-monitor presentation, reopen, agent-run revert, CLI uninstall, and post-delete file cleanup.

Also verify:

- DMG/package installs and the app launches.
- CLI shim installs and `htmlslide doctor` passes.
- Official skills install during first-run setup.
- New Deck, Open Folder, and Project Library work.
- Mock provider full flow passes.
- At least one real provider is manually validated when credentials are available.
- Outline, visual directions, and full deck generation work.
- Checks find `text-overflow`, missing asset, and missing notes issues.
- PDF page count and PNG thumbnails match the deck.
- deckpkg opens from a direct file argument in both Electron E2E and packaged-app smoke, from a macOS `open-file` event in Electron E2E, and from Finder/LaunchServices in a manual test.
- Rehearsal mode works.
- Audience window opens and syncs in Electron E2E; physical dual-screen presenter placement has been manually tested.
- Fake external agent automation passes.
- At least one real Claude/Codex integration is manually validated before claiming support.
- Unit, CLI E2E, compiler regression, Electron E2E, and packaging smoke tests pass.

## Signed Releases

Signed and notarized macOS releases are intentionally out of the unsigned alpha workflow. Production releases use `.github/workflows/release-macos.yml` and the release packaging contract:

```bash
pnpm package:release:macos
```

The release script uses `build/package/release-macos.json` and writes:

- `dist/release/HTMLslide-<version>-signed-notarized-<arch>.dmg`
- `dist/release/HTMLslide-<version>-signed-notarized-<arch>.json`

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

The certificate secret must be a base64-encoded Developer ID Application `.p12`. The workflow imports it into a temporary keychain, signs the app with hardened runtime, signs the DMG, submits the DMG with `xcrun notarytool --wait`, staples and validates the DMG with `xcrun stapler`, then checks the manifest for `channel: release`, `signing: developer-id`, `notarized: true`, and `stapled: true`.

Signing and notarization secrets must be company-owned repository or organization secrets, never committed files or personal local credentials.

## Release Notes

Release notes should include:

- User-visible changes.
- Breaking changes and migrations.
- Deck schema changes.
- Known limitations.
- Manual validation performed.
- Git commit range since the previous `v*` tag.
- Links to unsigned or signed artifacts as appropriate.
