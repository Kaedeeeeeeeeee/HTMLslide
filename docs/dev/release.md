# Release

HTMLslide uses SemVer for app releases and a separate schema version for deck format compatibility.

- `0.x`: breaking changes are allowed with migration notes.
- `1.0`: stable project format and CLI contract.
- `schemaVersion`: versioned independently from `appVersion`.

## CI Workflows

- `CI`: runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` on pull requests and pushes to `main`.
- `Alpha Package`: runs on manual dispatch, nightly schedule, and `v*` tags. It repeats the CI checks, runs `pnpm package:alpha`, and uploads unsigned artifacts.

Both workflows intentionally fail early if the root package scaffold is missing required scripts. Add those scripts in the app scaffold rather than weakening workflow checks.

## Unsigned Alpha Packaging

The alpha packaging contract is:

```bash
pnpm package:alpha
```

The script should create unsigned macOS artifacts under one of:

- `dist/`
- `release/`
- `out/`
- `build/`

Accepted artifact extensions are `.dmg`, `.zip`, `.pkg`, `.tar.gz`, and `.blockmap`. The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder-style tooling does not silently sign with a local identity.

## Alpha Checklist

Before calling an alpha build public, verify:

- DMG/package installs and the app launches.
- CLI shim installs and `htmlslide doctor` passes.
- New Deck, Open Folder, and Project Library work.
- Mock provider full flow passes.
- At least one real provider is manually validated when credentials are available.
- Outline, visual directions, and full deck generation work.
- Checks find overflow, missing asset, and missing notes issues.
- PDF page count and PNG thumbnails match the deck.
- deckpkg opens.
- Rehearsal mode works.
- Dual-screen presenter has been manually tested.
- Fake external agent automation passes.
- At least one real Claude/Codex integration is manually validated before claiming support.
- Unit, CLI E2E, compiler regression, Electron E2E, and packaging smoke tests pass.

## Signed Releases

Signed and notarized macOS releases are intentionally out of the unsigned alpha workflow. Add a separate signing workflow only after Developer ID credentials, notarization credentials, artifact naming, and secret ownership are documented. Signing secrets must be repository or organization secrets, never committed files.

## Release Notes

Release notes should include:

- User-visible changes.
- Breaking changes and migrations.
- Deck schema changes.
- Known limitations.
- Manual validation performed.
- Links to unsigned or signed artifacts as appropriate.
