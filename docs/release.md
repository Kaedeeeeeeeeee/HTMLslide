# Release

HTMLslide currently has an unsigned alpha package workflow and a future signed release path.

## unsigned alpha

The alpha workflow builds unsigned alpha DMG/ZIP artifacts. These artifacts are for testing and must not be described as production-ready signed distribution.

## signed and notarized

A production release requires Developer ID signing, notarization, stapling, helper/CLI binary signing, release artifact naming, and documented secret ownership. Signing and notarization secrets must live in GitHub Actions secrets or organization-owned secret storage, not in the repository.

## GitHub Actions

CI runs lint, typecheck, tests, build, docs checks, and Electron E2E. The alpha package workflow runs the package smoke before uploading artifacts.

See [dev/release.md](dev/release.md) for the detailed release contract.
