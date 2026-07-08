import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockEngines } from "@htmlslide/agent";
import { exportDeck, type CompilerProjectInput } from "@htmlslide/compiler";
import { parseDeck, type Deck } from "@htmlslide/core";
import { checkProject, type CheckReport } from "@htmlslide/linter";

export const EXIT_CODES = {
  success: 0,
  generic: 1,
  validationFailed: 2,
  exportFailed: 3,
  missingDependency: 4,
  permissionDenied: 5,
  agentFailed: 6,
  projectNotFound: 7,
  incompatibleSchema: 8
} as const;

export type LoadedProject = {
  projectPath: string;
  manifest: Deck;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

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

const defaultManifest = (name: string): Deck => {
  const deckId = `deck_${slug(name).replaceAll("-", "_")}`;
  return parseDeck({
    schemaVersion: "0.1.0",
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
  });
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
HTMLslide treats HTML as source and PDF as the stable artifact.

Key points:
- Project files remain readable.
- Agents can make precise source edits.
- The app owns checking, exporting, and presentation.

Timing: 60s
`,
  "002-workflow": `# 002-workflow

Key points:
- Humans review intent and quality.
- Agents edit local project files.
- The compiler produces deterministic artifacts.

Timing: 90s
`
};

const ensureProjectDirs = async (projectPath: string): Promise<void> => {
  await Promise.all([
    mkdir(path.join(projectPath, "slides"), { recursive: true }),
    mkdir(path.join(projectPath, "notes"), { recursive: true }),
    mkdir(path.join(projectPath, "theme"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "images"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "fonts"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "data"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "cache"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "checkpoints"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "logs"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "reports"), { recursive: true })
  ]);
};

export const createProject = async (projectPath: string, name: string): Promise<LoadedProject> => {
  const resolvedProjectPath = path.resolve(projectPath);
  await mkdir(resolvedProjectPath, { recursive: true });
  const deckPath = path.join(resolvedProjectPath, "deck.json");
  if (await exists(deckPath)) {
    throw new Error(`deck.json already exists at ${deckPath}`);
  }

  const manifest = defaultManifest(name);
  await ensureProjectDirs(resolvedProjectPath);
  await writeFile(deckPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(resolvedProjectPath, "theme", "theme.css"), themeCss);
  await writeFile(
    path.join(resolvedProjectPath, "theme", "tokens.json"),
    `${JSON.stringify(
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
  );
  await writeFile(path.join(resolvedProjectPath, "README.md"), `# ${manifest.title}\n\nCreated with HTMLslide.\n`);
  await writeFile(
    path.join(resolvedProjectPath, "AGENTS.md"),
    `# Deck Agent Rules

- Edit source files under slides/, notes/, theme/, assets/.
- Do not edit exports/ directly.
- Keep data-slide-id aligned with deck.json.
- Run htmlslide check --json after edits.
`
  );

  for (const slide of manifest.slides) {
    await writeFile(path.join(resolvedProjectPath, slide.source), slideSources[slide.id] ?? "");
    if (slide.notes) {
      await writeFile(path.join(resolvedProjectPath, slide.notes), notesSources[slide.id] ?? `# ${slide.id}\n`);
    }
  }

  return { projectPath: resolvedProjectPath, manifest };
};

export const loadProject = async (projectPath = process.cwd()): Promise<LoadedProject> => {
  const resolvedPath = path.resolve(projectPath);
  const deckPath = path.join(resolvedPath, "deck.json");
  if (!(await exists(deckPath))) {
    throw Object.assign(new Error(`No deck.json found at ${deckPath}`), {
      exitCode: EXIT_CODES.projectNotFound
    });
  }
  let manifest: Deck;
  try {
    manifest = parseDeck(JSON.parse(await readFile(deckPath, "utf8")));
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      exitCode: EXIT_CODES.validationFailed
    });
  }
  return { projectPath: resolvedPath, manifest };
};

const toCompilerInput = (project: LoadedProject): CompilerProjectInput => ({
  projectPath: project.projectPath,
  title: project.manifest.title,
  language: project.manifest.language,
  viewport: project.manifest.viewport,
  safeArea: project.manifest.safeArea,
  themeCssPath: project.manifest.theme?.css,
  slides: project.manifest.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    sourcePath: slide.source,
    notesPath: slide.notes,
    durationSec: slide.durationSec
  }))
});

export const checkLoadedProject = async (project: LoadedProject): Promise<CheckReport> =>
  checkProject({
    projectPath: project.projectPath,
    writeReport: true,
    slides: project.manifest.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes
    }))
  });

export const exportLoadedProject = async (project: LoadedProject) => exportDeck(toCompilerInput(project));

export const doctor = () => ({
  status: "passed" as const,
  app: "HTMLslide",
  version: "0.1.0",
  checks: [
    {
      id: "node",
      status: "passed",
      message: `Node.js ${process.version}`
    },
    {
      id: "filesystem",
      status: "passed",
      message: "Local filesystem access available"
    },
    {
      id: "ai",
      status: "info",
      message: "No AI provider is required for No AI mode"
    }
  ]
});

export const listAgentEngines = () => mockEngines;
