# Export Spec v0.1

HTMLslide exports are compiler-owned artifacts under `exports/`. The compiler must not require a dev server to open exported HTML or read packaged presenter artifacts.

## Artifact Set

For the default export path, the compiler writes:

- `exports/<deck-slug>.html`
- `exports/<deck-slug>.pdf`
- `exports/<deck-slug>.deckpkg`
- `exports/notes.json`
- `exports/export-manifest.json`
- `exports/thumbnails/<slide-id>.png`
- `.htmlslide/cache/thumbnails/<slide-id>.png`

Generated filenames are deterministic for the same deck title and slide ids.

## Export Fingerprint Manifest

`exports/export-manifest.json` is compiler-owned integrity metadata and the commit marker for a completed export. It is deterministic and contains no wall-clock timestamp. A present, valid manifest describes one fully committed export invocation; it is not an editable project source file. The manifest records:

- `schemaVersion` and `compilerVersion`
- `hashAlgorithm: "sha256"`
- a canonical `sourceDigest`
- sorted source fingerprints for `deck.json`, slide HTML, notes, theme CSS/tokens, and referenced local assets
- sorted artifact fingerprints for the files actually written by that export invocation

Each fingerprint includes a POSIX project-relative `path`, `sizeBytes`, and lowercase SHA-256 digest. Artifact entries also include `kind` and a `slideId` for thumbnails. Cache thumbnails under `.htmlslide/cache/` are not export artifacts and are not recorded. These hashes detect accidental or ordinary local changes; they are integrity metadata, not digital signatures or proof of authorship.

## Export Transaction

The compiler must serialize exports for the same project with a project-level lock under `.htmlslide/cache/`. Lock creation is exclusive. A dead-owner lock is replaced atomically only by the exporter that acquires the old lock token's recovery claim, so concurrent recovery attempts cannot remove a new owner's lock. An export captures one source snapshot, and rendering, packaging, and source fingerprinting must use the same captured file handles and bytes. Verification reads may detect concurrent source changes, but bytes from different source generations must not be mixed into one committed invocation.

The compiler writes the complete invocation to a private staging directory under `.htmlslide/cache/`. Before changing `exports/`, it preflights every destination and refuses directories, symlinks, and untracked files that would be overwritten. Files owned by the previous valid manifest move into a private transaction backup; new artifacts then move into place and are verified. The compiler rechecks source fingerprints and atomically replaces `exports/export-manifest.json` last, so the new manifest is the commit marker for the new artifact generation. A failure before that marker restores the backup, removes files committed by the failed invocation, releases the lock, removes staging data, and does not publish a new manifest.

Partial exports replace the manifest with exactly the artifacts produced by that invocation. Before publishing the new commit marker, the compiler removes artifacts owned by the previous valid manifest that the new invocation omits. It must not remove untracked files merely because they are under `exports/`.

Static symlinks and symlinks introduced during file reads are rejected, and source reads bind validation and bytes to the same open file handle. HTMLslide assumes the project directory is controlled by the current user and does not claim to sandbox a separate malicious same-user process that continuously swaps parent directories during individual filesystem syscalls. Such a process already has the user's direct filesystem permissions; export untrusted projects only from a directory not being concurrently mutated by another process.

```json
{
  "schemaVersion": "0.1.0",
  "compilerVersion": "0.1.0",
  "hashAlgorithm": "sha256",
  "sourceDigest": "<64 lowercase hex characters>",
  "sources": [
    {
      "path": "deck.json",
      "sizeBytes": 1234,
      "sha256": "<64 lowercase hex characters>"
    }
  ],
  "artifacts": [
    {
      "path": "exports/example.pdf",
      "kind": "pdf",
      "sizeBytes": 5678,
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

## Standalone HTML

The HTML artifact is a complete document with:

- fixed `@page` and slide dimensions from `deck.json`
- inline runtime CSS from `@htmlslide/renderer`
- inline theme CSS
- slide fragments in manifest order
- embedded notes JSON in `#htmlslide-notes`
- keyboard navigation for standalone review
- a speaker notes panel that is hidden by default

Local slide and theme asset URLs are rewritten so an HTML file opened from `exports/` can resolve project-local assets without a dev server. For example, a slide reference to `../assets/accent.svg` becomes `../assets/accent.svg` in `exports/<deck-slug>.html`.

## Notes Sidecar

`exports/notes.json` uses this shape:

```json
{
  "schemaVersion": "0.1.0",
  "title": "Deck title",
  "language": "en-US",
  "slideCount": 1,
  "slides": [
    {
      "id": "001-title",
      "title": "Title slide",
      "index": 0,
      "pdfPage": 1,
      "source": "slides/001-title.html",
      "notesPath": "notes/001-title.md",
      "durationSec": 60,
      "hasNotes": true,
      "markdown": "# 001-title\n\nSpeaker notes."
    }
  ]
}
```

`slides[*].pdfPage` is one-based and must match the PDF page containing that slide.

## PDF Verification

PDF export currently uses the compiler fallback renderer. It writes one PDF page per slide and verifies the saved PDF page count with `pdf-lib` before returning success.

The compiler must fail export if the verified page count differs from `deck.json` slide count.

## PNG Thumbnails

The default thumbnail size is `960x540`. The compiler writes one PNG per slide id to both `exports/thumbnails/` and `.htmlslide/cache/thumbnails/`.

PNG files must have deterministic dimensions and bytes for the same input deck.

## deckpkg

`.deckpkg` files are ZIP archives with deterministic file metadata. They contain:

```text
manifest.json
deck.html
deck.pdf
notes.json
presenter-settings.json
assets/<referenced-local-asset>
thumbnails/<slide-id>.png
```

Package `deck.html` uses package-local URLs for copied local assets. For example, the same slide reference that becomes `../assets/accent.svg` in standalone HTML becomes `assets/accent.svg` inside `deck.html`, and `assets/accent.svg` is copied into the ZIP. Remote, absolute, fragment-only, and `data:` URLs are not copied into the package; they remain subject to checker warnings and release policy.

`manifest.json` uses this shape:

```json
{
  "schemaVersion": "0.1.0",
  "title": "Deck title",
  "language": "en-US",
  "viewport": { "width": 1920, "height": 1080 },
  "safeArea": { "top": 72, "right": 96, "bottom": 72, "left": 96 },
  "pdf": "deck.pdf",
  "html": "deck.html",
  "notes": "notes.json",
  "presenterSettings": "presenter-settings.json",
  "thumbnailSize": { "width": 960, "height": 540 },
  "slideCount": 1,
  "pageCount": 1,
  "slides": [
    {
      "id": "001-title",
      "title": "Title slide",
      "index": 0,
      "pdfPage": 1,
      "source": "slides/001-title.html",
      "thumbnail": "thumbnails/001-title.png",
      "notes": "notes/001-title.md",
      "durationSec": 60
    }
  ]
}
```

`slides[*].pdfPage` is one-based. `slides[*].thumbnail` must point to a file inside the same deck package.
