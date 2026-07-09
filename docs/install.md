# Install HTMLslide

HTMLslide alpha builds are macOS app packages. The current alpha artifact is an unsigned alpha build for tester and contributor validation.

## Current Artifact

The alpha package workflow creates:

- `HTMLslide-<version>-unsigned-alpha-<arch>.dmg`
- `HTMLslide-<version>-unsigned-alpha-<arch>.zip`
- `HTMLslide-<version>-unsigned-alpha-<arch>.json`

The current alpha is not Developer ID signed, not notarized, and not stapled. Gatekeeper can warn on first launch. Treat these artifacts as internal/tester artifacts until a signed release workflow is available.

## Install

1. Download the DMG from a trusted GitHub Actions artifact or release candidate.
2. Open the DMG.
3. Drag `HTMLslide.app` to Applications or a test install folder.
4. Open the app.
5. Choose a workspace.
6. Let first-run setup install the CLI shim and official skills.

## CLI shim

The app manages a small `htmlslide` CLI shim. It prefers the CLI runtime packaged inside `HTMLslide.app` and falls back to development paths only when explicitly installed that way.

Run this after setup:

```bash
htmlslide doctor --json
```

See [Troubleshooting](troubleshooting.md) if the command is not on `PATH`.
