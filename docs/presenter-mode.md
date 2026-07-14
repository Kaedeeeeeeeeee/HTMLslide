# Presenter Mode

Presenter Mode opens a deck for rehearsal or live presentation.

## Rehearsal

Rehearsal mode runs in one window and shows current slide, next slide, speaker notes, timer, progress, and keyboard controls.

Before a first presentation, test keyboard next/previous navigation plus black screen and white screen controls. Confirm notes are readable at the chosen display size and the timer matches the expected duration.

## Audience window

The desktop app can open a no-chrome Audience window and sync navigation, black screen, and white screen state from the presenter session.

Presenter Console includes slide search by title, slide ID, or number. Filter the list, then select a result to jump without leaving the rehearsal view.

When more than one display is detected, Presenter opens Audience once on the preferred external/non-primary display. With
one display, it stays in rehearsal mode. The `Open audience` control remains available to retry after a failed automatic
open or to reopen a window that was closed manually.

Audience navigation and display-reconnect loads use latest-wins lifecycle handling. Closing Presenter closes its Audience
window and cancels stale in-flight loads; a reconnect load failure is surfaced as a retryable Presenter error.

Use the Audience window for a dry run before relying on a projector. If the window does not open or stops syncing, fall back to single-screen rehearsal and include presenter diagnostics in the bug report.

## Dual-screen

Physical dual-screen behavior still needs manual validation for each release candidate. Automated Electron E2E covers window creation and sync, but it does not prove HDMI, USB-C, AirPlay, screen swap, or disconnect/reconnect behavior.

For live use, manually validate the exact dual-screen setup, including cable or AirPlay path, display order, screen swap, and reconnect behavior.

## deckpkg

Standalone `.deckpkg` files can open directly into Presenter Mode. Package-backed sessions extract each slide from `deck.html` and render the current Presenter and Audience view from the package HTML, with package-local assets inlined for the sandboxed preview and validated PNG thumbnails retained as a fallback.
