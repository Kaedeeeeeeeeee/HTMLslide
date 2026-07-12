import { describe, expect, it } from "vitest";
import { coerceStageOutput, schemaForStage } from "../src/providers/provider-utils.js";

const schemaProperty = (stage: "outline" | "visual-direction", property: string): Record<string, unknown> => {
  const schema = schemaForStage(stage) as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return properties[property] ?? {};
};

describe("provider structured planning output", () => {
  it("declares non-empty outline and visual-direction arrays", () => {
    expect(schemaProperty("outline", "slides").minItems).toBe(1);
    expect(schemaProperty("visual-direction", "directions").minItems).toBe(1);
    const directionItem = (schemaProperty("visual-direction", "directions").items ?? {}) as Record<string, unknown>;
    expect(directionItem.required).not.toContain("sampleSlides");
  });

  it("coerces structured visual direction samples while keeping them optional", () => {
    const output = coerceStageOutput("visual-direction", {
      directions: [{
        id: "direction-editorial",
        label: "Editorial Light",
        rationale: "Readable editorial hierarchy.",
        sampleSlideIds: ["001-title"],
        sampleSlides: [{
          body: "Introduce the main idea.",
          chartValues: [],
          id: "001-title",
          kind: "title",
          metric: "",
          title: "A clear title"
        }],
        tokens: {
          accent: "#2357d9",
          background: "#ffffff",
          text: "#111827"
        }
      }],
      selectedDirectionId: null
    }) as { directions: Array<{ sampleSlides?: unknown[] }> };

    expect(output.directions[0]?.sampleSlides).toHaveLength(1);
    expect(coerceStageOutput("visual-direction", {
      directions: [{
        id: "direction-legacy",
        label: "Legacy",
        rationale: "Legacy output without sample content.",
        sampleSlideIds: ["001-title"],
        tokens: {
          accent: "#2357d9",
          background: "#ffffff",
          text: "#111827"
        }
      }],
      selectedDirectionId: null
    })).toMatchObject({ directions: [{ sampleSlideIds: ["001-title"] }] });
  });

  it("rejects empty outline and visual-direction arrays at runtime", () => {
    expect(() => coerceStageOutput("outline", {
      title: "Empty outline",
      language: "en-US",
      audience: "reviewers",
      durationMinutes: 10,
      slides: []
    })).toThrow("Expected slides to contain at least one item.");

    expect(() => coerceStageOutput("visual-direction", {
      directions: [],
      selectedDirectionId: null
    })).toThrow("Expected directions to contain at least one item.");
  });
});
