# Deck Spec v0.1

HTMLslide decks use `deck.json` as the project manifest. Version `0.1.0` defines a fixed-canvas slide deck whose editable source lives in project files and whose exports are compiler-owned artifacts.

## Required Fields

- `schemaVersion`: must be `"0.1.0"`.
- `id`: stable project id, using letters, numbers, `_`, or `-`.
- `title`: display title.
- `language`: BCP-47-like language tag such as `en-US`, `zh-CN`, or `ja-JP`.
- `aspectRatio`: currently `"16:9"`.
- `viewport`: fixed canvas dimensions. For `"16:9"`, `width * 9` must equal `height * 16`.
- `slides`: one or more slide entries.

## Optional Fields

- `appVersion`: app version that last wrote the manifest.
- `safeArea`: non-negative `top`, `right`, `bottom`, and `left` values. Horizontal and vertical totals must fit inside `viewport`.
- `theme`: optional project-local `css` and/or `tokens` references.
- `speakerNotesMode`: optional `none`, `bullet-notes`, `full-script`, or `rehearsal-cues` value recorded by New Deck and deterministic agent runs. When it is `none`, slides omit `notes` paths.
- `export`: the project's default output profile, with booleans for `pdf`, `html`, `deckpkg`, `thumbnails`, and `speakerNotes`. The desktop New Deck wizard writes its selected profile here; later GUI and CLI exports read it when no per-invocation choice is supplied.
- `agent`: optional `preferredEngine` and `lastRunId` metadata.

## Slide Entries

Each slide has:

- `id`: stable slide id, unique within the deck.
- `title`: human-readable title.
- `source`: project-relative HTML fragment path.
- `notes`: optional project-relative Markdown notes path.
- `durationSec`: optional positive integer timing estimate.
- `kind`: defaults to `content`; allowed values are `title`, `section`, `content`, `data`, `image`, `quote`, `closing`, `appendix`, and `custom`.
- `status`: defaults to `draft`; allowed values are `draft`, `ready`, and `final`.

## Path Rules

Manifest paths are POSIX-style project-relative paths. They must not be absolute, use backslashes, include URL schemes, contain `.`, `..`, or empty path segments, or point into `exports/`.

File existence is validated by the project loader, not by pure schema validation.

## Deck Package Safety

`.deckpkg` files are untrusted ZIP inputs. Before presenter assets are expanded, the shared presenter reader enforces these public-alpha limits:

- archive bytes: 128 MiB;
- archive entries: 4,096;
- uncompressed bytes per entry: 64 MiB;
- total declared uncompressed bytes: 256 MiB.

Before JSZip materializes package files, a bounded preflight compares central and local ZIP metadata, streams actual STORE/DEFLATE expansion through the per-entry and total limits, and verifies each entry's CRC32 against its expanded content. Encrypted, ZIP64, multi-disk, data-descriptor, unsupported-compression, overlapping-path, inconsistent-size, CRC-mismatched, and over-limit archives fail with structured validation issues. The desktop App and `htmlslide present` use the same reader and limits.

## Issue Contract

Core helpers expose issues with:

- `severity`: `error`, `warning`, or `info`.
- `type`: stable machine-readable issue type.
- `message`: human-readable description.
- `path`, `slideId`, `selector`, and `suggestedFix`: optional details.

Issue summaries use the CLI-compatible shape:

```json
{
  "errors": 1,
  "warnings": 2,
  "info": 4
}
```
