import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECK_TEMPLATE_ID,
  listBuiltInDeckTemplates,
  renderBuiltInDeckTemplate
} from "../src/index.js";

describe("built-in deck templates", () => {
  it("lists the default template metadata", () => {
    expect(listBuiltInDeckTemplates()).toEqual([
      expect.objectContaining({
        id: DEFAULT_DECK_TEMPLATE_ID,
        name: "Default",
        slideCount: 2
      })
    ]);
  });

  it("renders a schema-valid default project without artifact paths", () => {
    const rendered = renderBuiltInDeckTemplate({ name: "Quarterly Launch Review" });

    expect(rendered.template.id).toBe(DEFAULT_DECK_TEMPLATE_ID);
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
});
