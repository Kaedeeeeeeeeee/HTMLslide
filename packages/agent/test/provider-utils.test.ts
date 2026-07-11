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
