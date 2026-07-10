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
      export.lock
      export-staging/
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
- `exports/export-manifest.json`: compiler-owned commit marker for the latest completed export invocation.
- `exports/thumbnails/`

Agents should edit source areas. The compiler owns artifact areas.

The compiler also owns transient export coordination state under `.htmlslide/cache/`. The project-level export lock serializes compiler writes for one project, and private staging directories hold uncommitted bytes. Staged files are not exports. The compiler commits artifacts first and atomically replaces `exports/export-manifest.json` last.

## Project Loading

The core loader accepts a project directory, a `deck.json` file path, or a path inside a project. It walks upward until it finds `deck.json`, validates schema version `0.1.0`, resolves manifest paths against the project root, and verifies referenced slide, notes, and theme files by default.

Missing source files produce `missing-file` issues. Invalid manifests produce `schema-validation` issues.

## App Project Library

The desktop app keeps a local recent-project index at its Electron user-data `library.json` path. The index stores project metadata such as title, path, last-opened time, status, slide count, and optional thumbnail path. It does not store deck source content.

Opening a recent project refreshes the index from the project manifest. If referenced source files are missing, the app records the project as `Missing files` and keeps the user in the Project Library. Removing a recent project deletes only the index entry; it never deletes the project folder or artifacts.
