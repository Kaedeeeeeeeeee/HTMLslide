# Project Structure Spec v0.1

An HTMLslide project is a normal folder with `deck.json` at its root. Source files are editable by users and agents. Export files are artifacts produced by HTMLslide.

```text
my-talk/
  deck.json
  AGENTS.md
  README.md
  slides/
  notes/
  theme/
  assets/
  skills/
  .htmlslide/
    cache/
    checkpoints/
    logs/
    reports/
  exports/
```

## Source Areas

- `deck.json`: deck manifest and slide order.
- `slides/`: HTML fragments with matching `data-slide-id` values.
- `notes/`: Markdown speaker notes.
- `theme/`: CSS, tokens, and layout guidance.
- `assets/`: local images, fonts, and data files.
- `skills/`, `.agents/`, `.claude/`: project-local agent guidance.

## Artifact Areas

- `exports/*.pdf`
- `exports/*.deckpkg`
- `exports/*.html`
- `exports/thumbnails/`

Agents should edit source areas. The compiler owns artifact areas.

## Project Loading

The core loader accepts a project directory, a `deck.json` file path, or a path inside a project. It walks upward until it finds `deck.json`, validates schema version `0.1.0`, resolves manifest paths against the project root, and verifies referenced slide, notes, and theme files by default.

Missing source files produce `missing-file` issues. Invalid manifests produce `schema-validation` issues.
