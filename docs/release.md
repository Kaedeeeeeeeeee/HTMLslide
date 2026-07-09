# Release

HTMLslide has an unsigned alpha package workflow and a separate signed/notarized macOS release workflow.

## unsigned alpha

The alpha workflow builds unsigned alpha DMG/ZIP artifacts. These artifacts are for testing and must not be described as production-ready signed distribution.

## signed and notarized

A production release uses the `Release macOS` GitHub Actions workflow and `pnpm package:release:macos`. It requires Developer ID signing, notarization, stapling, release artifact naming, and documented secret ownership. Signing and notarization secrets must live in GitHub Actions repository or organization secrets, not in the repository.

The signed workflow writes `signed-notarized` DMG and manifest artifacts, uploads them as workflow artifacts, and attaches them to the matching GitHub Release when run from a `v*` tag.
Tag releases generate `RELEASE_NOTES.md` from git history with `pnpm release:notes` and use that file as the GitHub Release body.

## GitHub Pages docs

Public documentation is published by the `Docs Pages` GitHub Actions workflow. It runs `pnpm docs:check` and `pnpm docs:build`, uploads `dist/docs-site` as a Pages artifact, and deploys it with GitHub Pages. The workflow runs on pushes to `main`, `v*` tags, and manual dispatch.

The docs build writes `.nojekyll`, renders Markdown from `docs/` into static HTML, copies static assets, and validates generated local links before upload.

## GitHub Actions

CI runs lint, typecheck, tests, performance smoke, security checks, build, docs checks, docs build, and Electron E2E. The alpha package workflow runs the package smoke before uploading unsigned artifacts. The release workflow runs the same quality gates before signing and notarization.

Every release candidate must also have a completed manual acceptance checklist generated with `pnpm rc:checklist`. The generated checklist is release evidence, not source code, and should be attached to the candidate notes.

See [dev/release.md](dev/release.md) for the detailed release contract.
