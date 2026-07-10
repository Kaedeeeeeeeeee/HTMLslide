# Canonical Desktop Preview Design

## Decision

Desktop Preview will render a compiler-built, single-slide HTML document inside an iframe with an empty `sandbox` attribute. The document is produced from the same core project loader, source snapshots, URL resolver, theme CSS, and renderer document emitter used by export. Local assets are converted to `data:` URLs, while a deny-by-default Content Security Policy blocks scripts, network access, nested frames, workers, objects, forms, and external styles. The iframe itself is non-interactive and has no origin privileges.

Preview remains an audit canvas, not an editor. Source HTML must never be inserted into the privileged React document. The renderer process receives only display metadata and the isolated document string. The existing synthetic preview remains available only for built-in sample state where no local project exists.

## Alternatives

Three approaches were evaluated:

1. **Self-contained `srcdoc` iframe (selected).** It is deterministic, offline, easy to package, and has no project file server. Its cost is base64 expansion, controlled by loading one selected slide at a time and caching only the current project revision.
2. **Token-scoped custom Electron protocol.** It avoids base64 expansion and scales better for very large media, but adds protocol registration, token lifetime, MIME serving, canonical-path checks, and a new attack surface. This is a later optimization if measured preview payloads require it.
3. **Dedicated WebContentsView/BrowserWindow.** It offers process-level isolation but complicates layout, focus, accessibility, screenshots, and presenter coordination. It is disproportionate for a non-interactive review canvas.

## Architecture

`@htmlslide/renderer` remains a pure document emitter. It gains an explicit single-slide preview builder and preview CSP contract, with runtime scripts and notes disabled by default. `@htmlslide/compiler` gains a read-only `buildSlidePreviewDocument(inputPath, { slideId })` API. That API wraps the existing double-read deck snapshot, source fingerprinting, theme preparation, and asset resolution pipeline; it does not acquire the export lock, create staging directories, or write `exports/`.

The compiler URL rewriter is generalized around one project-relative asset resolver with three serializers: export-relative, package-relative, and inline-preview. This prevents preview from becoming a third interpretation of source paths. Inline preview assets retain SVG fragments and receive deterministic MIME-qualified data URLs. Remote and absolute URLs remain unresolved and are blocked by CSP.

Electron desktop services expose a narrow `load-slide-preview` IPC operation returning project root, slide id, source path, viewport, source digest, and `htmlDocument`. The preload bridge validates only serializable request data. The React workspace lazily requests the selected slide, ignores stale responses, caches by project/slide revision, and uses a ResizeObserver to fit the fixed manifest viewport without hard-coded `1920x1080` scale values.

## Security And Errors

The preview document CSP is:

```text
default-src 'none'; img-src data:; media-src data:; font-src data:;
style-src 'unsafe-inline'; script-src 'none'; connect-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none';
form-action 'none'; base-uri 'none'
```

The host iframe uses `sandbox=""`, `referrerPolicy="no-referrer"`, no permissions, and `pointer-events: none`. Project scripts, event handlers, `javascript:` URLs, network fetches, popups, forms, and parent DOM access therefore have no execution path. The privileged workspace contains no `dangerouslySetInnerHTML` fallback.

Compiler failures are returned as stable preview errors without replacing the active project. The canvas shows a `role="alert"` with the source path and actionable retry guidance; filmstrip, Inspector, command bar, and settings remain usable. Request ids ensure a slow previous slide cannot overwrite a newer selection. Empty source is a valid rendered blank slide, not a synthetic success state.

## Verification

Unit coverage must prove theme and local asset parity, inline `img`, `srcset`, CSS `url()`, SVG fragments, deterministic source digests, unknown slide rejection, no filesystem writes, and no unresolved local URLs. Renderer tests must prove single-slide output, CSP, absence of runtime scripts/notes, and fixed viewport markup.

Desktop service tests must prove the renderer receives `htmlDocument` rather than raw HTML. Electron tests must select the second slide, verify iframe title/content/theme/image load, exercise minimum and default windows, and assert no project script can mutate the parent sentinel or call the preload bridge. A hostile fixture must also point at a local HTTP counter and produce zero requests during preview. Accessibility coverage must include the iframe title, current filmstrip state, loading status, and error alert rather than excluding the preview subtree.

Compiler browser visual regression will compare the canonical preview document with the corresponding export page using the existing Chromium threshold. Full lint, typecheck, unit, Electron, accessibility, package smoke, security, and GitHub CI/Alpha workflows remain required before the milestone is accepted.
