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

## Checks

- Core project checks: `deck.json` schema, duplicate slide ids, safe project paths, and referenced slide, notes, and theme files via `@htmlslide/core`.
- Source checks: `data-slide-id` mismatch, safe area violation, text overflow, remote asset, remote font, remote script, missing local asset, title too long, and body too dense.
- Notes checks: missing notes references and notes files that are too short for a useful talk track.
- Export checks: requested PDF, HTML, deckpkg, speaker notes, and thumbnail artifacts are reported when missing or older than deck sources.

The Alpha layout checkers are static and deterministic. The safe-area checker reports `safe-area-violation` for
absolute or fixed positioned elements with inline pixel geometry that cross `deck.json` safe area bounds. The
text-overflow checker reports `text-overflow` when a slide source explicitly declares `data-htmlslide-overflow="text"`
or when a text-bearing element has clipped overflow, a fixed `height` or `max-height`, and estimated text height above
the container. Issues include pixel overflow measurements and known bounds so agents can repair them without a browser
session.

## Sorting

Issues are sorted deterministically by severity (`error`, `warning`, `info`), slide order, path, type, selector, and message. Deck-level issues use `slideId: "deck"` and sort before slide-level issues within the same severity.

## Limitations

The current layout checkers are static Alpha passes, not full browser geometry passes. They are designed to catch
deterministic fixed-text-box and positioned-element failures in CI; full DOM geometry checks should replace or
supplement them when the checker owns a renderer/browser execution path. The current export checker uses file mtimes
and expected compiler paths. It can flag missing or stale exports, but it cannot prove whether a generated export was
manually edited after the latest source change without compiler-owned artifact metadata.
