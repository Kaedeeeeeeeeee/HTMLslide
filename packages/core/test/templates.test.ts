import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECK_TEMPLATE_ID,
  listBuiltInDeckTemplates,
  renderBuiltInDeckTemplate
} from "../src/index.js";

const expectedTemplateIds = [
  "default",
  "swiss-editorial",
  "consulting-clean",
  "technical-dark",
  "product-launch",
  "data-report"
] as const;

describe("built-in deck templates", () => {
  it("lists the official starter template metadata", () => {
    const templates = listBuiltInDeckTemplates();

    expect(templates.map((template) => template.id)).toEqual(expectedTemplateIds);
    expect(templates).toContainEqual(
      expect.objectContaining({
        id: DEFAULT_DECK_TEMPLATE_ID,
        name: "Default",
        slideCount: 2
      })
    );
    expect(templates).toContainEqual(
      expect.objectContaining({
        id: "technical-dark",
        name: "Technical Dark",
        slideCount: 2
      })
    );
  });

  it.each(expectedTemplateIds)("renders a schema-valid %s project without artifact paths", (templateId) => {
    const rendered = renderBuiltInDeckTemplate({ name: "Quarterly Launch Review", templateId });

    expect(rendered.template.id).toBe(templateId);
    expect(rendered.manifest).toMatchObject({
      id: "deck_quarterly_launch_review",
      schemaVersion: "0.1.0",
      title: "Quarterly Launch Review"
    });
    expect(rendered.files.map((file) => file.path)).toEqual([
      "deck.json",
      "theme/theme.css",
      "theme/tokens.json",
      "README.md",
      "AGENTS.md",
      "slides/001-title.html",
      "notes/001-title.md",
      "slides/002-workflow.html",
      "notes/002-workflow.md"
    ]);
    for (const file of rendered.files) {
      expect(path.isAbsolute(file.path)).toBe(false);
      expect(file.path.split(/[\\/]/u)).not.toContain("..");
      expect(file.path.startsWith("exports/")).toBe(false);
    }
  });

  it("rejects unknown built-in template ids", () => {
    expect(() => renderBuiltInDeckTemplate({ name: "Demo", templateId: "missing" })).toThrow("Unknown deck template");
  });

  it("omits notes source files when the template is created with none", () => {
    const rendered = renderBuiltInDeckTemplate({ name: "No Notes", speakerNotesMode: "none" });

    expect(rendered.manifest).toMatchObject({
      speakerNotesMode: "none",
      export: { speakerNotes: false }
    });
    expect(rendered.manifest.slides.every((slide) => slide.notes === undefined)).toBe(true);
    expect(rendered.files.map((file) => file.path)).not.toEqual(expect.arrayContaining([
      "notes/001-title.md",
      "notes/002-workflow.md"
    ]));
  });
});
