import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentOutline,
  AgentOutlineSlide,
  AgentRunSucceededResult,
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
const slidePaths = ["slides/001-title.html", "slides/002-workflow.html", "slides/003-review.html"] as const;
const notePaths = ["notes/001-title.md", "notes/002-workflow.md", "notes/003-review.md"] as const;
const themePaths = ["theme/theme.css", "theme/tokens.json"] as const;

const filesChanged = [deckPath, ...slidePaths, ...notePaths, ...themePaths] as const;

const expectedSlideIds = ["001-title", "002-workflow", "003-review"] as const;

const slideFileSpecs = [
  { id: "001-title", source: "slides/001-title.html", notes: "notes/001-title.md" },
  { id: "002-workflow", source: "slides/002-workflow.html", notes: "notes/002-workflow.md" },
  { id: "003-review", source: "slides/003-review.html", notes: "notes/003-review.md" }
] as const;

type ApplicableMockAgentRunResult = AgentRunSucceededResult & {
  outputs: AgentRunSucceededResult["outputs"] & {
    build: AgentBuildResult;
    checks: AgentCheckResult[];
    outline: AgentOutline;
    visualDirection: VisualDirectionSet;
  };
};

const fallbackSlides: Record<
  (typeof expectedSlideIds)[number],
  Pick<AgentOutlineSlide, "id" | "title" | "kind" | "goal">
> = {
  "001-title": {
    id: "001-title",
    title: "HTMLslide mock deck",
    kind: "title",
    goal: "Introduce the deck promise and project constraints."
  },
  "002-workflow": {
    id: "002-workflow",
    title: "Controlled agent workflow",
    kind: "content",
    goal: "Show the brief, outline, visual direction, build, check, repair, export, review loop."
  },
  "003-review": {
    id: "003-review",
    title: "Reviewable outputs",
    kind: "closing",
    goal: "Summarize files, checks, exports, and next actions."
  }
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
  const title = brief?.title ?? outline.title;
  const language = brief?.language ?? outline.language;
  const briefText = cleanInlineText(input.brief ?? brief?.brief ?? "Create a short mock HTMLslide deck.");
  const slides = slideFileSpecs.map((spec) => {
    const outlineSlide = outline.slides.find((slide) => slide.id === spec.id) ?? fallbackSlides[spec.id];
    return {
      ...outlineSlide,
      source: spec.source,
      notes: spec.notes
    };
  });

  const writes: Array<{ path: string; content: string }> = [
    {
      path: deckPath,
      content: `${stableJson(buildDeckJson({ title, language, runId: input.result.runId, slides }))}\n`
    },
    {
      path: "slides/001-title.html",
      content: buildTitleSlide({ title, brief, direction: selectedDirection })
    },
    {
      path: "slides/002-workflow.html",
      content: buildWorkflowSlide({ slides, direction: selectedDirection })
    },
    {
      path: "slides/003-review.html",
      content: buildReviewSlide({ title, direction: selectedDirection })
    },
    {
      path: "notes/001-title.md",
      content: buildTitleNotes({ title, briefText, slide: slides[0] })
    },
    {
      path: "notes/002-workflow.md",
      content: buildWorkflowNotes({ briefText, slide: slides[1] })
    },
    {
      path: "notes/003-review.md",
      content: buildReviewNotes({ slide: slides[2] })
    },
    {
      path: "theme/theme.css",
      content: buildThemeCss(selectedDirection)
    },
    {
      path: "theme/tokens.json",
      content: `${stableJson(buildThemeTokens(selectedDirection))}\n`
    }
  ];

  for (const write of writes) {
    const absolutePath = resolveProjectPath(projectPath, write.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, write.content, "utf8");
  }

  const appliedSlides: AppliedMockAgentProjectSlide[] = slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    source: slide.source,
    notes: slide.notes
  }));

  return {
    projectPath,
    title,
    language,
    selectedVisualDirectionId: selectedDirection.id,
    filesChanged: [...filesChanged],
    slideIds: [...expectedSlideIds],
    slides: appliedSlides,
    paths: {
      deck: deckPath,
      slides: [...slidePaths],
      notes: [...notePaths],
      theme: [...themePaths]
    }
  };
};

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
  const missingSlide = expectedSlideIds.find((slideId) => !changedSlides.has(slideId));
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
  slides: Array<AgentOutlineSlide & { source: string; notes: string }>;
}): JsonObject => ({
  schemaVersion: "0.1.0",
  appVersion: "0.1.0",
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
    notes: slide.notes,
    durationSec: index === 1 ? 120 : 75,
    kind: slide.kind,
    status: "ready"
  })),
  export: {
    pdf: true,
    html: true,
    deckpkg: true,
    thumbnails: true,
    speakerNotes: true
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
}): string => `${[
  `<section class="slide title-slide" data-slide-id="001-title">`,
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
  slides: Array<AgentOutlineSlide & { source: string; notes: string }>;
  direction: VisualDirection;
}): string => `${[
  `<section class="slide workflow-slide" data-slide-id="002-workflow">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">Controlled workflow</p>`,
  `    <h2>${escapeHtml(input.slides[1]?.title ?? fallbackSlides["002-workflow"].title)}</h2>`,
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

const buildReviewSlide = (input: { title: string; direction: VisualDirection }): string => `${[
  `<section class="slide review-slide" data-slide-id="003-review">`,
  `  <div class="safe-area">`,
  `    <p class="eyebrow">Reviewable outputs</p>`,
  `    <h2>Ready for local check and export</h2>`,
  `    <div class="review-grid">`,
  `      <article><h3>Sources</h3><p>Manifest, slide fragments, speaker notes, CSS, and tokens are project-local.</p></article>`,
  `      <article><h3>Identity</h3><p>The three slide ids match their data-slide-id attributes.</p></article>`,
  `      <article><h3>Theme</h3><p>${escapeHtml(input.direction.label)} keeps ${escapeHtml(input.title)} consistent offline.</p></article>`,
  `    </div>`,
  `  </div>`,
  `</section>`
].join("\n")}\n`;

const buildTitleNotes = (input: {
  title: string;
  briefText: string;
  slide?: AgentOutlineSlide;
}): string => `${[
  `# 001-title`,
  ``,
  `Open by naming "${markdownInline(input.title)}" as a deterministic mock deck. State that this run proves the agent can turn abstract build output into editable HTMLslide source files.`,
  ``,
  `Brief context: ${markdownInline(input.briefText)}`,
  ``,
  `Presenter cue: ${markdownInline(input.slide?.goal ?? fallbackSlides["001-title"].goal)}`,
  ``,
  `Timing: 75s`
].join("\n")}\n`;

const buildWorkflowNotes = (input: { briefText: string; slide?: AgentOutlineSlide }): string => `${[
  `# 002-workflow`,
  ``,
  `Walk through the pipeline from brief to review. Emphasize that each stage produces structured output before the source writer touches deck.json, slide fragments, notes, or theme files.`,
  ``,
  `Call out the safety contract: paths stay project-relative, remote resources are avoided, and generated notes remain clear enough for a reviewer to rehearse the deck.`,
  ``,
  `Brief context: ${markdownInline(input.briefText)}`,
  ``,
  `Presenter cue: ${markdownInline(input.slide?.goal ?? fallbackSlides["002-workflow"].goal)}`,
  ``,
  `Timing: 120s`
].join("\n")}\n`;

const buildReviewNotes = (input: { slide?: AgentOutlineSlide }): string => `${[
  `# 003-review`,
  ``,
  `Close by summarizing the concrete files that changed and the checks a human reviewer should run next. The important point is that exports remain artifacts, while this module writes only source areas.`,
  ``,
  `Mention that deck.json references every slide and note with POSIX project-relative paths. The theme is local CSS plus JSON tokens, so export can run without downloading fonts, scripts, or images.`,
  ``,
  `Presenter cue: ${markdownInline(input.slide?.goal ?? fallbackSlides["003-review"].goal)}`,
  ``,
  `Timing: 75s`
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
  schemaVersion: "0.1.0",
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

const resolveProjectPath = (projectPath: string, projectRelativePath: string): string => {
  assertSafeProjectRelativePath(projectRelativePath);
  const absolutePath = path.resolve(projectPath, ...projectRelativePath.split("/"));
  const relative = path.relative(projectPath, absolutePath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the project: ${projectRelativePath}`);
  }

  return absolutePath;
};

const assertSafeProjectRelativePath = (projectRelativePath: string): void => {
  if (
    projectRelativePath.length === 0 ||
    projectRelativePath.includes("\\") ||
    projectRelativePath.includes(":") ||
    path.posix.isAbsolute(projectRelativePath)
  ) {
    throw new Error(`Invalid project-relative path: ${projectRelativePath}`);
  }

  const segments = projectRelativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid project-relative path: ${projectRelativePath}`);
  }

  if (segments[0] === "exports") {
    throw new Error(`Refusing to write generated exports: ${projectRelativePath}`);
  }
};

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
