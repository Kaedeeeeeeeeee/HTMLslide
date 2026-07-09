# Presenter Mode

Presenter Mode opens a deck for rehearsal or live presentation.

## Rehearsal

Rehearsal mode runs in one window and shows current slide, next slide, speaker notes, timer, progress, and keyboard controls.

Before a first presentation, test keyboard next/previous navigation plus black screen and white screen controls. Confirm notes are readable at the chosen display size and the timer matches the expected duration.

## Audience window

The desktop app can open a no-chrome Audience window and sync navigation, black screen, and white screen state from the presenter session.

Use the Audience window for a dry run before relying on a projector. If the window does not open or stops syncing, fall back to single-screen rehearsal and include presenter diagnostics in the bug report.

## Dual-screen

Physical dual-screen behavior still needs manual validation for each release candidate. Automated Electron E2E covers window creation and sync, but it does not prove HDMI, USB-C, AirPlay, screen swap, or disconnect/reconnect behavior.

For live use, manually validate the exact dual-screen setup, including cable or AirPlay path, display order, screen swap, and reconnect behavior.

## deckpkg

Standalone `.deckpkg` files can open directly into Presenter Mode. Package-backed sessions extract each slide from `deck.html` and render the current Presenter and Audience view from the package HTML, with validated PNG thumbnails retained as a fallback. Local image/font assets referenced by the exported HTML are still a release-readiness check until package asset embedding is complete.
