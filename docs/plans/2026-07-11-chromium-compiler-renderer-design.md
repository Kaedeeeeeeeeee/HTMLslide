# Chromium Compiler Renderer Design

## Status

Approved for Phase 2 implementation.

## Problem

The compiler currently creates deterministic placeholder PDFs with `pdf-lib` and synthetic color-block PNG thumbnails. Those artifacts prove the export transaction, but they do not render the authored slide HTML. Phase 2 requires the exported PDF, thumbnails, standalone HTML, preview, and deck package to share the same Chromium-rendered source.

## Decisions

1. `@htmlslide/compiler` owns one headless Chromium renderer backed by `playwright-core`.
2. The compiler materializes an isolated render workspace under the existing export staging root. It contains a print-only HTML document plus the exact fingerprinted assets already selected for the deck package.
3. Page JavaScript is disabled and network protocols are blocked. The renderer only reads the staged local document and staged local assets.
4. Rendering waits for `document.fonts.ready`, successful image decoding, and stable layout before producing artifacts.
5. One browser session produces both the PDF and per-slide thumbnails. The PDF uses Chromium print output with printed backgrounds and CSS page size. Thumbnails are screenshots of the same DOM at the requested output dimensions.
6. Chromium PDF metadata is normalized with `pdf-lib` so repeated exports remain byte-stable for the same browser build and source inputs.
7. PDF and thumbnail bytes remain inside the existing atomic export transaction. Source fingerprint verification still runs before commit, and failed rendering publishes no partial artifacts.
8. The CLI uses a locally installed Playwright Chromium during development. Packaged macOS builds include a private Chromium runtime and pass its executable path to the packaged CLI. No network download is allowed at export time.
9. The synthetic PDF and thumbnail implementations are removed after the Chromium path is covered. There is no silent visual fallback: an unavailable browser is an actionable export failure.

## Compiler Flow

1. Load and fingerprint the project.
2. Rewrite source URLs for a package-like local root.
3. Write the print document and referenced assets to `render-runtime/` inside export staging.
4. Launch the resolved Chromium executable with a constrained browser context.
5. Render the PDF and thumbnails.
6. Verify PDF page count and PNG dimensions.
7. Stage HTML, PDF, thumbnails, notes, deck package, and export manifest.
8. Recheck source fingerprints and atomically commit the exact artifact set.

## Runtime Resolution

The renderer resolves Chromium in this order:

1. Explicit compiler option for tests and host integration.
2. `HTMLSLIDE_CHROMIUM_EXECUTABLE`.
3. Playwright's installed Chromium executable.

The macOS packager copies the tested Playwright Chromium headless-shell runtime into the private CLI runtime and records the stable executable path. It signs the shell and its dynamic libraries before signing the outer application. The desktop CLI runner and installed shim set `HTMLSLIDE_CHROMIUM_EXECUTABLE` when they target a packaged app.

## Verification

- PDF exists and its page count equals the slide count.
- Every thumbnail is a real DOM screenshot with exact dimensions.
- Browser output matches committed visual goldens within the documented thresholds.
- Repeated exports have stable hashes for a pinned Chromium build.
- Slide scripts cannot execute and remote requests cannot leave the renderer.
- Missing browser, missing assets, failed images, console errors, and unknown slides fail without committing artifacts.
- CLI export, Electron export, deck package creation, and the packaged app smoke test all exercise the Chromium path.
