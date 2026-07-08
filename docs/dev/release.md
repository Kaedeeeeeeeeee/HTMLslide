# Release

HTMLslide uses SemVer for app releases and a separate schema version for deck format compatibility.

- `0.x`: breaking changes are allowed with migration notes.
- `1.0`: stable project format and CLI contract.
- `schemaVersion`: versioned independently from `appVersion`.

## CI Workflows

- `CI`: runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` on Ubuntu, plus `pnpm e2e:desktop` on macOS for Electron workspace/presenter smoke coverage.
- `Alpha Package`: runs on manual dispatch, nightly schedule, and `v*` tags. It repeats the CI checks, runs macOS desktop Electron E2E before packaging, runs `pnpm package:alpha`, smokes the generated package, and uploads unsigned artifacts.

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

The smoke mounts the DMG, copies `HTMLslide.app` into a temporary install directory, launches the packaged app with isolated user data, verifies packaged first-run CLI provisioning into an isolated target directory, installs a temporary HTMLslide-managed CLI shim, verifies `htmlslide doctor --json` through that shim, and uninstalls it. It never writes to real `/Applications` or the user's real `~/.htmlslide`.

## Alpha Checklist

Before calling an alpha build public, verify:

- DMG/package installs and the app launches.
- CLI shim installs and `htmlslide doctor` passes.
- New Deck, Open Folder, and Project Library work.
- Mock provider full flow passes.
- At least one real provider is manually validated when credentials are available.
- Outline, visual directions, and full deck generation work.
- Checks find `text-overflow`, missing asset, and missing notes issues.
- PDF page count and PNG thumbnails match the deck.
- deckpkg opens.
- Rehearsal mode works.
- Dual-screen presenter has been manually tested.
- Fake external agent automation passes.
- At least one real Claude/Codex integration is manually validated before claiming support.
- Unit, CLI E2E, compiler regression, Electron E2E, and packaging smoke tests pass.

## Signed Releases

Signed and notarized macOS releases are intentionally out of the unsigned alpha workflow. A production release must use a separate workflow with Developer ID signing, notarization, stapling, helper/CLI binary signing, release artifact naming, and documented secret ownership. Signing and notarization secrets must be repository or organization secrets, never committed files.

## Release Notes

Release notes should include:

- User-visible changes.
- Breaking changes and migrations.
- Deck schema changes.
- Known limitations.
- Manual validation performed.
- Links to unsigned or signed artifacts as appropriate.
