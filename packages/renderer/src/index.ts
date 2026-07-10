export type RenderSlide = {
  id: string;
  title: string;
  html: string;
  notes?: string;
};

export type RenderDeck = {
  title: string;
  language?: string;
  viewport: {
    width: number;
    height: number;
  };
  safeArea?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  themeCss?: string;
  slides: RenderSlide[];
};

export type RenderMode = "preview" | "print" | "present";

export type BuildDeckHtmlOptions = {
  mode?: RenderMode;
  includeRuntimeScript?: boolean;
  includeNotesPanel?: boolean;
};

export type BuildSlidePreviewDocumentInput = Omit<RenderDeck, "slides"> & {
  slide: RenderSlide;
};

export const PREVIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; " +
  "style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; " +
  "object-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const baseRuntimeCss = (deck: Pick<RenderDeck, "viewport" | "safeArea">): string => {
  const safe = deck.safeArea ?? { top: 72, right: 96, bottom: 72, left: 96 };
  return `
:root {
  --htmlslide-width: ${deck.viewport.width}px;
  --htmlslide-height: ${deck.viewport.height}px;
  --htmlslide-aspect-ratio: ${deck.viewport.width} / ${deck.viewport.height};
  --htmlslide-safe-top: ${safe.top}px;
  --htmlslide-safe-right: ${safe.right}px;
  --htmlslide-safe-bottom: ${safe.bottom}px;
  --htmlslide-safe-left: ${safe.left}px;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: #f4f5f7; color: #15171c; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.htmlslide-deck { display: grid; gap: 32px; padding: 32px; }
.htmlslide-page {
  width: var(--htmlslide-width);
  height: var(--htmlslide-height);
  overflow: hidden;
  position: relative;
  background: white;
  color: #15171c;
  box-shadow: 0 24px 80px rgba(20, 24, 33, 0.18);
}
.htmlslide-page > .slide {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}
.htmlslide-page[aria-current="true"] {
  outline: 3px solid #2563eb;
  outline-offset: 6px;
}
.htmlslide-page [data-safe-area] {
  position: absolute;
  inset: var(--htmlslide-safe-top) var(--htmlslide-safe-right) var(--htmlslide-safe-bottom) var(--htmlslide-safe-left);
}
.htmlslide-notes-panel {
  display: none;
  position: fixed;
  z-index: 20;
  right: 24px;
  bottom: 24px;
  width: min(520px, calc(100vw - 48px));
  max-height: min(520px, calc(100vh - 48px));
  overflow: auto;
  padding: 20px;
  background: rgba(17, 24, 39, 0.94);
  color: #f8fafc;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 18px 80px rgba(0, 0, 0, 0.34);
}
.htmlslide-notes-panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
  line-height: 1.3;
}
.htmlslide-notes-panel pre {
  margin: 0;
  white-space: pre-wrap;
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
body[data-htmlslide-notes="open"] .htmlslide-notes-panel {
  display: block;
}
body[data-htmlslide-mode="present"] {
  overflow: hidden;
  background: #0f172a;
}
body[data-htmlslide-mode="present"] .htmlslide-deck {
  display: block;
  width: 100vw;
  height: 100vh;
  padding: 0;
  overflow: hidden;
}
body[data-htmlslide-mode="present"] .htmlslide-page {
  display: none;
  width: min(100vw, ${(deck.viewport.width / deck.viewport.height) * 100}vh);
  aspect-ratio: var(--htmlslide-aspect-ratio);
  margin: auto;
  box-shadow: none;
}
body[data-htmlslide-mode="present"] .htmlslide-page[aria-current="true"] {
  display: block;
  outline: none;
}
@page {
  size: ${deck.viewport.width}px ${deck.viewport.height}px;
  margin: 0;
}
@media print {
  html, body { background: white; }
  .htmlslide-deck { display: block; padding: 0; }
  .htmlslide-page { box-shadow: none; outline: none; break-after: page; page-break-after: always; }
  .htmlslide-notes-panel { display: none !important; }
}
`;
};

const previewRuntimeCss = (): string => `
html,
body {
  width: var(--htmlslide-width);
  height: var(--htmlslide-height);
  min-width: var(--htmlslide-width);
  min-height: var(--htmlslide-height);
  overflow: hidden;
  background: transparent;
}
body[data-htmlslide-preview="canonical"] .htmlslide-deck {
  display: block;
  width: var(--htmlslide-width);
  height: var(--htmlslide-height);
  padding: 0;
  gap: 0;
}
body[data-htmlslide-preview="canonical"] .htmlslide-page {
  width: var(--htmlslide-width);
  height: var(--htmlslide-height);
  margin: 0;
  box-shadow: none;
}
body[data-htmlslide-preview="canonical"] .htmlslide-page[aria-current="true"] {
  outline: none;
}
`;

const buildSlideMarkup = (slide: RenderSlide, index: number): string =>
  `<article class="htmlslide-page" data-slide-id="${escapeHtml(slide.id)}" data-slide-index="${index}" data-slide-title="${escapeHtml(slide.title)}" aria-current="${index === 0 ? "true" : "false"}" tabindex="-1">
${slide.html}
</article>`;

const resolveBuildOptions = (modeOrOptions: RenderMode | BuildDeckHtmlOptions): Required<BuildDeckHtmlOptions> => {
  if (typeof modeOrOptions === "string") {
    return {
      mode: modeOrOptions,
      includeRuntimeScript: modeOrOptions !== "print",
      includeNotesPanel: modeOrOptions !== "print"
    };
  }

  return {
    mode: modeOrOptions.mode ?? "preview",
    includeRuntimeScript: modeOrOptions.includeRuntimeScript ?? modeOrOptions.mode !== "print",
    includeNotesPanel: modeOrOptions.includeNotesPanel ?? modeOrOptions.mode !== "print"
  };
};

const buildRuntimeScript = (): string => `<script>
(() => {
  const pages = Array.from(document.querySelectorAll(".htmlslide-page"));
  const notes = Array.from(document.querySelectorAll("[data-notes-slide-id]"));
  const findIndexFromHash = () => {
    const id = decodeURIComponent(window.location.hash.replace(/^#\\/?/, ""));
    return Math.max(0, pages.findIndex((page) => page.getAttribute("data-slide-id") === id));
  };
  let currentIndex = findIndexFromHash();
  const setCurrent = (nextIndex) => {
    if (pages.length === 0) return;
    currentIndex = Math.min(Math.max(nextIndex, 0), pages.length - 1);
    for (const [index, page] of pages.entries()) {
      const isCurrent = index === currentIndex;
      page.setAttribute("aria-current", isCurrent ? "true" : "false");
      if (isCurrent) {
        document.body.dataset.htmlslideCurrentSlide = page.getAttribute("data-slide-id") || "";
      }
    }
    for (const note of notes) {
      note.hidden = note.getAttribute("data-notes-slide-id") !== document.body.dataset.htmlslideCurrentSlide;
    }
    const currentPage = pages[currentIndex];
    const slideId = currentPage ? currentPage.getAttribute("data-slide-id") : "";
    if (slideId && window.location.hash !== "#" + encodeURIComponent(slideId)) {
      history.replaceState(null, "", "#" + encodeURIComponent(slideId));
    }
    if (currentPage && document.body.dataset.htmlslideMode !== "present") {
      currentPage.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  const isTextInput = (target) => target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextInput(event.target)) return;
    if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      setCurrent(currentIndex + 1);
    } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      setCurrent(currentIndex - 1);
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      document.body.dataset.htmlslideNotes = document.body.dataset.htmlslideNotes === "open" ? "closed" : "open";
    } else if (event.key === "Home") {
      event.preventDefault();
      setCurrent(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setCurrent(pages.length - 1);
    }
  });
  window.addEventListener("hashchange", () => setCurrent(findIndexFromHash()));
  setCurrent(currentIndex);
})();
</script>`;

const buildNotesPanel = (deck: RenderDeck): string => {
  const noteArticles = deck.slides
    .map(
      (slide, index) => `<article data-notes-slide-id="${escapeHtml(slide.id)}"${index === 0 ? "" : " hidden"}>
  <h2>${escapeHtml(slide.title)}</h2>
  <pre>${escapeHtml(slide.notes ?? "")}</pre>
</article>`
    )
    .join("\n");

  return `<aside class="htmlslide-notes-panel" aria-label="Speaker notes">
${noteArticles}
</aside>`;
};

export const buildDeckHtml = (
  deck: RenderDeck,
  modeOrOptions: RenderMode | BuildDeckHtmlOptions = "preview"
): string => {
  const options = resolveBuildOptions(modeOrOptions);
  const slideMarkup = deck.slides.map(buildSlideMarkup).join("\n");

  const notesScript = JSON.stringify(
    deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      notes: slide.notes ?? ""
    }))
  ).replaceAll("</", "<\\/");

  return `<!doctype html>
<html lang="${escapeHtml(deck.language ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(deck.title)}</title>
    <style>${baseRuntimeCss(deck)}</style>
    <style>${deck.themeCss ?? ""}</style>
  </head>
  <body data-htmlslide-mode="${options.mode}" data-htmlslide-notes="closed">
    <main class="htmlslide-deck" aria-label="${escapeHtml(deck.title)}">
${slideMarkup}
    </main>
    <script type="application/json" id="htmlslide-notes">${notesScript}</script>
    ${options.includeNotesPanel ? buildNotesPanel(deck) : ""}
    ${options.includeRuntimeScript ? buildRuntimeScript() : ""}
  </body>
</html>`;
};

export const buildSlidePreviewDocument = ({
  slide,
  title,
  language,
  viewport,
  safeArea,
  themeCss
}: BuildSlidePreviewDocumentInput): string => {
  const previewDeck: RenderDeck = {
    title,
    language,
    viewport,
    safeArea,
    themeCss,
    slides: [slide]
  };

  return `<!doctype html>
<html lang="${escapeHtml(language ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}" />
    <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${baseRuntimeCss(previewDeck)}</style>
    <style>${themeCss ?? ""}</style>
    <style>${previewRuntimeCss()}</style>
  </head>
  <body data-htmlslide-mode="preview" data-htmlslide-preview="canonical" data-htmlslide-viewport-width="${viewport.width}" data-htmlslide-viewport-height="${viewport.height}">
    <main class="htmlslide-deck" aria-label="${escapeHtml(title)}">
${buildSlideMarkup(slide, 0)}
    </main>
  </body>
</html>`;
};
