# HTMLslide Release Checklist Contract

This document defines the evidence required for a macOS HTMLslide release candidate. A passing verifier proves that the supplied files and reports are internally consistent; it does not create a signature, notarization ticket, Apple credential, or manual test result.

## Scope

The product plan names these DMG targets:

- `arm64`: Apple Silicon.
- `x64`: Intel macOS.

The release contract accepts either architecture, but the hosted `Release macOS` workflow currently builds and promotes `arm64` only. An `x64` candidate must not be described as published until a real x64 packaging run, native smoke test, and matching release evidence exist. A universal artifact is outside the current release contract.

## Candidate Files

A release bundle must contain exactly one architecture-specific DMG, one matching release manifest, and one matching security evidence report. The manifest must bind the DMG by file name, byte size, and SHA-256. The final relocated bundle is checked with:

```bash
corepack pnpm release:bundle:verify -- \
  --bundle-dir release-artifacts \
  --expected-arch arm64 \
  --team-id <apple-team-id> \
  --output release-artifacts/HTMLslide-release-bundle-evidence.json
```

The verifier rejects absolute or traversal paths, duplicate candidate files, symlinks, unsupported architectures, stale hashes, and manifest/evidence mismatches.

## Security Evidence

`release-security-evidence-<version>-<arch>.json` must be produced by the release security verifier after the package exists. It records only sanitized metadata and passed check names. The verifier must have run:

- `codesign --verify --deep --strict` for the app.
- `codesign --display` for the app, proving the configured Developer ID Application identity, bundle identifier, team identifier, and hardened runtime.
- `lipo -archs` for the app's single main executable, proving exactly the requested `arm64` or `x64` architecture. Mach-O `x86_64` is represented as contract architecture `x64`.
- `spctl --assess --type execute` for the app.
- `codesign --verify` and `codesign --display` for the DMG, proving its Developer ID Application identity and team identifier.
- `xcrun stapler validate` for the DMG.
- `spctl --assess --type open` for the DMG.

The app, DMG, and manifest metadata in that report must be hashed. The report is evidence of the commands and bytes that were checked; it is not a substitute for the external Apple account, certificate, or notarization service.

## RC Checklist

Generate a run-bound Markdown checklist from the candidate manifest:

```bash
corepack pnpm rc:checklist -- \
  --channel release \
  --candidate-run-id <github-run-id> \
  --package-manifest dist/release/HTMLslide-<version>-signed-notarized-arm64.json \
  --commit <candidate-commit> \
  --artifact-url <candidate-artifact-reference> \
  --output dist/acceptance/HTMLslide-release-rc-acceptance.md
```

The generated checklist records the target architecture, manifest SHA-256, primary DMG SHA-256, candidate run, and manual acceptance status. Verify a completed checklist with `pnpm rc:checklist:verify`; promotion requires `Accepted`, `Pass` for every manual item, no unresolved `TODO`, and matching manifest provenance.

The manual release script covers clean-account installation, first launch, mock/local generation, real BYOK generation when required by the channel, external-agent boundary checks, PDF/deckpkg export, presenter use, reopen, agent-run revert, CLI uninstall, and post-delete file review. A fixture-only provider or external-agent run is contract smoke evidence, not real acceptance evidence.

## Credential Boundary

Do not commit Apple certificates, passwords, API keys, provider tokens, or raw command output. Release secrets must be company-owned CI secrets. Local contract checks may validate secret names and shapes without reading or printing their values. A missing external credential or manual result remains a release gap.

See [the release flow](release.md), [the development release notes](dev/release.md), [the release contract verifier](../scripts/release/validate-release-contract.mjs), and the [product plan](../HTMLslide_Product_Development_Plan.md) for surrounding context.
