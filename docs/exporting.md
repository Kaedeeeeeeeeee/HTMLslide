# Exporting

Export uses the shared compiler path.

## Artifacts

- PDF
- HTML
- deckpkg
- thumbnails
- `notes.json`

## Flow

1. Run Check.
2. Fix blocking errors.
3. Export.
4. Confirm PDF page count, thumbnail count, and deckpkg open behavior.
5. Present or share the generated artifacts.

`exports/` is generated output. Source changes should happen in `deck.json`, `slides/`, `notes/`, `theme/`, or `assets/`.

## First Presentation Checks

For a first presentation walkthrough, export PDF, deckpkg, thumbnails, and `notes.json` together. Confirm:

- PDF page count matches the slide count in `deck.json`.
- Thumbnail count matches the slide count.
- deckpkg open behavior reaches Presenter Mode.
- `exports/notes.json` exists when speaker notes are expected.

If export failed, run Check again and fix blocking errors before re-exporting.
