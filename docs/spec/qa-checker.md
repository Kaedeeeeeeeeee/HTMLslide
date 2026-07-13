# QA Checker Spec v0.1

The HTMLslide QA checker validates deck projects and writes an agent-readable report at `.htmlslide/reports/report.json`. During the CLI transition it also writes `.htmlslide/reports/check-report.json` with the same payload.

## Report Shape

```json
{
  "schemaVersion": "0.1.0",
  "status": "failed",
  "projectPath": "/absolute/project/path",
  "summary": {
    "errors": 1,
    "warnings": 2,
    "info": 0,
    "suggestions": 0
  },
  "issues": [
    {
      "slideId": "001-title",
      "severity": "error",
      "type": "slide-id-mismatch",
      "path": "slides/001-title.html",
      "selector": "[data-slide-id]",
      "message": "data-slide-id is \"wrong\", expected \"001-title\".",
      "measurement": {
        "expectedSlideId": "001-title",
        "actualSlideId": "wrong"
      },
      "suggestedFix": "Keep deck.json slide ids and slide source data-slide-id values identical.",
      "agentInstruction": "Change the root slide data-slide-id in slides/001-title.html to \"001-title\" without changing deck.json."
    }
  ]
}
```

Every checker-produced issue must include `slideId`, `severity`, `type`, `message`, `measurement`, `suggestedFix`, and `agentInstruction`. `path` and `selector` should be present when a file or DOM target is known.

## QA Ignore Rules

Projects may opt into stable type-level suppressions in `.htmlslide/qa-ignores.json`:

```json
{
  "version": 1,
  "issueTypes": ["title-too-long"]
}
```

The shared linter, CLI, desktop Check action, and export gate apply these rules consistently. `Ignore once` is an in-memory desktop review action and does not write the file. Invalid configuration fails closed with `qa-ignore-config-invalid`.

## Checks

- Core project checks: `deck.json` schema, duplicate slide ids, safe project paths, and referenced slide, notes, and theme files via `@htmlslide/core`.
- Source checks: `data-slide-id` mismatch, safe area violation, text overflow, low contrast inline text, remote asset, remote font, remote script, missing local asset, title too long, and body too dense.
- Notes checks: missing notes references and notes files that are too short for a useful talk track.
- Export checks: requested PDF, HTML, deckpkg, speaker notes, and thumbnail artifacts are checked against the compiler-owned SHA-256 commit marker. The checker reports missing, untracked, metadata-mismatched, manually modified, or source-outdated exports. Projects created before export metadata existed receive an actionable warning and retain the legacy mtime fallback until the next successful export.

Export issue types are stable:

- `export-manifest-missing`: requested exports exist without `exports/export-manifest.json`; this is a warning for legacy projects and enables the mtime fallback.
- `export-manifest-invalid`: the manifest is malformed, truncated, unsupported, or internally inconsistent; this is an error and fails closed without an mtime fallback.
- `export-untracked`: an expected artifact exists but is absent from the latest compiler manifest.
- `export-manifest-mismatch`: artifact kind or thumbnail slide metadata does not match the expected export contract.
- `export-modified`: current artifact bytes differ from the recorded size or SHA-256.
- `export-outdated`: current source fingerprints differ from the recorded source digest, or the legacy mtime fallback finds newer sources when the manifest is missing.

A manifest that is present but cannot be parsed and validated must never be treated like a missing legacy manifest. The checker must return a failed report with `export-manifest-invalid`; timestamps cannot re-establish integrity after a corrupt or partially written commit marker.

The Alpha layout checkers are static and deterministic. The safe-area checker reports `safe-area-violation` for
absolute or fixed positioned elements with inline pixel geometry that cross `deck.json` safe area bounds. The
text-overflow checker reports `text-overflow` when a slide source explicitly declares `data-htmlslide-overflow="text"`
or when a text-bearing element has clipped overflow, a fixed `height` or `max-height`, and estimated text height above
the container. Issues include pixel overflow measurements and known bounds so agents can repair them without a browser
session. The contrast checker reports `low-contrast` warnings for text-bearing elements with parseable inline
`color` plus `background-color` or `background` declarations below the WCAG AA 4.5:1 text contrast threshold.

## Sorting

Issues are sorted deterministically by severity (`error`, `warning`, `info`), slide order, path, type, selector, and message. Deck-level issues use `slideId: "deck"` and sort before slide-level issues within the same severity.

## Limitations

The current layout checkers are static Alpha passes, not full browser geometry passes. They are designed to catch
deterministic fixed-text-box and positioned-element failures in CI; full DOM geometry checks should replace or
supplement them when the checker owns a renderer/browser execution path. Export fingerprints detect ordinary source
changes and artifact edits but are SHA-256 integrity metadata, not digital signatures; a user who deliberately rewrites
both an artifact and its compiler-owned manifest can still manufacture a matching local state. Verification describes
a bounded filesystem scan; a separate same-user process that changes a file immediately after it is hashed can make the
report stale as soon as it returns, just as with other local lint tools.

## Desktop QA Navigation

The desktop workspace keeps filmstrip badges scoped to individual slides, but the QA Panel shows the selected
severity filter across the entire deck. Each issue exposes a `Go to slide` action that selects the issue's `slideId` in
the filmstrip and updates the preview, so a clean currently selected slide cannot hide problems elsewhere in the deck.
