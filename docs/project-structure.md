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

`exports/` is compiler-owned. Do not edit generated PDF, HTML, deckpkg, thumbnails, or `notes.json` by hand.

For the formal manifest rules, see [spec/deck.md](spec/deck.md) and [spec/project-structure.md](spec/project-structure.md).
