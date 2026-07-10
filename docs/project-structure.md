# Project Structure

An HTMLslide project is a normal folder. Source files stay readable and agent-editable.

```text
my-deck/
  deck.json
  slides/
  notes/
  theme/
  assets/
  skills/
  .agents/
  .claude/
  .htmlslide/
  exports/
```

## Source

- `deck.json`: manifest and slide list.
- `slides/`: HTML slide source.
- `notes/`: speaker notes.
- `theme/`: CSS, tokens, and layout rules.
- `assets/`: local images, fonts, and data.

## Runtime and reports

- `.htmlslide/`: checkpoints, reports, and local runtime state.
- `skills/`, `.agents/`, `.claude/`: project-local guidance for agents.

## Exports

`exports/` is compiler-owned. Do not edit generated PDF, HTML, deckpkg, thumbnails, `notes.json`, or `export-manifest.json` by hand. The manifest records source and artifact SHA-256 integrity metadata, is not a digital signature, and acts as the commit marker for the latest completed export.

Exports use a project-level lock and private staging under `.htmlslide/cache/`. Artifact files are committed first and the manifest is atomically replaced last. Partial exports clean up only files owned by the previous valid manifest that the new invocation omits; unrelated files are left alone.

For the formal rules, see [spec/deck.md](spec/deck.md), [spec/project-structure.md](spec/project-structure.md), and [spec/export.md](spec/export.md).
