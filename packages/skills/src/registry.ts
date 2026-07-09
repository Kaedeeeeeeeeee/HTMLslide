import {
  OFFICIAL_BUNDLE_LICENSES,
  type OfficialSkillDefinition,
  type SkillDeckMetadata,
  type SkillMetadata,
  type SkillRiskLevel,
  type SkillRiskProfile,
  type SkillValidationIssue
} from "./types.js";
import { DECK_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
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

const COMMON_BODY_BOUNDARIES = [
  "## Operating Boundaries",
  "",
  "- Edit HTMLslide source areas only: deck.json, slides, notes, theme, assets, and project-local skills.",
  "- Do not write generated exports or secrets.",
  `- Keep changes compatible with deck schema ${DECK_SCHEMA_VERSION} and the fixed 1920x1080 canvas.`,
  "- Prefer deterministic, inspectable edits that can be checked by htmlslide check."
];

const DETAILED_SKILL_BODIES: Partial<Record<OfficialSkillName, readonly string[]>> = {
  "deck-architect": [
    "# deck-architect",
    "",
    DESCRIPTIONS["deck-architect"],
    "",
    "## When To Use",
    "",
    "- Use this skill before slide source files are written or when an existing deck needs a clearer story spine.",
    "- Start from the brief, audience, venue, time limit, language, required slide count, and any source material already in the project.",
    "- Prefer structure over decoration. This skill decides what each slide must prove before visual work starts.",
    "",
    "## Inputs To Inspect",
    "",
    "- deck.json for language, viewport, slide order, kind, status, and existing notes paths.",
    "- slides/ for current narrative beats, repeated claims, missing evidence, and weak section transitions.",
    "- notes/ for speaker intent, timing, objections, and details that should move into or out of the visible slide.",
    "- theme/ and assets/ only to understand available constraints, not to redesign the deck.",
    "",
    "## Workflow",
    "",
    "- Write a one-sentence audience promise for the deck.",
    "- Group slides into opening, context, proof, decision, and close. Rename these groups to match the actual deck domain.",
    "- For each slide, assign one job: setup, contrast, evidence, implication, decision, or recap.",
    "- Check whether each slide title states a claim, not a vague topic. Rewrite titles only when the source content supports the claim.",
    "- Identify missing slides only when the story cannot be understood without them. Keep additions minimal.",
    "- Mark risks as comments in notes or a project-local planning artifact, never in exports.",
    "",
    "## Output Contract",
    "",
    "- Produce a concise outline with section names, slide ids, slide intent, and the narrative evidence each slide must carry.",
    "- If editing files, update deck.json, slides, and notes together so slide order, titles, and notes stay consistent.",
    "- Keep every manifest path project-relative and outside exports/.",
    "- Finish by running or recommending htmlslide check for the affected project.",
    "",
    "## Quality Bar",
    "",
    "- A reviewer can explain the deck in 30 seconds from the outline alone.",
    "- No two adjacent slides perform the same narrative job unless one is appendix detail.",
    "- Every data or quote slide has a visible implication for the audience.",
    "- The closing slide tells the audience what to decide, remember, or do next."
  ],
  "visual-direction": [
    "# visual-direction",
    "",
    DESCRIPTIONS["visual-direction"],
    "",
    "## When To Use",
    "",
    "- Use this skill after deck structure is known and before full slide production.",
    "- Generate distinct directions for the same fixed HTMLslide canvas rather than minor color variants.",
    "- Keep directions usable for local HTML/PDF export without remote assets or runtime services.",
    "",
    "## Direction Set",
    "",
    "- Create 3 to 6 named directions.",
    "- Treat each option as a direction card with layout logic, typography, type scale, color intent, image treatment, chart treatment, and motion policy.",
    "- Include one conservative direction, one expressive direction, and one domain-specific direction when the brief allows it.",
    "- Avoid generic AI visual tropes: gradient blobs, decorative orbs, fake glass panels, and meaningless abstract shapes.",
    "",
    "## Canvas Rules",
    "",
    "- Design for a 1920x1080 fixed viewport and preserve 16:9 composition.",
    "- Keep safe-area margins explicit enough for agents to apply repeatedly.",
    "- Choose typography and density that remain legible when exported to PDF and presented on a projector.",
    "- Prefer project-local theme tokens and CSS variables over one-off inline styling.",
    "",
    "## Output Contract",
    "",
    "- Produce a direction matrix with name, rationale, palette, type scale, layout rules, chart rules, and best-fit deck types.",
    "- Recommend one direction only after explaining the tradeoff against the alternatives.",
    "- If editing files, write theme tokens and at most one representative slide treatment before applying the direction broadly.",
    "- Finish by checking contrast, overflow, and visual consistency with htmlslide check or a rendered preview.",
    "",
    "## Selection Notes",
    "",
    "- Choose the quietest direction that still communicates the product, company, or talk identity.",
    "- Reject directions that make slide content harder to scan.",
    "- Record any asset assumptions in notes or theme documentation so later agents can reproduce the style."
  ],
  "deck-repair": [
    "# deck-repair",
    "",
    DESCRIPTIONS["deck-repair"],
    "",
    "## When To Use",
    "",
    "- Use this skill after htmlslide check, visual review, export smoke, or user feedback reveals deck quality issues.",
    "- Prioritize repairs that improve readability, correctness, and export reliability before aesthetic polish.",
    "- Work from the existing deck intent. Do not replace the style system unless it is the root cause.",
    "",
    "## Repair Order",
    "",
    "- Start from htmlslide check --json when available, then fix schema and missing-file errors first.",
    "- Fix source path, asset, and notes references before layout work.",
    "- Fix overflow, clipping, contrast, and unreadable type next.",
    "- Fix density, hierarchy, chart labeling, and visual rhythm after the deck can export cleanly.",
    "- Re-run the narrowest relevant check after each class of repair.",
    "",
    "## Inspection Checklist",
    "",
    "- deck.json paths are project-relative and do not point into exports/.",
    "- Each slide root uses the expected data-slide-id.",
    "- Images have local assets, useful alt text, and stable dimensions.",
    "- Text fits inside its parent at 1920x1080 without overlapping adjacent content.",
    "- Charts expose the takeaway, units, labels, and source context.",
    "- Speaker notes exist when the slide needs timing, narration, or caveats.",
    "",
    "## Allowed Fixes",
    "",
    "- Adjust HTML structure, CSS, theme tokens, asset references, notes, and deck manifest metadata.",
    "- Replace brittle layout values with fixed-canvas constraints, grids, and explicit dimensions.",
    "- Simplify content when it improves comprehension, but preserve factual meaning.",
    "- Add project-local comments only when they explain a non-obvious repair.",
    "",
    "## Output Contract",
    "",
    "- List repaired slide ids and the issue class fixed for each.",
    "- Keep changes limited to source areas and do not modify exports/.",
    "- Leave the deck in a state where htmlslide check can prove the repaired behavior.",
    "- If any issue remains, state the exact remaining issues, file, selector or path, and why it needs user input."
  ],
  "brand-kit": [
    "# brand-kit",
    "",
    DESCRIPTIONS["brand-kit"],
    "",
    "## When To Use",
    "",
    "- Use this skill when a deck must follow a company, product, venue, or campaign identity.",
    "- Convert brand inputs into reusable local constraints rather than copying brand text into every slide.",
    "- If brand assets are missing or ambiguous, create a conservative token draft and mark assumptions clearly.",
    "",
    "## Inputs To Extract",
    "",
    "- Logo usage rules, clear space, minimum size, and prohibited treatments.",
    "- Primary, secondary, neutral, success, warning, and danger color roles with accessible pairings.",
    "- Typeface choices, fallback font stacks, scale, weights, line-height rules, and any license constraints.",
    "- Grid, spacing, corner radius, stroke, shadow, chart, icon, and image treatment rules.",
    "- Voice guidance that affects slide titles, claims, and speaker notes.",
    "",
    "## Token Contract",
    "",
    "- Store reusable decisions in project-local theme files, preferably theme/tokens.css or a nearby documented token file.",
    "- Use semantic token names such as surface, text, accent, line, danger, and chart-series instead of raw brand-color names only.",
    "- Define safe defaults for missing brand roles instead of leaving agents to invent one-off colors.",
    "- Keep tokens compatible with HTML/PDF export and offline viewing.",
    "",
    "## Layout Rules",
    "",
    "- Document title, section, content, data, image, quote, closing, and appendix slide rules when relevant.",
    "- Describe logo placement, footer policy, page numbers, chart placement, and image crop behavior.",
    "- Specify which visual treatments are allowed and which are banned for the brand.",
    "- Keep the rules concise enough for an agent to apply without reading a long brand book each run.",
    "",
    "## Asset And License Safety",
    "",
    "- Treat logo, font, and image license status as an explicit adoption risk when source rights are unclear.",
    "- Use project-owned local assets only and document any fallback choices for missing brand files.",
    "- Do not embed proprietary brand files into generated examples unless the user provided them for this project.",
    "",
    "## Output Contract",
    "",
    "- Produce or update theme tokens plus a short brand usage note in a project-local source file.",
    "- If editing slides, apply the brand kit to a representative set before broad rollout.",
    "- Preserve deck.json validity and project-relative paths.",
    "- Finish with a review checklist for contrast, logo usage, typography, chart colors, and PDF export."
  ]
};

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
  const body = DETAILED_SKILL_BODIES[name] ?? [
    `# ${name}`,
    "",
    DESCRIPTIONS[name]
  ];

  return [...body, "", ...COMMON_BODY_BOUNDARIES].join("\n");
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
    version: HTMLSLIDE_APP_VERSION,
    description: DESCRIPTIONS[name],
    license: OFFICIAL_BUNDLE_LICENSES[1],
    entrypoint: "SKILL.md",
    supportedDeckSchema: [DECK_SCHEMA_VERSION],
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
