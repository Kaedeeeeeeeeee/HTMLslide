import { describe, expect, it } from "vitest";
import {
  buildDeckHtml,
  buildSlidePreviewDocument,
  PREVIEW_CONTENT_SECURITY_POLICY,
  type RenderDeck
} from "../src/index";

const deck: RenderDeck = {
  title: "Renderer <Export>",
  language: "en-US",
  viewport: {
    width: 1920,
    height: 1080
  },
  slides: [
    {
      id: "001-title",
      title: "Title & Notes",
      html: '<section class="slide" data-slide-id="001-title"><h1>Hello</h1></section>',
      notes: "Use arrow keys and keep notes hidden by default."
    }
  ]
};
const slide = deck.slides[0]!;

describe("buildDeckHtml", () => {
  it("emits escaped standalone runtime HTML with notes data and keyboard controls", () => {
    const html = buildDeckHtml(deck, {
      mode: "print",
      includeRuntimeScript: true,
      includeNotesPanel: true
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Renderer &lt;Export&gt;</title>");
    expect(html).toContain('data-htmlslide-mode="print"');
    expect(html).toContain('data-htmlslide-notes="closed"');
    expect(html).toContain('id="htmlslide-notes"');
    expect(html).toContain("htmlslide-notes-panel");
    expect(html).toContain("Title &amp; Notes");
    expect(html).toContain("ArrowRight");
    expect(html).toContain("history.replaceState");
  });
});

describe("buildSlidePreviewDocument", () => {
  it("emits one deterministic slide document with the canonical preview CSP", () => {
    const input = {
      title: deck.title,
      language: deck.language,
      viewport: deck.viewport,
      themeCss: ".slide { color: rgb(12, 34, 56); }",
      slide
    };

    const html = buildSlidePreviewDocument(input);

    expect(html).toBe(buildSlidePreviewDocument(input));
    expect(html.match(/<article class="htmlslide-page"/gu)).toHaveLength(1);
    expect(html).toContain('data-slide-id="001-title"');
    expect(html).toContain('<style>.slide { color: rgb(12, 34, 56); }</style>');
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}" />`
    );
    expect(PREVIEW_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; img-src data:; media-src data:; font-src data:; " +
        "style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; " +
        "object-src 'none'; frame-src 'none'; worker-src 'none'; " +
        "form-action 'none'; base-uri 'none'"
    );
  });

  it("omits runtime scripts and speaker notes by default", () => {
    const html = buildSlidePreviewDocument({
      title: deck.title,
      language: deck.language,
      viewport: deck.viewport,
      slide
    });

    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toContain('id="htmlslide-notes"');
    expect(html).not.toContain('<aside class="htmlslide-notes-panel"');
    expect(html).not.toContain(slide.notes);
    expect(html).not.toContain("history.replaceState");
  });

  it("pins the document and page to the manifest viewport for parent iframe scaling", () => {
    const html = buildSlidePreviewDocument({
      title: deck.title,
      language: deck.language,
      viewport: deck.viewport,
      slide
    });

    expect(html).toContain('<meta name="viewport" content="width=1920, height=1080, initial-scale=1" />');
    expect(html).toContain('data-htmlslide-preview="canonical"');
    expect(html).toContain('data-htmlslide-viewport-width="1920"');
    expect(html).toContain('data-htmlslide-viewport-height="1080"');
    expect(html).toContain("--htmlslide-width: 1920px;");
    expect(html).toContain("--htmlslide-height: 1080px;");
    expect(html).toContain("min-width: var(--htmlslide-width);");
    expect(html).toContain("min-height: var(--htmlslide-height);");
    expect(html).toContain("box-shadow: none;");
  });
});
