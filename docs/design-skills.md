# Design Skills

Design Skills guide visual direction while preserving HTMLslide constraints.

## Fixed canvas

Decks use a fixed 1920x1080 canvas. Slides should not rely on responsive reflow for the final artifact.

## Built-in directions

- `swiss-editorial`: restrained editorial typography and strong grid logic.
- `consulting-clean`: conclusion-led business slides, matrices, and comparisons.
- `technical-dark`: technical architecture, code, and developer content.
- `product-launch`: product announcement flow.
- `data-report`: metric hierarchy and insight-led reports.

Design skills should improve source files, speaker notes, and theme constraints without editing `exports/`.

The same ids are also available as built-in deck templates for `htmlslide new --template <id>` and the desktop Templates library. Deck templates create starter source files; design skills guide agents when revising existing decks.
