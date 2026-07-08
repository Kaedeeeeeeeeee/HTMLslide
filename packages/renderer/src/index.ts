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
.htmlslide-page [data-safe-area] {
  position: absolute;
  inset: var(--htmlslide-safe-top) var(--htmlslide-safe-right) var(--htmlslide-safe-bottom) var(--htmlslide-safe-left);
}
@page {
  size: ${deck.viewport.width}px ${deck.viewport.height}px;
  margin: 0;
}
@media print {
  html, body { background: white; }
  .htmlslide-deck { display: block; padding: 0; }
  .htmlslide-page { box-shadow: none; break-after: page; page-break-after: always; }
}
`;
};

export const buildDeckHtml = (deck: RenderDeck, mode: RenderMode = "preview"): string => {
  const slideMarkup = deck.slides
    .map(
      (slide, index) => `<article class="htmlslide-page" data-slide-id="${escapeHtml(slide.id)}" data-slide-index="${index}">
${slide.html}
</article>`
    )
    .join("\n");

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
  <body data-htmlslide-mode="${mode}">
    <main class="htmlslide-deck" aria-label="${escapeHtml(deck.title)}">
${slideMarkup}
    </main>
    <script type="application/json" id="htmlslide-notes">${notesScript}</script>
  </body>
</html>`;
};

