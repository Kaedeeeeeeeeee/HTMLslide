# Troubleshooting

## Gatekeeper warning

Current alpha artifacts are unsigned alpha builds. They are not Developer ID signed and not notarized, so Gatekeeper may warn. Use only artifacts from trusted CI runs or release candidates.

## CLI not found

Open Settings and reinstall the CLI shim. Then run:

```bash
htmlslide doctor --json
```

If the target directory is not on `PATH`, use the manual install command shown in Settings or add the target directory to your shell profile.

## provider errors

For BYOK, check provider key validity, model name, base URL for compatible providers, billing/quota, and network access. Do not paste API keys into issue reports.

## deckpkg will not open

Verify the file was exported by HTMLslide and is not corrupted. Re-export the deck and try opening the new `.deckpkg`.

## Check reports issues

Open the QA panel. Common alpha issues include text overflow, missing local assets, remote assets, remote fonts, and missing speaker notes.
