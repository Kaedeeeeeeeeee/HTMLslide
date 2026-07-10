import { promises as fs } from "node:fs";
import path from "node:path";
import type { Deck, DeckSlide } from "./deck-schema.js";
import { validateDeck } from "./deck-schema.js";
import type { HtmlslideIssue } from "./issues.js";
import { resolveProjectRelativePath } from "./paths.js";
import { DECK_SCHEMA_VERSION } from "./version.js";

export const DECK_FILENAME = "deck.json";

export type ProjectLoadErrorCode =
  | "PROJECT_NOT_FOUND"
  | "DECK_READ_FAILED"
  | "INVALID_JSON"
  | "INCOMPATIBLE_SCHEMA"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "MISSING_PROJECT_FILE";

export interface LoadDeckProjectOptions {
  cwd?: string;
  verifyFiles?: boolean;
}

export interface ResolvedProjectSlide {
  index: number;
  id: string;
  slide: DeckSlide;
  sourcePath: string;
  notesPath?: string;
}

export interface ResolvedProjectTheme {
  cssPath?: string;
  tokensPath?: string;
}

export interface LoadedDeckProject {
  projectRoot: string;
  deckPath: string;
  deck: Deck;
  theme?: ResolvedProjectTheme;
  slides: ResolvedProjectSlide[];
}

export class ProjectLoadError extends Error {
  constructor(
    readonly code: ProjectLoadErrorCode,
    message: string,
    readonly issues: HtmlslideIssue[] = []
  ) {
    super(message);
    this.name = "ProjectLoadError";
  }
}

export async function resolveProjectRoot(inputPath = ".", options: LoadDeckProjectOptions = {}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const startPath = path.resolve(cwd, inputPath);
  let currentPath = await startingDirectoryForProjectSearch(startPath);

  while (true) {
    if (await pathExists(path.join(currentPath, DECK_FILENAME))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new ProjectLoadError("PROJECT_NOT_FOUND", `No ${DECK_FILENAME} found for ${inputPath}.`);
    }

    currentPath = parentPath;
  }
}

export async function loadDeckProject(inputPath = ".", options: LoadDeckProjectOptions = {}): Promise<LoadedDeckProject> {
  const projectRoot = await resolveProjectRoot(inputPath, options);
  const deckPath = path.join(projectRoot, DECK_FILENAME);
  const rawDeck = await readDeckJson(deckPath);
  const deckValue = parseDeckJson(rawDeck, deckPath);
  const validationResult = validateDeck(deckValue);

  if (!validationResult.ok) {
    const code = hasIncompatibleSchemaVersion(deckValue) ? "INCOMPATIBLE_SCHEMA" : "VALIDATION_FAILED";
    throw new ProjectLoadError(code, `${DECK_FILENAME} failed schema validation.`, validationResult.issues);
  }

  const project = resolveDeckProjectPaths(projectRoot, validationResult.deck);

  if (options.verifyFiles !== false) {
    const missingFileIssues = await collectMissingProjectFileIssues(project);
    if (missingFileIssues.length > 0) {
      throw new ProjectLoadError("MISSING_PROJECT_FILE", "Project references files that do not exist.", missingFileIssues);
    }
  }

  return project;
}

function hasIncompatibleSchemaVersion(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const manifest = value as Record<string, unknown>;
  return typeof manifest.schemaVersion === "string" && manifest.schemaVersion !== DECK_SCHEMA_VERSION;
}

export async function tryLoadDeckProject(
  inputPath = ".",
  options: LoadDeckProjectOptions = {}
): Promise<{ ok: true; project: LoadedDeckProject } | { ok: false; error: ProjectLoadError; issues: HtmlslideIssue[] }> {
  try {
    return {
      ok: true,
      project: await loadDeckProject(inputPath, options)
    };
  } catch (error) {
    if (error instanceof ProjectLoadError) {
      return {
        ok: false,
        error,
        issues: error.issues
      };
    }

    throw error;
  }
}

export function resolveDeckProjectPaths(projectRoot: string, deck: Deck): LoadedDeckProject {
  const absoluteProjectRoot = path.resolve(projectRoot);

  return {
    projectRoot: absoluteProjectRoot,
    deckPath: path.join(absoluteProjectRoot, DECK_FILENAME),
    deck,
    theme: deck.theme
      ? {
          cssPath: deck.theme.css ? resolveProjectRelativePath(absoluteProjectRoot, deck.theme.css) : undefined,
          tokensPath: deck.theme.tokens ? resolveProjectRelativePath(absoluteProjectRoot, deck.theme.tokens) : undefined
        }
      : undefined,
    slides: deck.slides.map((slide, index) => ({
      index,
      id: slide.id,
      slide,
      sourcePath: resolveProjectRelativePath(absoluteProjectRoot, slide.source),
      notesPath: slide.notes ? resolveProjectRelativePath(absoluteProjectRoot, slide.notes) : undefined
    }))
  };
}

async function startingDirectoryForProjectSearch(startPath: string): Promise<string> {
  try {
    const stat = await fs.stat(startPath);
    return stat.isDirectory() ? startPath : path.dirname(startPath);
  } catch {
    return path.basename(startPath) === DECK_FILENAME ? path.dirname(startPath) : startPath;
  }
}

async function readDeckJson(deckPath: string): Promise<string> {
  try {
    return await fs.readFile(deckPath, "utf8");
  } catch (error) {
    const message = `Unable to read ${deckPath}: ${formatUnknownError(error)}`;
    const permissionDenied = isPermissionError(error);
    throw new ProjectLoadError(permissionDenied ? "PERMISSION_DENIED" : "DECK_READ_FAILED", message, [
      {
        severity: "error",
        type: permissionDenied ? "permission-denied" : "project-read-failed",
        path: DECK_FILENAME,
        message,
        suggestedFix: permissionDenied
          ? "Grant the current user read permission for deck.json and rerun htmlslide check."
          : "Verify deck.json is a readable file and that the current user has permission to open it."
      }
    ]);
  }
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === "EACCES" || error.code === "EPERM";
}

function parseDeckJson(rawDeck: string, deckPath: string): unknown {
  try {
    return JSON.parse(rawDeck);
  } catch (error) {
    const message = `Unable to parse ${deckPath}: ${formatUnknownError(error)}`;
    throw new ProjectLoadError("INVALID_JSON", message, [
      {
        severity: "error",
        type: "invalid-json",
        path: DECK_FILENAME,
        message,
        suggestedFix: "Fix the JSON syntax in deck.json and rerun htmlslide check."
      }
    ]);
  }
}

async function collectMissingProjectFileIssues(project: LoadedDeckProject): Promise<HtmlslideIssue[]> {
  const checks: Array<{ filePath: string; deckPath: string; slideId?: string; label: string }> = [];

  for (const slide of project.slides) {
    checks.push({
      filePath: slide.sourcePath,
      deckPath: slide.slide.source,
      slideId: slide.id,
      label: "slide source"
    });

    if (slide.notesPath && slide.slide.notes) {
      checks.push({
        filePath: slide.notesPath,
        deckPath: slide.slide.notes,
        slideId: slide.id,
        label: "speaker notes"
      });
    }
  }

  if (project.theme?.cssPath && project.deck.theme?.css) {
    checks.push({
      filePath: project.theme.cssPath,
      deckPath: project.deck.theme.css,
      label: "theme css"
    });
  }

  if (project.theme?.tokensPath && project.deck.theme?.tokens) {
    checks.push({
      filePath: project.theme.tokensPath,
      deckPath: project.deck.theme.tokens,
      label: "theme tokens"
    });
  }

  const issues: HtmlslideIssue[] = [];
  for (const check of checks) {
    if (!(await pathExists(check.filePath))) {
      issues.push({
        severity: "error",
        type: "missing-file",
        path: check.deckPath,
        slideId: check.slideId,
        message: `Missing ${check.label}: ${check.deckPath}.`,
        suggestedFix: `Create ${check.deckPath} or update deck.json to point at an existing project file.`
      });
    }
  }

  return issues;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
