import path from "node:path";
import { promises as fs } from "node:fs";
import { DECK_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import {
  normalizeSpeakerNotesMode,
  speakerNotesModeHasFiles,
  type SpeakerNotesMode
} from "@htmlslide/core";
import { applyAgentSourceWrites } from "./source-writes.js";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentOutline,
  AgentOutlineSlide,
  AgentRunSucceededResult,
  AgentSourceWrite,
  ApplyMockAgentProjectInput,
  ApplyMockAgentProjectResult,
  AppliedMockAgentProjectSlide,
  JsonObject,
  JsonValue,
  NormalizedBrief,
  VisualDirection,
  VisualDirectionSet
} from "./types.js";

const deckPath = "deck.json" as const;
const themePaths = ["theme/theme.css", "theme/tokens.json"] as const;

type ApplicableMockAgentRunResult = AgentRunSucceededResult & {
  outputs: AgentRunSucceededResult["outputs"] & {
    build: AgentBuildResult;
    checks: AgentCheckResult[];
    outline: AgentOutline;
    visualDirection: VisualDirectionSet;
  };
};

export const applyMockAgentProject = async (
  input: ApplyMockAgentProjectInput
): Promise<ApplyMockAgentProjectResult> => {
  assertSuccessfulMockResult(input.result);

  const projectPath = path.resolve(input.projectPath);
  const brief = input.result.outputs.brief;
  const outline = input.result.outputs.outline;
  const visualDirection = input.result.outputs.visualDirection;
  const selectedDirection = selectedVisualDirection(visualDirection);
  const speakerNotesMode = normalizeSpeakerNotesMode(input.result.outputs.speakerNotesMode);
  const title = brief?.title ?? outline.title;
  const language = brief?.language ?? outline.language;
  const briefText = cleanInlineText(input.brief ?? brief?.brief ?? "Create a short mock HTMLslide deck.");
  const slides = outline.slides.map((slide) => ({
    ...slide,
    source: `slides/${slide.id}.html`,
    ...(speakerNotesModeHasFiles(speakerNotesMode) ? { notes: `notes/${slide.id}.md` } : {})
  }));
  const slidePaths = slides.map((slide) => slide.source);
  const notePaths = slides.flatMap((slide) => (slide.notes ? [slide.notes] : []));

  const writes: AgentSourceWrite[] = [
    {
      path: deckPath,
      content: `${stableJson(buildDeckJson({
        language,
        runId: input.result.runId,
        slides,
        speakerNotesMode,
        title
      }))}\n`
    },
    ...slides.map((slide, index) => ({
      path: slide.source,
      content: buildMockSlide({
        brief,
        direction: selectedDirection,
        index,
        slide,
        slides,
        title
      })
    })),
    ...slides.flatMap((slide, index) => slide.notes
      ? [{
          path: slide.notes,
          content: buildMockNotes({ briefText, index, mode: speakerNotesMode, slide, slideCount: slides.length, title })
        }]
      : []),
    {
      path: "theme/theme.css",
      content: buildThemeCss(selectedDirection)
    },
    {
      path: "theme/tokens.json",
      content: `${stableJson(buildThemeTokens(selectedDirection))}\n`
    }
  ];

  await applyAgentSourceWrites({ projectPath, writes });
  const removedNotePaths = speakerNotesMode === "none" ? await removeMockNoteFiles(projectPath) : [];

  const appliedSlides: AppliedMockAgentProjectSlide[] = slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    source: slide.source,
    ...(slide.notes ? { notes: slide.notes } : {})
  }));

  return {
    projectPath,
    title,
    language,
    selectedVisualDirectionId: selectedDirection.id,
    filesChanged: [deckPath, ...slidePaths, ...notePaths, ...removedNotePaths, ...themePaths],
    slideIds: slides.map((slide) => slide.id),
    slides: appliedSlides,
    paths: {
      deck: deckPath,
      slides: slidePaths,
      notes: notePaths,
      theme: [...themePaths]
    }
  };
};

async function removeMockNoteFiles(projectPath: string): Promise<string[]> {
  const notesRoot = path.join(projectPath, "notes");
  const notesStat = await fs.lstat(notesRoot).catch(() => undefined);
  if (notesStat === undefined) {
    return [];
  }
  if (!notesStat.isDirectory() || notesStat.isSymbolicLink()) {
    throw new Error("Mock project notes directory must be a real project directory.");
  }

  const entries = await fs.readdir(notesRoot, { withFileTypes: true });
  const noteEntries = entries.filter((entry) => entry.name.endsWith(".md"));
  if (noteEntries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    throw new Error("Mock project notes must contain only regular Markdown files.");
  }
  await Promise.all(noteEntries.map((entry) => fs.rm(path.join(notesRoot, entry.name))));
  return noteEntries.map((entry) => `notes/${entry.name}`);
}

function assertSuccessfulMockResult(
  result: ApplyMockAgentProjectInput["result"]
): asserts result is ApplicableMockAgentRunResult {
  if (!result.ok || result.status !== "succeeded") {
    throw new Error("Cannot apply mock agent project files from a non-successful agent run.");
  }

  if (result.outputs.build === undefined) {
    throw new Error("Cannot apply mock agent project files without a build output.");
  }

  if (result.outputs.outline === undefined) {
    throw new Error("Cannot apply mock agent project files without an outline output.");
  }

  if (result.outputs.visualDirection === undefined) {
    throw new Error("Cannot apply mock agent project files without visual direction output.");
  }

  const latestCheck = result.outputs.checks.at(-1);
  if (latestCheck?.status !== "passed") {
    throw new Error("Cannot apply mock agent project files unless the latest check passed.");
  }

  const changedSlides = new Set(result.outputs.build.slidesChanged);
  const missingSlide = result.outputs.outline.slides.find((slide) => !changedSlides.has(slide.id))?.id;
  if (missingSlide !== undefined) {
    throw new Error(`Cannot apply mock agent project files; build output is missing ${missingSlide}.`);
  }
}

const selectedVisualDirection = (visualDirection: VisualDirectionSet): VisualDirection => {
  const selectedId = visualDirection.selectedDirectionId;
  const selected =
    visualDirection.directions.find((direction) => direction.id === selectedId) ?? visualDirection.directions[0];

  if (selected === undefined) {
    throw new Error("Cannot apply mock agent project files without at least one visual direction.");
  }

  return selected;
};

const buildDeckJson = (input: {
  title: string;
  language: string;
  runId: string;
  speakerNotesMode: SpeakerNotesMode;
  slides: Array<AgentOutlineSlide & { source: string; notes?: string }>;
}): JsonObject => ({
  schemaVersion: DECK_SCHEMA_VERSION,
  appVersion: HTMLSLIDE_APP_VERSION,
  id: slugDeckId(input.title),
  title: input.title,
  language: input.language,
  aspectRatio: "16:9",
  viewport: {
    width: 1920,
    height: 1080
  },
  safeArea: {
    top: 72,
    right: 96,
    bottom: 72,
    left: 96
  },
  theme: {
    css: "theme/theme.css",
    tokens: "theme/tokens.json"
  },
  slides: input.slides.map((slide, index) => ({
    id: slide.id,
    title: slide.title,
    source: slide.source,
    ...(slide.notes ? { notes: slide.notes } : {}),
    durationSec: index === 1 ? 120 : 75,
    kind: slide.kind,
    status: "ready"
  })),
  speakerNotesMode: input.speakerNotesMode,
  export: {
    pdf: true,
    html: true,
    deckpkg: true,
    thumbnails: true,
    speakerNotes: speakerNotesModeHasFiles(input.speakerNotesMode)
  },
  agent: {
    preferredEngine: "htmlslide-mock",
    lastRunId: input.runId
  }
});

const buildTitleSlide = (input: {
  title: string;
  brief?: NormalizedBrief;
  direction: VisualDirection;
  slideId: string;
}): string => `${[
  `<section class="slide title-slide" data-slide-id="${escapeHtml(input.slideId)}">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">HTMLslide mock agent</p>`,
  `    <h1>${escapeHtml(input.title)}</h1>`,
  `    <p class="subtitle">Deterministic source files for a local-first review deck.</p>`,
  `    <dl class="meta-grid">`,
  `      <div><dt>Audience</dt><dd>${escapeHtml(input.brief?.audience ?? "technical reviewers")}</dd></div>`,
  `      <div><dt>Direction</dt><dd>${escapeHtml(input.direction.label)}</dd></div>`,
  `      <div><dt>Duration</dt><dd>${escapeHtml(String(input.brief?.durationMinutes ?? 8))} minutes</dd></div>`,
  `    </dl>`,
  `  </div>`,
  `</section>`
].join("\n")}\n`;

const buildWorkflowSlide = (input: {
  slides: Array<AgentOutlineSlide & { source: string; notes?: string }>;
  direction: VisualDirection;
  slide: AgentOutlineSlide;
}): string => `${[
  `<section class="slide workflow-slide" data-slide-id="${escapeHtml(input.slide.id)}">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">Controlled workflow</p>`,
  `    <h2>${escapeHtml(input.slide.title)}</h2>`,
  `    <ol class="workflow-list">`,
  `      <li><strong>Brief</strong><span>Normalize goals, language, audience, and timing.</span></li>`,
  `      <li><strong>Outline</strong><span>Lock three slide ids before source files are written.</span></li>`,
  `      <li><strong>Visual</strong><span>Apply ${escapeHtml(input.direction.label)} tokens without remote assets.</span></li>`,
  `      <li><strong>Build</strong><span>Write deck, slides, notes, and theme sources deterministically.</span></li>`,
  `      <li><strong>Check</strong><span>Use the linter contract to verify ids, notes, and local resources.</span></li>`,
  `    </ol>`,
  `  </div>`,
  `</section>`
].join("\n")}\n`;

const buildReviewSlide = (input: {
  direction: VisualDirection;
  slide: AgentOutlineSlide;
  slideCount: number;
  title: string;
}): string => `${[
  `<section class="slide review-slide" data-slide-id="${escapeHtml(input.slide.id)}">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">Reviewable outputs</p>`,
  `    <h2>Ready for local check and export</h2>`,
  `    <div class="review-grid">`,
  `      <article><h3>Sources</h3><p>Manifest, slide fragments, speaker notes, CSS, and tokens are project-local.</p></article>`,
  `      <article><h3>Identity</h3><p>All ${input.slideCount} slide ids match their data-slide-id attributes.</p></article>`,
  `      <article><h3>Theme</h3><p>${escapeHtml(input.direction.label)} keeps ${escapeHtml(input.title)} consistent offline.</p></article>`,
  `    </div>`,
  `  </div>`,
  `</section>`
].join("\n")}\n`;

const buildTitleNotes = (input: {
  title: string;
  briefText: string;
  slide: AgentOutlineSlide;
}): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  ``,
  `Open by naming "${markdownInline(input.title)}" as a deterministic mock deck. State that this run proves the agent can turn abstract build output into editable HTMLslide source files.`,
  ``,
  `Brief context: ${markdownInline(input.briefText)}`,
  ``,
  `Presenter cue: ${markdownInline(input.slide.goal)}`,
  ``,
  `Timing: 75s`
].join("\n")}\n`;

const buildWorkflowNotes = (input: { briefText: string; slide: AgentOutlineSlide }): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  ``,
  `Walk through the pipeline from brief to review. Emphasize that each stage produces structured output before the source writer touches deck.json, slide fragments, notes, or theme files.`,
  ``,
  `Call out the safety contract: paths stay project-relative, remote resources are avoided, and generated notes remain clear enough for a reviewer to rehearse the deck.`,
  ``,
  `Brief context: ${markdownInline(input.briefText)}`,
  ``,
  `Presenter cue: ${markdownInline(input.slide.goal)}`,
  ``,
  `Timing: 120s`
].join("\n")}\n`;

const buildReviewNotes = (input: { slide: AgentOutlineSlide }): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  ``,
  `Close by summarizing the concrete files that changed and the checks a human reviewer should run next. The important point is that exports remain artifacts, while this module writes only source areas.`,
  ``,
  `Mention that deck.json references every slide and note with POSIX project-relative paths. The theme is local CSS plus JSON tokens, so export can run without downloading fonts, scripts, or images.`,
  ``,
  `Presenter cue: ${markdownInline(input.slide.goal)}`,
  ``,
  `Timing: 75s`
].join("\n")}\n`;

const buildDetailSlide = (input: { direction: VisualDirection; slide: AgentOutlineSlide }): string => `${[
  `<section class="slide workflow-slide" data-slide-id="${escapeHtml(input.slide.id)}">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">Supporting detail</p>`,
  `    <h2>${escapeHtml(input.slide.title)}</h2>`,
  `    <p class="subtitle">${escapeHtml(input.slide.goal)}</p>`,
  `    <ol class="workflow-list">`,
  `      <li><strong>Purpose</strong><span>${escapeHtml(input.slide.goal)}</span></li>`,
  `      <li><strong>Direction</strong><span>Use ${escapeHtml(input.direction.label)} tokens and project-local source.</span></li>`,
  `      <li><strong>Review</strong><span>Check hierarchy, spacing, notes, and export output.</span></li>`,
  `    </ol>`,
  `  </div>`,
  `</section>`
].join("\n")}\n`;

const buildDetailNotes = (input: { briefText: string; slide: AgentOutlineSlide }): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  ``,
  `Explain the supporting point in the context of the requested deck, then connect it to the next section.`,
  ``,
  `Brief context: ${markdownInline(input.briefText)}`,
  ``,
  `Presenter cue: ${markdownInline(input.slide.goal)}`,
  ``,
  `Timing: 75s`
].join("\n")}\n`;

const buildMockSlide = (input: {
  brief?: NormalizedBrief;
  direction: VisualDirection;
  index: number;
  slide: AgentOutlineSlide;
  slides: Array<AgentOutlineSlide & { source: string; notes?: string }>;
  title: string;
}): string => {
  if (input.index === 0) {
    return buildTitleSlide({
      title: input.title,
      brief: input.brief,
      direction: input.direction,
      slideId: input.slide.id
    });
  }
  if (input.index === input.slides.length - 1) {
    return buildReviewSlide({
      title: input.title,
      direction: input.direction,
      slide: input.slide,
      slideCount: input.slides.length
    });
  }
  if (input.index === 1) {
    return buildWorkflowSlide({ slides: input.slides, direction: input.direction, slide: input.slide });
  }
  return buildDetailSlide({ direction: input.direction, slide: input.slide });
};

const buildMockNotes = (input: {
  briefText: string;
  index: number;
  mode: SpeakerNotesMode;
  slide: AgentOutlineSlide;
  slideCount: number;
  title: string;
}): string => {
  if (input.mode === "bullet-notes") {
    return buildBulletNotes(input);
  }
  if (input.mode === "rehearsal-cues") {
    return buildRehearsalNotes(input);
  }
  if (input.index === 0) {
    return buildTitleNotes({ title: input.title, briefText: input.briefText, slide: input.slide });
  }
  if (input.index === input.slideCount - 1) {
    return buildReviewNotes({ slide: input.slide });
  }
  if (input.index === 1) {
    return buildWorkflowNotes({ briefText: input.briefText, slide: input.slide });
  }
  return buildDetailNotes({ briefText: input.briefText, slide: input.slide });
};

const buildBulletNotes = (input: { briefText: string; slide: AgentOutlineSlide }): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  "",
  `- Goal: ${markdownInline(input.slide.goal)}`,
  `- Context: ${markdownInline(input.briefText)}`,
  `- Cue: ${markdownInline(input.slide.title)}`
].join("\n")}\n`;

const buildRehearsalNotes = (input: { slide: AgentOutlineSlide; index: number; slideCount: number }): string => `${[
  `# ${markdownInline(input.slide.id)}`,
  "",
  `Cue: ${markdownInline(input.slide.goal)}`,
  `Pause after this slide and bridge to ${input.index === input.slideCount - 1 ? "the close" : "the next point"}.`,
  `Timing: ${input.index === 1 ? 120 : 75}s`
].join("\n")}\n`;

const buildThemeCss = (direction: VisualDirection): string => {
  const background = tokenString(direction.tokens, "background", "#fbfbfd");
  const text = tokenString(direction.tokens, "text", "#171923");
  const accent = tokenString(direction.tokens, "accent", "#2357d9");

  return `${[
    `:root {`,
    `  --htmlslide-bg: ${background};`,
    `  --htmlslide-text: ${text};`,
    `  --htmlslide-accent: ${accent};`,
    `  --htmlslide-muted: #5f6b7a;`,
    `  --htmlslide-panel: #ffffff;`,
    `  --htmlslide-line: #d9e0ea;`,
    `}`,
    ``,
    `.slide {`,
    `  box-sizing: border-box;`,
    `  width: 1920px;`,
    `  height: 1080px;`,
    `  margin: 0;`,
    `  overflow: hidden;`,
    `  background: var(--htmlslide-bg);`,
    `  color: var(--htmlslide-text);`,
    `  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;`,
    `}`,
    ``,
    `.safe-area {`,
    `  box-sizing: border-box;`,
    `  width: 100%;`,
    `  height: 100%;`,
    `  padding: 72px 96px;`,
    `}`,
    ``,
    `.title-slide .safe-area,`,
    `.review-slide .safe-area {`,
    `  display: grid;`,
    `  align-content: center;`,
    `  gap: 34px;`,
    `}`,
    ``,
    `.workflow-slide .safe-area {`,
    `  display: grid;`,
    `  align-content: start;`,
    `  gap: 30px;`,
    `}`,
    ``,
    `.eyebrow {`,
    `  margin: 0;`,
    `  color: var(--htmlslide-accent);`,
    `  font-size: 28px;`,
    `  font-weight: 760;`,
    `  letter-spacing: 0;`,
    `  text-transform: uppercase;`,
    `}`,
    ``,
    `h1,`,
    `h2,`,
    `h3,`,
    `p {`,
    `  margin: 0;`,
    `}`,
    ``,
    `h1 {`,
    `  max-width: 1180px;`,
    `  font-size: 96px;`,
    `  line-height: 1.02;`,
    `}`,
    ``,
    `h2 {`,
    `  max-width: 1120px;`,
    `  font-size: 72px;`,
    `  line-height: 1.08;`,
    `}`,
    ``,
    `.subtitle {`,
    `  max-width: 920px;`,
    `  color: var(--htmlslide-muted);`,
    `  font-size: 36px;`,
    `  line-height: 1.3;`,
    `}`,
    ``,
    `.meta-grid,`,
    `.review-grid {`,
    `  display: grid;`,
    `  grid-template-columns: repeat(3, minmax(0, 1fr));`,
    `  gap: 22px;`,
    `}`,
    ``,
    `.meta-grid {`,
    `  max-width: 1160px;`,
    `}`,
    ``,
    `.meta-grid div,`,
    `.review-grid article {`,
    `  border: 1px solid var(--htmlslide-line);`,
    `  border-radius: 8px;`,
    `  background: var(--htmlslide-panel);`,
    `  padding: 26px;`,
    `}`,
    ``,
    `dt {`,
    `  color: var(--htmlslide-muted);`,
    `  font-size: 22px;`,
    `  font-weight: 700;`,
    `}`,
    ``,
    `dd {`,
    `  margin: 8px 0 0;`,
    `  font-size: 31px;`,
    `  font-weight: 760;`,
    `}`,
    ``,
    `.workflow-list {`,
    `  display: grid;`,
    `  grid-template-columns: repeat(5, minmax(0, 1fr));`,
    `  gap: 18px;`,
    `  margin: 18px 0 0;`,
    `  padding: 0;`,
    `  list-style: none;`,
    `}`,
    ``,
    `.workflow-list li {`,
    `  min-height: 330px;`,
    `  border-top: 8px solid var(--htmlslide-accent);`,
    `  border-radius: 8px;`,
    `  background: var(--htmlslide-panel);`,
    `  padding: 24px;`,
    `}`,
    ``,
    `.workflow-list strong {`,
    `  display: block;`,
    `  margin-bottom: 28px;`,
    `  font-size: 31px;`,
    `}`,
    ``,
    `.workflow-list span,`,
    `.review-grid p {`,
    `  display: block;`,
    `  color: var(--htmlslide-muted);`,
    `  font-size: 25px;`,
    `  line-height: 1.35;`,
    `}`,
    ``,
    `.review-grid {`,
    `  max-width: 1260px;`,
    `}`,
    ``,
    `.review-grid h3 {`,
    `  margin-bottom: 14px;`,
    `  font-size: 34px;`,
    `}`
  ].join("\n")}\n`;
};

const buildThemeTokens = (direction: VisualDirection): JsonObject => ({
  schemaVersion: DECK_SCHEMA_VERSION,
  direction: {
    id: direction.id,
    label: direction.label,
    rationale: direction.rationale
  },
  colors: {
    background: tokenString(direction.tokens, "background", "#fbfbfd"),
    text: tokenString(direction.tokens, "text", "#171923"),
    accent: tokenString(direction.tokens, "accent", "#2357d9"),
    panel: "#ffffff",
    line: "#d9e0ea",
    muted: "#5f6b7a"
  },
  typography: {
    family: "Inter, ui-sans-serif, system-ui, sans-serif",
    h1Px: 96,
    h2Px: 72,
    bodyPx: 25
  },
  layout: {
    viewport: {
      width: 1920,
      height: 1080
    },
    safeArea: {
      top: 72,
      right: 96,
      bottom: 72,
      left: 96
    },
    cardRadiusPx: 8
  }
});

const tokenString = (tokens: JsonObject, key: string, fallback: string): string => {
  const value = tokens[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
};

const cleanInlineText = (value: string): string => {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean.slice(0, 240) : "Create a short mock HTMLslide deck.";
};

const markdownInline = (value: string): string => cleanInlineText(value).replaceAll("|", "\\|");

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const slugDeckId = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug.length > 0 && /^[a-z0-9]/.test(slug) ? slug : "mock_htmlslide_deck";
};

const stableJson = (value: JsonValue): string => JSON.stringify(sortJson(value), null, 2);

const sortJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJson(nestedValue)])
  );
};
