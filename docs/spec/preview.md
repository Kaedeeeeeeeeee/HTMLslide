# Preview Spec v0.1

HTMLslide Preview is a non-editable review canvas for one project slide. It must use the same project snapshot, theme CSS, source fragment, asset resolution, viewport, and renderer document structure as export.

## Shared Builder

The compiler owns project-backed preview preparation. A preview request identifies a loadable project path and a manifest slide id. The result contains:

- canonical project root;
- slide id, title, and source path;
- manifest viewport;
- speaker notes;
- deterministic source digest;
- a complete single-slide HTML document.

Preview preparation is read-only. It must not acquire the export lock, create `.htmlslide/` state, write `exports/`, or reuse an existing export artifact as its source of truth.

Local HTML and CSS asset references use the compiler's common project-relative resolver. Preview serializes referenced local assets as MIME-qualified `data:` URLs. Export and deckpkg serialization continue to use their own relative URL targets from the same resolver.

## Isolation

The desktop renderer must never insert project-authored HTML into the App document. It renders the compiler document in an iframe with:

- `sandbox=""`;
- `referrerPolicy="no-referrer"`;
- no iframe permissions;
- no pointer interaction;
- a title naming the slide.

The generated document carries a deny-by-default Content Security Policy. Scripts, connections, nested frames, workers, objects, form submission, base URL changes, and external navigation are denied. Styles are inline-only; images, media, and fonts are limited to compiler-generated `data:` URLs.

## Desktop Behavior

The desktop app loads the selected slide preview lazily. A monotonic request id prevents an older response from replacing a newer filmstrip selection. Cache entries are scoped to the current project snapshot and invalidated when refreshed project slides replace that snapshot.

The fixed manifest viewport is scaled to fit the available canvas using measured container dimensions. No hard-coded `1920x1080` scale factor is allowed, even though schema v0.1 currently requires a 16:9 viewport.

Loading is exposed as status text. A build failure remains inside the canvas as a `role="alert"` with the source path and retry guidance; it must not close the project or disable the surrounding workspace.

Built-in sample state may use a synthetic React preview because it contains no project-authored HTML. Local project previews and rehearsal fallbacks must use the isolated compiler document or a metadata-only fallback.
