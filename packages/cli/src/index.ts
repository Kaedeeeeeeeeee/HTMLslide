import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMockAgentProject,
  createFileCopyCheckpoint,
  createMockProvider,
  diffFileCopyCheckpoint,
  mockEngines,
  recordCheckpointChanges,
  revertFileCopyCheckpoint,
  runAgent,
  type AgentRunResult,
  type ApplyMockAgentProjectResult,
  type FileCopyCheckpointDiff,
  type FileCopyCheckpointRevertResult
} from "@htmlslide/agent";
import { exportDeck, type CompilerProjectInput, type ExportOptions } from "@htmlslide/compiler";
import { loadDeckProject, parseDeck, ProjectLoadError, type Deck, type LoadedDeckProject } from "@htmlslide/core";
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

export type ProjectLoadResult =
  | {
      ok: true;
      project: LoadedProject;
    }
  | {
      ok: false;
      exitCode: number;
      report: CheckReport;
    };

export type AgentRunCliOptions = {
  engine: string;
  task: string;
  projectPath?: string;
};

export type AgentRunCliResult = AgentRunResult & {
  applied?: ApplyMockAgentProjectResult;
};

export type CheckpointCliOptions = {
  projectPath?: string;
  runId?: string;
  checkpointId?: string;
};

export type CliShimTargetOptions = {
  targetDir?: string;
  targetPath?: string;
  htmlslideHomeDir?: string;
};

export type CliShimInstallOptions = CliShimTargetOptions & {
  appPath?: string;
  fallbackCliPath?: string;
};

export type CliShimResult = {
  status: "passed";
  command: "setup install-cli" | "setup uninstall-cli";
  action: "installed" | "updated" | "removed" | "unchanged";
  targetPath: string;
  targetDir: string;
  htmlslideHomeDir: string;
  appPathJson?: string;
  message: string;
};

export type CliShimStatus = {
  status: "passed" | "info" | "warning" | "failed";
  installed: boolean;
  managed: boolean;
  targetPath: string;
  targetDir: string;
  htmlslideHomeDir: string;
  onPath: boolean;
  message: string;
  suggestedFix?: string;
};

const HTMLSLIDE_SHIM_MARKER = "HTMLslide managed CLI shim v1";
const HTMLSLIDE_HOME_ENV = "HTMLSLIDE_HOME";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const setupError = (
  code: string,
  message: string,
  exitCode: number,
  suggestedFix: string,
  extra?: Record<string, unknown>
): Error =>
  Object.assign(new Error(message), {
    code,
    exitCode,
    suggestedFix,
    ...extra
  });

const resolveHtmlslideHomeDir = (htmlslideHomeDir?: string): string =>
  path.resolve(htmlslideHomeDir ?? process.env[HTMLSLIDE_HOME_ENV] ?? path.join(os.homedir(), ".htmlslide"));

const resolveCliShimTarget = (options: CliShimTargetOptions = {}) => {
  if (options.targetDir && options.targetPath) {
    throw setupError(
      "CLI_TARGET_AMBIGUOUS",
      "Pass either --target-dir or --target-path, not both.",
      EXIT_CODES.generic,
      "Choose a target directory for htmlslide or a complete target path."
    );
  }

  const htmlslideHomeDir = resolveHtmlslideHomeDir(options.htmlslideHomeDir);
  const targetPath = options.targetPath
    ? path.resolve(options.targetPath)
    : path.join(options.targetDir ? path.resolve(options.targetDir) : path.join(htmlslideHomeDir, "bin"), "htmlslide");

  return {
    targetPath,
    targetDir: path.dirname(targetPath),
    htmlslideHomeDir,
    explicit: Boolean(options.targetDir || options.targetPath)
  };
};

const defaultFallbackCliPath = (): string => {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const packageRoot = ["src", "dist"].includes(path.basename(moduleDir)) ? path.dirname(moduleDir) : moduleDir;
  return path.join(packageRoot, "dist", "bin", "htmlslide.js");
};

const appPathConfigPath = (htmlslideHomeDir: string): string => path.join(htmlslideHomeDir, "app-path.json");

const readExistingShim = async (
  targetPath: string
): Promise<{ exists: false } | { exists: true; managed: boolean; kind: "file" | "directory" | "symlink" | "other" }> => {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isFile()) {
      return {
        exists: true,
        managed: false,
        kind: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other"
      };
    }

    const content = await readFile(targetPath, "utf8");
    return {
      exists: true,
      managed: content.includes(HTMLSLIDE_SHIM_MARKER),
      kind: "file"
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
};

const escapeShimString = (value: string): string => JSON.stringify(value);

const cliShimScript = (fallbackCliPath: string): string => `#!/usr/bin/env node
// ${HTMLSLIDE_SHIM_MARKER}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fallbackCliPath = ${escapeShimString(path.resolve(fallbackCliPath))};

const unique = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];

const readAppPathConfig = () => {
  const htmlslideHomeDir = process.env.HTMLSLIDE_HOME || path.join(os.homedir(), ".htmlslide");
  const configPath = path.join(htmlslideHomeDir, "app-path.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error("HTMLslide CLI shim could not parse " + configPath + ": " + error.message);
    process.exit(4);
  }
};

const appCliCandidates = (config) => {
  const appPath = config && config.appPath ? String(config.appPath) : "";
  return unique([
    config && config.cliPath,
    config && config.cliEntry,
    config && config.appCliPath,
    appPath && path.join(appPath, "Contents", "Resources", "app", "cli-runtime", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "app", "packages", "cli", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "app.asar", "packages", "cli", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "htmlslide", "cli", "htmlslide.js")
  ]);
};

const candidates = unique([...appCliCandidates(readAppPathConfig()), fallbackCliPath]);
const cliPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!cliPath) {
  console.error("HTMLslide CLI shim could not locate the CLI entrypoint.");
  console.error("Run htmlslide setup install-cli from the HTMLslide app, or reinstall the CLI shim.");
  process.exit(4);
}

if (path.resolve(cliPath) === path.resolve(process.argv[1])) {
  console.error("HTMLslide CLI shim resolved to itself. Reinstall the CLI shim with a valid app or development CLI path.");
  process.exit(4);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error("HTMLslide CLI shim failed to start: " + result.error.message);
  process.exit(4);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`;

const ensureWritableDir = async (targetDir: string): Promise<void> => {
  try {
    await mkdir(targetDir, { recursive: true });
    await access(targetDir, fsConstants.W_OK);
  } catch (error) {
    throw setupError(
      "CLI_TARGET_NOT_WRITABLE",
      `Cannot write HTMLslide CLI shim to ${targetDir}.`,
      EXIT_CODES.permissionDenied,
      "Choose a writable target directory, for example ~/.htmlslide/bin, or fix directory permissions.",
      { cause: error, targetDir }
    );
  }
};

export const getCliShimStatus = async (options: CliShimTargetOptions = {}): Promise<CliShimStatus> => {
  const target = resolveCliShimTarget(options);
  const existing = await readExistingShim(target.targetPath);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry || "."));
  const onPath = pathEntries.includes(path.resolve(target.targetDir));

  if (!existing.exists) {
    return {
      status: "info",
      installed: false,
      managed: false,
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      onPath,
      message: `HTMLslide CLI shim is not installed at ${target.targetPath}.`,
      suggestedFix: "Run htmlslide setup install-cli."
    };
  }

  if (!existing.managed) {
    return {
      status: "failed",
      installed: true,
      managed: false,
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      onPath,
      message: `${target.targetPath} exists but is not an HTMLslide-managed shim.`,
      suggestedFix: "Choose another --target-path or remove the unrelated command manually."
    };
  }

  return {
    status: onPath ? "passed" : "warning",
    installed: true,
    managed: true,
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    onPath,
    message: onPath
      ? `HTMLslide CLI shim is installed at ${target.targetPath}.`
      : `HTMLslide CLI shim is installed at ${target.targetPath}, but ${target.targetDir} is not on PATH.`,
    suggestedFix: onPath ? undefined : `Add ${target.targetDir} to PATH.`
  };
};

export const installCliShim = async (options: CliShimInstallOptions = {}): Promise<CliShimResult> => {
  const target = resolveCliShimTarget(options);
  await ensureWritableDir(target.targetDir);

  const existing = await readExistingShim(target.targetPath);
  if (existing.exists && !existing.managed) {
    throw setupError(
      "CLI_SHIM_CONFLICT",
      `Refusing to overwrite existing non-HTMLslide command at ${target.targetPath}.`,
      EXIT_CODES.generic,
      "Choose another --target-path or remove the unrelated command manually.",
      { targetPath: target.targetPath }
    );
  }

  let appPathJson: string | undefined;
  if (options.appPath) {
    const appPath = path.resolve(options.appPath);
    appPathJson = appPathConfigPath(target.htmlslideHomeDir);
    await mkdir(path.dirname(appPathJson), { recursive: true });
    await writeFile(appPathJson, `${JSON.stringify({ schemaVersion: 1, appPath }, null, 2)}\n`);
  }

  const fallbackCliPath = options.fallbackCliPath ? path.resolve(options.fallbackCliPath) : defaultFallbackCliPath();
  const temporaryPath = path.join(target.targetDir, `.htmlslide-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporaryPath, cliShimScript(fallbackCliPath), { mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, target.targetPath);

  const action = existing.exists ? "updated" : "installed";
  return {
    status: "passed",
    command: "setup install-cli",
    action,
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    appPathJson,
    message: `${action === "installed" ? "Installed" : "Updated"} HTMLslide CLI shim at ${target.targetPath}.`
  };
};

export const uninstallCliShim = async (options: CliShimTargetOptions = {}): Promise<CliShimResult> => {
  const target = resolveCliShimTarget(options);
  const existing = await readExistingShim(target.targetPath);

  if (!existing.exists) {
    return {
      status: "passed",
      command: "setup uninstall-cli",
      action: "unchanged",
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      message: `No HTMLslide CLI shim was installed at ${target.targetPath}.`
    };
  }

  if (!existing.managed) {
    throw setupError(
      "CLI_SHIM_CONFLICT",
      `Refusing to remove existing non-HTMLslide command at ${target.targetPath}.`,
      EXIT_CODES.generic,
      "Choose the correct --target-path or remove the unrelated command manually.",
      { targetPath: target.targetPath }
    );
  }

  await rm(target.targetPath);
  return {
    status: "passed",
    command: "setup uninstall-cli",
    action: "removed",
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    message: `Removed HTMLslide CLI shim from ${target.targetPath}.`
  };
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
  try {
    const project = await loadDeckProject(projectPath, { verifyFiles: false });
    return fromCoreProject(project);
  } catch (error) {
    if (error instanceof ProjectLoadError) {
      throw Object.assign(error, {
        exitCode: error.code === "PROJECT_NOT_FOUND" ? EXIT_CODES.projectNotFound : EXIT_CODES.validationFailed
      });
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      exitCode: EXIT_CODES.validationFailed
    });
  }
};

export const tryLoadProjectForCheck = async (projectPath = process.cwd()): Promise<ProjectLoadResult> => {
  try {
    return {
      ok: true,
      project: await loadProject(projectPath)
    };
  } catch (error) {
    if (error instanceof ProjectLoadError) {
      const report: CheckReport = {
        status: "failed",
        projectPath: path.resolve(projectPath),
        summary: {
          errors: Math.max(error.issues.length, 1),
          warnings: 0,
          suggestions: 0,
          info: 0
        },
        issues:
          error.issues.length > 0
            ? error.issues.map((issue) => ({
                slideId: issue.slideId ?? "deck",
                severity: "error",
                type: "missing-slide-source",
                message: issue.message,
                suggestedFix: issue.suggestedFix ?? "Fix the project manifest and rerun htmlslide check.",
                agentInstruction:
                  issue.suggestedFix ?? "Inspect deck.json and referenced source files, then fix the reported load error."
              }))
            : [
                {
                  slideId: "deck",
                  severity: "error",
                  type: "missing-slide-source",
                  message: error.message,
                  suggestedFix: "Run htmlslide from a deck project or pass a path containing deck.json.",
                  agentInstruction: "Locate the deck project root before running check or export."
                }
              ]
      };
      return {
        ok: false,
        exitCode: error.code === "PROJECT_NOT_FOUND" ? EXIT_CODES.projectNotFound : EXIT_CODES.validationFailed,
        report
      };
    }
    throw error;
  }
};

const fromCoreProject = (project: LoadedDeckProject): LoadedProject => ({
  projectPath: project.projectRoot,
  manifest: project.deck
});

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

export const exportLoadedProject = async (project: LoadedProject, options?: ExportOptions) =>
  exportDeck(toCompilerInput(project), options);

export const doctor = async (options: CliShimTargetOptions = {}) => {
  const cliShim = await getCliShimStatus(options);

  return {
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
        id: "cli-shim",
        status: cliShim.status,
        message: cliShim.message,
        targetPath: cliShim.targetPath,
        suggestedFix: cliShim.suggestedFix
      },
      {
        id: "ai",
        status: "info",
        message: "No AI provider is required for No AI mode"
      }
    ]
  };
};

export const listAgentEngines = () => mockEngines;

const agentError = (
  code: string,
  message: string,
  suggestedFix: string,
  extra?: Record<string, unknown>
): Error =>
  Object.assign(new Error(message), {
    code,
    exitCode: EXIT_CODES.agentFailed,
    suggestedFix,
    ...extra
  });

const deterministicAgentClock = () => new Date("2026-01-01T00:00:00.000Z");

export const runAgentTask = async (options: AgentRunCliOptions): Promise<AgentRunCliResult> => {
  const engine = mockEngines.find((candidate) => candidate.id === options.engine);
  if (engine === undefined) {
    throw agentError(
      "AGENT_ENGINE_NOT_FOUND",
      `Unknown agent engine: ${options.engine}.`,
      "Run htmlslide agent engines --json and pass one of the listed engine ids.",
      { engine: options.engine }
    );
  }

  if (engine.id !== "htmlslide-mock") {
    throw agentError(
      "AGENT_ENGINE_UNAVAILABLE",
      `Agent engine ${engine.id} is not available from the CLI yet.`,
      "Use --engine htmlslide-mock for deterministic local test runs.",
      { engine: engine.id }
    );
  }

  const projectPath = path.resolve(options.projectPath ?? process.cwd());
  const result = await runAgent(
    {
      projectRoot: projectPath,
      brief: options.task,
      provider: createMockProvider(),
      createCheckpoint: createFileCopyCheckpoint
    },
    {
      clock: deterministicAgentClock
    }
  );

  if (!result.ok) {
    return result;
  }

  const applied = await applyMockAgentProject({
    brief: options.task,
    projectPath,
    result
  });
  const checkpoint = await recordCheckpointChanges({
    projectRoot: projectPath,
    runId: result.runId,
    filesChanged: applied.filesChanged,
    recordedAt: deterministicAgentClock().toISOString()
  });

  return {
    ...result,
    checkpoint,
    applied
  };
};

export const diffCheckpoint = async (options: CheckpointCliOptions): Promise<FileCopyCheckpointDiff> =>
  diffFileCopyCheckpoint({
    projectRoot: path.resolve(options.projectPath ?? process.cwd()),
    runId: options.runId,
    checkpointId: options.checkpointId
  });

export const revertCheckpoint = async (options: CheckpointCliOptions): Promise<FileCopyCheckpointRevertResult> =>
  revertFileCopyCheckpoint({
    projectRoot: path.resolve(options.projectPath ?? process.cwd()),
    runId: options.runId,
    checkpointId: options.checkpointId
  });
