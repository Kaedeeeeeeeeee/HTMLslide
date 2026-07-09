import type { Deck } from "./deck-schema.js";
import { DECK_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "./version.js";

export type DeckTemplateId = "default";

export type DeckTemplateSummary = {
  id: DeckTemplateId;
  name: string;
  summary: string;
  description: string;
  tags: string[];
  slideCount: number;
};

export type DeckTemplateFile = {
  path: string;
  contents: string;
};

export type RenderDeckTemplateInput = {
  name: string;
  templateId?: string;
};

export type RenderedDeckTemplate = {
  template: DeckTemplateSummary;
  manifest: Deck;
  files: DeckTemplateFile[];
};

export const DEFAULT_DECK_TEMPLATE_ID: DeckTemplateId = "default";

const defaultTemplate: DeckTemplateSummary = {
  id: DEFAULT_DECK_TEMPLATE_ID,
  name: "Default",
  summary: "Two-slide local-first project",
  description: "A compact HTML/PDF deck starter with title, workflow, notes, theme tokens, and agent rules.",
  tags: ["General", "Agent-ready", "PDF export"],
  slideCount: 2
};

export const BUILT_IN_DECK_TEMPLATES = [defaultTemplate] as const;

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled-deck";

const titleFromName = (name: string): string =>
  name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function listBuiltInDeckTemplates(): DeckTemplateSummary[] {
  return BUILT_IN_DECK_TEMPLATES.map((template) => ({ ...template, tags: [...template.tags] }));
}

export function getBuiltInDeckTemplate(templateId: string = DEFAULT_DECK_TEMPLATE_ID): DeckTemplateSummary {
  const template = BUILT_IN_DECK_TEMPLATES.find((item) => item.id === templateId);
  if (!template) {
    throw new Error(`Unknown deck template: ${templateId}`);
  }
  return { ...template, tags: [...template.tags] };
}

export function renderBuiltInDeckTemplate(input: RenderDeckTemplateInput): RenderedDeckTemplate {
  const template = getBuiltInDeckTemplate(input.templateId ?? DEFAULT_DECK_TEMPLATE_ID);
  const manifest = defaultManifest(input.name);
  return {
    files: buildDefaultTemplateFiles(manifest),
    manifest,
    template
  };
}

const defaultManifest = (name: string): Deck => {
  const deckId = `deck_${slug(name).replaceAll("-", "_")}`;
  const manifest = {
    schemaVersion: DECK_SCHEMA_VERSION,
    appVersion: HTMLSLIDE_APP_VERSION,
    id: deckId,
    title: titleFromName(name),
    language: "en",
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
    slides: [
      {
        id: "001-title",
        title: "HTML as source, PDF as artifact",
        source: "slides/001-title.html",
        notes: "notes/001-title.md",
        durationSec: 60,
        kind: "title",
        status: "draft"
      },
      {
        id: "002-workflow",
        title: "A local-first compiler loop for agents",
        source: "slides/002-workflow.html",
        notes: "notes/002-workflow.md",
        durationSec: 90,
        kind: "content",
        status: "draft"
      }
    ],
    export: {
      pdf: true,
      html: true,
      deckpkg: true,
      thumbnails: true,
      speakerNotes: true
    },
    agent: {
      preferredEngine: "htmlslide-mock",
      lastRunId: null
    }
  } satisfies Deck;
  return manifest;
};

const themeCss = `:root {
  --slide-bg: #fbfbfd;
  --slide-text: #16181f;
  --slide-muted: #626977;
  --slide-accent: #2357d9;
}
.slide {
  padding: 96px;
  background:
    linear-gradient(120deg, rgba(35, 87, 217, 0.08), transparent 42%),
    var(--slide-bg);
  color: var(--slide-text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.eyebrow {
  color: var(--slide-accent);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0;
  margin-bottom: 38px;
}
h1 {
  max-width: 1180px;
  margin: 0;
  font-size: 104px;
  line-height: 0.96;
  letter-spacing: 0;
}
.subtitle {
  max-width: 920px;
  margin-top: 44px;
  color: var(--slide-muted);
  font-size: 38px;
  line-height: 1.35;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 28px;
  margin-top: 68px;
}
.panel {
  border: 1px solid #d8dce5;
  border-radius: 8px;
  padding: 30px;
  background: rgba(255, 255, 255, 0.76);
}
.panel strong {
  display: block;
  margin-bottom: 14px;
  font-size: 34px;
}
.panel span {
  color: var(--slide-muted);
  font-size: 24px;
  line-height: 1.35;
}
`;

const slideSources: Record<string, string> = {
  "001-title": `<section class="slide title-slide" data-slide-id="001-title">
  <div class="eyebrow">Agent-native presentations</div>
  <h1>HTML as source, PDF as artifact</h1>
  <p class="subtitle">A local-first build pipeline for generating, checking, exporting, and presenting slide decks.</p>
</section>
`,
  "002-workflow": `<section class="slide workflow-slide" data-slide-id="002-workflow">
  <div class="eyebrow">Compiler loop</div>
  <h1>A shared path for humans and agents</h1>
  <div class="grid">
    <div class="panel"><strong>Source</strong><span>Slides, notes, theme tokens, and assets stay in project files.</span></div>
    <div class="panel"><strong>Check</strong><span>HTMLslide reports schema, source, notes, and export issues as JSON.</span></div>
    <div class="panel"><strong>Artifact</strong><span>PDF, HTML, thumbnails, and deckpkg are generated outputs.</span></div>
  </div>
</section>
`
};

const notesSources: Record<string, string> = {
  "001-title": `# 001-title

Opening:
- Frame the deck as a source-first workflow.
- Emphasize that PDF and deckpkg are generated artifacts.

Timing: 60s
`,
  "002-workflow": `# 002-workflow

Key points:
- Agents edit project source files.
- HTMLslide checks source quality before export.
- Generated artifacts stay reproducible.

Timing: 90s
`
};

const buildDefaultTemplateFiles = (manifest: Deck): DeckTemplateFile[] => {
  const files: DeckTemplateFile[] = [
    {
      path: "deck.json",
      contents: `${JSON.stringify(manifest, null, 2)}\n`
    },
    {
      path: "theme/theme.css",
      contents: themeCss
    },
    {
      path: "theme/tokens.json",
      contents: `${JSON.stringify(
        {
          background: "#fbfbfd",
          text: "#16181f",
          muted: "#626977",
          accent: "#2357d9",
          safeArea: manifest.safeArea
        },
        null,
        2
      )}\n`
    },
    {
      path: "README.md",
      contents: `# ${manifest.title}\n\nCreated with HTMLslide from the ${defaultTemplate.name} template.\n`
    },
    {
      path: "AGENTS.md",
      contents: `# Deck Agent Rules

- Edit source files under slides/, notes/, theme/, assets/.
- Do not edit exports/ directly.
- Keep data-slide-id aligned with deck.json.
- Run htmlslide check --json after edits.
`
    }
  ];

  for (const slide of manifest.slides) {
    files.push({
      path: slide.source,
      contents: slideSources[slide.id] ?? ""
    });
    if (slide.notes) {
      files.push({
        path: slide.notes,
        contents: notesSources[slide.id] ?? `# ${slide.id}\n`
      });
    }
  }

  return files;
};
