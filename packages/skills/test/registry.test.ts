import { describe, expect, it } from "vitest";
import {
  OFFICIAL_SKILLS,
  OFFICIAL_SKILL_NAMES,
  getOfficialSkill,
  parseSkillMarkdown,
  validateOfficialSkillRegistry
} from "../src/index.js";

const DETAILED_OFFICIAL_SKILL_EXPECTATIONS = {
  "deck-architect": ["## Workflow", "## Output Contract", "brief", "outline", "narrative", "slide intent"],
  "visual-direction": ["## Direction Set", "## Canvas Rules", "3 to 6", "direction card", "typography", "color"],
  "deck-repair": ["## Repair Order", "## Inspection Checklist", "htmlslide check --json", "overflow", "contrast", "assets", "remaining issues"],
  "brand-kit": ["## Token Contract", "## Layout Rules", "## Asset And License Safety", "semantic token names", "license", "contrast", "fallback"]
} as const;

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

  it("ships detailed guidance for high-value official skills", () => {
    for (const [skillName, expectedPhrases] of Object.entries(DETAILED_OFFICIAL_SKILL_EXPECTATIONS)) {
      const skill = getOfficialSkill(skillName);
      expect(skill).toBeDefined();
      if (!skill) {
        throw new Error(`${skillName} not found`);
      }

      const parsed = parseSkillMarkdown(skill.markdown, { official: true });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
      }

      expect(parsed.document.body.split(/\s+/).length).toBeGreaterThan(140);
      expect(parsed.document.body.match(/^- /gm)?.length ?? 0).toBeGreaterThanOrEqual(12);
      expect(parsed.document.body).toContain("## Operating Boundaries");
      expect(parsed.document.body).toContain("Do not write generated exports or secrets");
      expect(parsed.document.body).toContain("fixed 1920x1080 canvas");
      expect(parsed.document.body).toContain("htmlslide check");
      for (const phrase of expectedPhrases) {
        expect(parsed.document.body).toContain(phrase);
      }
    }
  });
});
