# Export Spec v0.1

HTMLslide exports are compiler-owned artifacts under `exports/`. The compiler must not require a dev server to open exported HTML or read packaged presenter artifacts.

## Artifact Set

For the default export path, the compiler writes:

- `exports/<deck-slug>.html`
- `exports/<deck-slug>.pdf`
- `exports/<deck-slug>.deckpkg`
- `exports/notes.json`
- `exports/thumbnails/<slide-id>.png`
- `.htmlslide/cache/thumbnails/<slide-id>.png`

Generated filenames are deterministic for the same deck title and slide ids.

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
