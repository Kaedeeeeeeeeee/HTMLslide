# Getting Started

HTMLslide has three alpha usage paths: No AI, Local Mock, and BYOK/provider-backed generation.

## No AI Path

Use No AI when you want to inspect, check, export, or present an existing deck without model credentials.

1. Open `HTMLslide.app`.
2. Continue without AI.
3. Open a project folder containing `deck.json`.
4. Run Check.
5. Export PDF, HTML, thumbnails, notes JSON, or deckpkg.
6. Open Presenter Mode.

No AI does not generate new content, but it should keep the app useful for review, QA, export, and rehearsal.

## Local Mock Path

Local Mock creates deterministic decks for testing the product flow without credentials. It is the safest path for CI and smoke testing.

1. Click New Deck.
2. Choose Local Mock.
3. Enter a title and brief.
4. Generate.
5. Review Check, Export, and Presenter output.

For a complete first presentation walkthrough from brief to rehearsal, see [First Presentation Walkthrough](examples/first-presentation.md).

## BYOK Path

BYOK uses your own provider account. See [BYOK](byok.md). You pay your provider directly.

## Export

After a deck passes Check, use [Exporting](exporting.md) to create PDF, deckpkg, thumbnails, and `notes.json`.
