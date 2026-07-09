# First Presentation Walkthrough

This example walks through a credential-free alpha path from a blank workspace to a rehearsable deck. It uses Local Mock so the flow is deterministic and does not require provider keys, Claude Code, Codex, Gemini CLI, or network model access.

Use it when you want to prove the product loop before trying BYOK or an external agent.

## Starting Brief

Use a small, concrete brief:

```text
Title: Quarterly product review
Audience: Product leadership
Duration: 10 minutes
Slide count: 5
Tone: concise, evidence-led, executive
Design direction: clean data report
Goal: explain what changed this quarter, what is working, and what decision is needed next.
```

## Create The Deck

1. Open `HTMLslide.app`.
2. Choose or create a workspace.
3. Click New Deck.
4. Enter the title, audience, duration, slide count, tone, and design direction from the brief.
5. Choose Local Mock.
6. Click Create and Generate.

Expected source files:

- `deck.json`
- `slides/*.html`
- `notes/*.md`
- `theme/*`
- `.htmlslide/reports/*`

Do not edit `exports/`; it is generated output.

## Review The Generated Plan

Before exporting, inspect the generated outline and source changes:

- Slide titles should read like claims, not placeholders.
- Each slide should have one clear job: context, evidence, implication, decision, or close.
- Speaker notes should explain what to say, not duplicate all visible text.
- Theme and slide files should stay inside the project source areas.

If the story is unclear, edit `deck.json`, `slides/`, `notes/`, or `theme/` before exporting.

## Run Check

Use the desktop Check button first. If the CLI shim is installed, you can also run:

```bash
htmlslide check /path/to/quarterly-product-review --json
```

Treat errors as blocking. Common alpha issues are missing local assets, invalid manifest paths, remote assets, unreadable contrast, text overflow, and missing speaker notes.

## Export PDF And deckpkg

After Check passes, export PDF, deckpkg, thumbnails, and notes from the app or run:

```bash
htmlslide export /path/to/quarterly-product-review --pdf --deckpkg --thumbnails --json
```

Expected generated artifacts:

- `exports/*.pdf`
- `exports/*.deckpkg`
- `exports/thumbnails/*`
- `exports/notes.json`

Open the PDF and confirm the PDF page count matches the deck. Confirm the thumbnail count matches the slide count. Re-open the `.deckpkg` in HTMLslide to confirm deckpkg open behavior reaches Presenter Mode.

## Rehearsal In Presenter Mode

Open Presenter Mode and verify:

- The current slide is visible.
- The next slide preview is useful.
- Speaker notes are readable.
- The timer and progress indicators make sense for the target duration.
- Keyboard navigation, next, previous, black screen, and white screen controls respond.
- The Audience window opens when needed and follows presenter navigation.

Physical dual-screen output still needs manual validation for release candidates. The alpha E2E suite verifies window creation and sync, but it does not prove HDMI, USB-C, AirPlay, screen swap, or disconnect/reconnect behavior.

## If Something Fails

Keep the report sanitized and local-first. Do not paste API keys, provider tokens, private deck content, personal data, or customer material into public issues.

Useful diagnostics:

```bash
htmlslide doctor --json
htmlslide check /path/to/quarterly-product-review --json
```

For a useful bug report, include:

- App version or commit.
- Platform and macOS version.
- Whether the deck was created with Local Mock, BYOK, or an external agent.
- The smallest sanitized deck fixture that reproduces the issue.
- Expected behavior and actual behavior.
- The `htmlslide check --json` summary and any relevant screenshots or visual diffs.

## Done Criteria

The example is complete when:

- Check passes or every remaining issue has a clear owner.
- PDF, deckpkg, thumbnails, and `notes.json` export.
- The deckpkg opens in Presenter Mode.
- A speaker can rehearse the 10-minute story using the notes and timer.
