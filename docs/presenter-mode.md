# Presenter Mode

Presenter Mode opens a deck for rehearsal or live presentation.

## Rehearsal

Rehearsal mode runs in one window and shows current slide, next slide, speaker notes, timer, progress, and keyboard controls.

## Audience window

The desktop app can open a no-chrome Audience window and sync navigation, black screen, and white screen state from the presenter session.

## Dual-screen

Physical dual-screen behavior still needs manual validation for each release candidate. Automated Electron E2E covers window creation and sync, but it does not prove HDMI, USB-C, AirPlay, screen swap, or disconnect/reconnect behavior.

## deckpkg

Standalone `.deckpkg` files can open directly into Presenter Mode. Package-only sessions render validated PNG thumbnails in Presenter and Audience windows; full package HTML/PDF page rendering still needs hardening before claiming final presentation parity.
