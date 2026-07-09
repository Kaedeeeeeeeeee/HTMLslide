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

## Reporting bugs

Use the GitHub issue forms instead of blank issues. Include the affected area, version or commit, platform, reproduction steps, expected and actual behavior, and sanitized diagnostics such as:

```bash
htmlslide doctor --json
htmlslide check <project> --json
```

Rendering bugs should include the smallest sanitized deck fixture plus affected export artifacts or visual diffs. External-agent bugs should include the adapter, workflow, sanitized diagnostics, and whether project-boundary behavior looked wrong.

Do not paste API keys, provider tokens, raw provider prompts, private deck content, personal data, or unreleased customer material into public issues.
