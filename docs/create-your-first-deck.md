# Create Your First Deck

This alpha flow uses Local Mock so it can run without credentials.

For a more detailed example with a concrete brief, Check commands, export artifacts, rehearsal checks, and bug-report diagnostics, see [First Presentation Walkthrough](examples/first-presentation.md).

## Steps

1. Open HTMLslide.
2. Click New Deck.
3. Set a title, folder name, audience, duration, slide count, tone, and design direction.
4. Add local source files or paste reference text when the deck needs source material.
5. Choose Local Mock.
6. Click Create and Generate.
7. Inspect the generated outline, visual direction, and source changes.
8. Run Check.
9. Select the export formats you need, then click Export. Notes JSON remains available with the project export.
10. Open Presenter Mode.

## Source Files

Generated source lives in normal project files:

- `deck.json`
- `slides/*.html`
- `notes/*.md`
- `theme/*`
- `assets/sources/*` for staged reference material and its `index.json` digest manifest
- `.htmlslide/reports/*`

Generated exports live under `exports/` and should not be edited manually.
