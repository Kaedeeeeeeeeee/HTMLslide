import { describe, expect, it } from "vitest";
import { buildDeckHtml, type RenderDeck } from "../src/index";

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
