import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type DesktopProjectStatus =
  | "Ready"
  | "Needs check"
  | "Export failed"
  | "Missing files"
  | "External changes detected";

export type DesktopProjectRecord = {
  id: string;
  title: string;
  path: string;
  lastOpenedAt: string;
  status: DesktopProjectStatus;
  slideCount: number;
  thumbnail?: string;
};

export type DesktopLibrary = {
  version: 1;
  defaultWorkspace: string;
  recentProjects: DesktopProjectRecord[];
};

export type DesktopSlidePreview = {
  id: string;
  number: string;
  title: string;
  section: string;
  status: "ready" | "needs-check" | "blocked";
  duration: string;
  accent: string;
  speakerNotes: string;
  bullets: string[];
  sourcePath: string;
  notesPath?: string;
  html: string;
};

export type DesktopProjectPreview = {
  project: DesktopProjectRecord;
  slides: DesktopSlidePreview[];
};

export type CliRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
};

export type CliRunnerOptions = {
  rootPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type DeckManifest = {
  title?: unknown;
  slides?: Array<{
    id?: unknown;
    title?: unknown;
    source?: unknown;
    notes?: unknown;
    durationSec?: unknown;
    kind?: unknown;
    status?: unknown;
  }>;
};

const DEFAULT_LIBRARY: Omit<DesktopLibrary, "defaultWorkspace"> = {
  version: 1,
  recentProjects: []
};

const DEFAULT_ACCENT = "#315fcb";
const DEFAULT_ACCENTS = [DEFAULT_ACCENT, "#267a4f", "#9a6410", "#286a8d", "#7b4ab8", "#bc3a3a"];

export const defaultWorkspacePath = (): string => path.join(os.homedir(), "Documents", "HTMLslide");

export async function readDesktopLibrary(
  libraryPath: string,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  try {
    const contents = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<DesktopLibrary>;
    return {
      version: 1,
      defaultWorkspace:
        typeof parsed.defaultWorkspace === "string" && parsed.defaultWorkspace.length > 0
          ? parsed.defaultWorkspace
          : defaultWorkspace,
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter(isProjectRecord)
        : []
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        ...DEFAULT_LIBRARY,
        defaultWorkspace
      };
    }
    throw error;
  }
}

export async function writeDesktopLibrary(libraryPath: string, library: DesktopLibrary): Promise<void> {
  await fs.mkdir(path.dirname(libraryPath), { recursive: true });
  await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

export async function upsertRecentProject(
  libraryPath: string,
  project: DesktopProjectRecord,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextProjects = [
    project,
    ...library.recentProjects.filter((item) => path.resolve(item.path) !== path.resolve(project.path))
  ].slice(0, 40);
  const nextLibrary = {
    ...library,
    recentProjects: nextProjects
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextLibrary;
}

export async function summarizeDeckProject(projectPath: string): Promise<DesktopProjectRecord> {
  const root = path.resolve(projectPath);
  const manifest = await readDeckManifest(root);
  const title = typeof manifest.title === "string" && manifest.title.length > 0
    ? manifest.title
    : path.basename(root);
  const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
  const missingFiles = await hasMissingSlideFiles(root, manifest);

  return {
    id: `proj_${stableId(root)}`,
    title,
    path: root,
    lastOpenedAt: new Date().toISOString(),
    status: missingFiles ? "Missing files" : "Needs check",
    slideCount: slides.length
  };
}

export async function loadProjectPreview(projectPath: string): Promise<DesktopProjectPreview> {
  const project = await summarizeDeckProject(projectPath);
  const manifest = await readDeckManifest(project.path);
  const slides = await Promise.all(
    (manifest.slides ?? []).map(async (slide, index): Promise<DesktopSlidePreview> => {
      const slideId = typeof slide.id === "string" && slide.id.length > 0 ? slide.id : `slide-${index + 1}`;
      const sourcePath = typeof slide.source === "string" ? slide.source : "";
      const notesPath = typeof slide.notes === "string" ? slide.notes : undefined;
      const html = await readProjectText(project.path, sourcePath);
      const notes = notesPath ? await readProjectText(project.path, notesPath) : "";
      const title = typeof slide.title === "string" && slide.title.length > 0 ? slide.title : slideId;
      const durationSec = typeof slide.durationSec === "number" && Number.isFinite(slide.durationSec)
        ? slide.durationSec
        : 60;

      return {
        id: slideId,
        number: String(index + 1).padStart(2, "0"),
        title,
        section: typeof slide.kind === "string" ? titleCase(slide.kind) : "Content",
        status: slide.status === "ready" || slide.status === "final" ? "ready" : "needs-check",
        duration: formatDuration(durationSec),
        accent: DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length] ?? DEFAULT_ACCENT,
        speakerNotes: notes.trim(),
        bullets: extractBullets(html, title),
        sourcePath,
        notesPath,
        html
      };
    })
  );

  return {
    project,
    slides
  };
}

export async function runHtmlslideCli(args: string[], options: CliRunnerOptions): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const command = process.execPath;
  const commandArgs = [path.join(options.rootPath, "packages", "cli", "dist", "bin", "htmlslide.js"), ...args];
  const cliExists = await pathExists(commandArgs[0] ?? "");

  if (!cliExists) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI build was not found. Run pnpm build before using desktop CLI-backed actions."
    };
  }

  return new Promise<CliRunResult>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.rootPath,
      env: {
        ...process.env,
        ...options.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: 6,
        stdout,
        stderr,
        error: `htmlslide ${args.join(" ")} timed out after ${timeoutMs}ms.`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        json: parseJsonOutput(stdout)
      });
    });
  });
}

export function findRepositoryRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath);
  while (true) {
    if (pathExistsSync(path.join(current, "pnpm-workspace.yaml")) && pathExistsSync(path.join(current, "packages", "cli"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function readDeckManifest(projectPath: string): Promise<DeckManifest> {
  const deckPath = path.join(projectPath, "deck.json");
  const contents = await fs.readFile(deckPath, "utf8");
  return JSON.parse(contents) as DeckManifest;
}

async function hasMissingSlideFiles(projectPath: string, manifest: DeckManifest): Promise<boolean> {
  for (const slide of manifest.slides ?? []) {
    const source = typeof slide.source === "string" ? slide.source : undefined;
    if (!source || !(await pathExists(resolveProjectPath(projectPath, source)))) {
      return true;
    }
    const notes = typeof slide.notes === "string" ? slide.notes : undefined;
    if (notes && !(await pathExists(resolveProjectPath(projectPath, notes)))) {
      return true;
    }
  }
  return false;
}

async function readProjectText(projectPath: string, relativePath: string): Promise<string> {
  if (relativePath.length === 0) {
    return "";
  }
  return fs.readFile(resolveProjectPath(projectPath, relativePath), "utf8");
}

function resolveProjectPath(projectPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  const resolved = path.resolve(projectPath, relativePath);
  const root = path.resolve(projectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  return resolved;
}

function extractBullets(html: string, fallbackTitle: string): string[] {
  const listItems = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);

  if (listItems.length > 0) {
    return listItems;
  }

  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);

  return paragraphs.length > 0 ? paragraphs : [`Review ${fallbackTitle}`];
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function stableId(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function isProjectRecord(value: unknown): value is DesktopProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<DesktopProjectRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.path === "string" &&
    typeof record.lastOpenedAt === "string" &&
    typeof record.slideCount === "number" &&
    typeof record.status === "string"
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
