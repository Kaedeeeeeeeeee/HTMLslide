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
    qa-ignores.json
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

`.htmlslide/qa-ignores.json` is an optional, source-controlled review preference containing stable linter issue types to suppress. It is read by the shared linter used by the CLI, desktop checks, and export gate; malformed content fails closed as `qa-ignore-config-invalid`. The desktop "Ignore once" action never writes this file.

## Project Loading

The core loader accepts a project directory, a `deck.json` file path, or a path inside a project. It walks upward until it finds `deck.json`, validates schema version `0.1.0`, resolves manifest paths against the project root, and verifies referenced slide, notes, and theme files by default.

Missing source files produce `missing-file` issues. Invalid manifests produce `schema-validation` issues.

## Preview Loading

Desktop and MCP previews use the compiler's read-only single-slide document builder. It snapshots the manifest and referenced source, resolves theme data, inlines supported local assets, and emits the selected slide through the shared renderer. Preview loading does not acquire the project export lock, create staging directories, or write `exports/` or `.htmlslide/`.

The desktop app displays that complete document in an unprivileged iframe with scripts and network access denied. Project HTML is never inserted into the privileged React document. The iframe keeps the manifest viewport in CSS pixels; the desktop shell scales that fixed canvas to the available review area.

## App Project Library

The desktop app keeps a local recent-project index at its Electron user-data `library.json` path. The index stores project metadata such as title, path, last-opened time, status, slide count, and optional thumbnail path. It does not store deck source content.

Opening a recent project refreshes the index from the project manifest. If referenced source files are missing, the app records the project as `Missing files` and keeps the user in the Project Library. Removing a recent project deletes only the index entry; it never deletes the project folder or artifacts.
