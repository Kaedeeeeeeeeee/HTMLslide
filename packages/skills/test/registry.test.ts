import { describe, expect, it } from "vitest";
import {
  OFFICIAL_SKILLS,
  OFFICIAL_SKILL_NAMES,
  parseSkillMarkdown,
  validateOfficialSkillRegistry
} from "../src/index.js";

describe("official skill registry", () => {
  it("contains the first official skill pack in plan order", () => {
    expect(OFFICIAL_SKILLS.map((skill) => skill.metadata.name)).toEqual([...OFFICIAL_SKILL_NAMES]);
    expect(OFFICIAL_SKILLS).toHaveLength(12);
  });

  it("keeps official skills unique, permissively licensed, and parseable", () => {
    const registryValidation = validateOfficialSkillRegistry();

    expect(registryValidation.ok).toBe(true);
    if (!registryValidation.ok) {
      throw new Error(registryValidation.issues.map((issue) => issue.message).join("\n"));
    }

    const names = new Set<string>();
    for (const skill of OFFICIAL_SKILLS) {
      expect(names.has(skill.metadata.name)).toBe(false);
      names.add(skill.metadata.name);
      expect(["MIT", "Apache-2.0"]).toContain(skill.metadata.license);
      expect(skill.metadata.installTargets).toEqual(["global", "project"]);

      const parsed = parseSkillMarkdown(skill.markdown, { official: true });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
      }
      expect(parsed.document.metadata.name).toBe(skill.metadata.name);
    }
  });
});
