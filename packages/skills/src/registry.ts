import {
  OFFICIAL_BUNDLE_LICENSES,
  type OfficialSkillDefinition,
  type SkillDeckMetadata,
  type SkillMetadata,
  type SkillRiskLevel,
  type SkillRiskProfile,
  type SkillValidationIssue
} from "./types.js";
import { validateSkillMetadata } from "./validation.js";

export const OFFICIAL_SKILL_NAMES = [
  "deck-architect",
  "visual-direction",
  "swiss-editorial",
  "consulting-clean",
  "technical-dark",
  "product-launch",
  "data-report",
  "chart-redesign",
  "speaker-notes",
  "anti-ai-slop",
  "deck-repair",
  "brand-kit"
] as const;

export type OfficialSkillName = (typeof OFFICIAL_SKILL_NAMES)[number];

const DESCRIPTIONS: Record<OfficialSkillName, string> = {
  "deck-architect": "Plan deck structure, narrative arc, section flow, and slide intent before source files are written.",
  "visual-direction": "Generate distinct visual directions for a deck while preserving the fixed HTMLslide canvas.",
  "swiss-editorial": "Apply restrained editorial typography, strong grid logic, high whitespace, and limited color.",
  "consulting-clean": "Shape executive consulting slides with conclusion-led titles, matrices, comparisons, and frameworks.",
  "technical-dark": "Create dark technical presentation systems for architecture, code, AI product, and developer workflows.",
  "product-launch": "Guide product announcement and launch decks with crisp positioning, feature proof, and rollout flow.",
  "data-report": "Structure data-heavy review decks with metric hierarchy, dashboards, business context, and notes.",
  "chart-redesign": "Turn raw chart ideas into clearer insight-led visualizations for HTMLslide decks.",
  "speaker-notes": "Draft speaker notes, talk tracks, rehearsal cues, and timing guidance for deck slides.",
  "anti-ai-slop": "Detect and remove generic AI-looking layout, decoration, copy, and visual filler.",
  "deck-repair": "Repair overflow, contrast, density, type scale, asset, and source consistency issues.",
  "brand-kit": "Convert brand guidance into project-local tokens, layout rules, and reusable deck constraints."
};

const DECK_TYPES: Record<OfficialSkillName, SkillDeckMetadata["type"]> = {
  "deck-architect": "planning",
  "visual-direction": "visual-direction",
  "swiss-editorial": "design-system",
  "consulting-clean": "design-system",
  "technical-dark": "design-system",
  "product-launch": "content",
  "data-report": "data",
  "chart-redesign": "data",
  "speaker-notes": "content",
  "anti-ai-slop": "quality",
  "deck-repair": "quality",
  "brand-kit": "brand-system"
};

const MEDIUM_RISK_SKILLS = new Set<OfficialSkillName>([
  "data-report",
  "chart-redesign",
  "speaker-notes",
  "deck-repair",
  "brand-kit"
]);

const COMMON_SUPPORTS = ["fixed-viewport", "speaker-notes", "deck-check"] as const;

function createRiskProfile(): SkillRiskProfile {
  return {
    scripts: false,
    network: false,
    remoteAssets: false,
    writesExports: false,
    writesSecrets: false,
    modifiesSource: true
  };
}

function bodyForSkill(name: OfficialSkillName): string {
  return `# ${name}

${DESCRIPTIONS[name]}

## Operating Boundaries

- Edit HTMLslide source areas only: deck.json, slides, notes, theme, assets, and project-local skills.
- Do not write generated exports or secrets.
- Keep changes compatible with deck schema 0.1.0 and the fixed 1920x1080 canvas.
- Prefer deterministic, inspectable edits that can be checked by htmlslide check.
`;
}

function renderStringArray(key: string, values: readonly string[]): string {
  return `${key}:\n${values.map((value) => `  - ${value}`).join("\n")}`;
}

export function renderSkillMarkdown(metadata: SkillMetadata, body: string): string {
  const deck = metadata.deck;
  return `---
name: ${metadata.name}
version: ${metadata.version}
description: ${metadata.description}
license: ${metadata.license}
entrypoint: ${metadata.entrypoint}
${renderStringArray("supportedDeckSchema", metadata.supportedDeckSchema)}
riskLevel: ${metadata.riskLevel}
${renderStringArray("installTargets", metadata.installTargets)}
author: ${metadata.author ?? "HTMLslide"}
deck:
  type: ${deck.type}
  output: ${deck.output}
  viewport: ${deck.viewport}
  supports:
${deck.supports.map((support) => `    - ${support}`).join("\n")}
  risk:
    scripts: ${String(deck.risk.scripts)}
    network: ${String(deck.risk.network)}
    remoteAssets: ${String(deck.risk.remoteAssets)}
    writesExports: ${String(deck.risk.writesExports)}
    writesSecrets: ${String(deck.risk.writesSecrets)}
    modifiesSource: ${String(deck.risk.modifiesSource)}
---

${body.trim()}
`;
}

function createOfficialSkill(name: OfficialSkillName): OfficialSkillDefinition {
  const riskLevel: SkillRiskLevel = MEDIUM_RISK_SKILLS.has(name) ? "medium" : "low";
  const metadata: SkillMetadata = {
    name,
    version: "0.1.0",
    description: DESCRIPTIONS[name],
    license: OFFICIAL_BUNDLE_LICENSES[1],
    entrypoint: "SKILL.md",
    supportedDeckSchema: ["0.1.0"],
    riskLevel,
    installTargets: ["global", "project"],
    author: "HTMLslide",
    deck: {
      type: DECK_TYPES[name],
      output: "html-slide",
      viewport: "1920x1080",
      supports: [...COMMON_SUPPORTS],
      risk: createRiskProfile()
    }
  };

  return {
    official: true,
    metadata,
    markdown: renderSkillMarkdown(metadata, bodyForSkill(name))
  };
}

export const OFFICIAL_SKILLS: OfficialSkillDefinition[] = OFFICIAL_SKILL_NAMES.map((name) =>
  createOfficialSkill(name)
);

export function getOfficialSkill(name: OfficialSkillName | string): OfficialSkillDefinition | undefined {
  return OFFICIAL_SKILLS.find((skill) => skill.metadata.name === name);
}

export function validateOfficialSkillRegistry(): { ok: true; issues: [] } | { ok: false; issues: SkillValidationIssue[] } {
  const issues: SkillValidationIssue[] = [];
  const seen = new Set<string>();

  for (const [index, skill] of OFFICIAL_SKILLS.entries()) {
    if (seen.has(skill.metadata.name)) {
      issues.push({
        code: "invalid-name",
        path: `officialSkills.${index}.name`,
        message: `Duplicate official skill name: ${skill.metadata.name}.`
      });
    }
    seen.add(skill.metadata.name);

    const validation = validateSkillMetadata(skill.metadata, { official: true });
    if (!validation.ok) {
      for (const validationIssue of validation.issues) {
        issues.push({
          ...validationIssue,
          path: `officialSkills.${index}.${validationIssue.path}`
        });
      }
    }
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}
