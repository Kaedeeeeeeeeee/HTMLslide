import path from "node:path";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export class ProjectPathError extends Error {
  readonly code = "INVALID_PROJECT_PATH";

  constructor(
    message: string,
    readonly projectPath: string
  ) {
    super(message);
    this.name = "ProjectPathError";
  }
}

export function normalizeDeckPath(projectPath: string): string {
  const trimmed = projectPath.trim();

  if (trimmed.length === 0) {
    throw new ProjectPathError("Deck paths must not be empty.", projectPath);
  }

  if (trimmed.includes("\\")) {
    throw new ProjectPathError("Deck paths must use POSIX '/' separators.", projectPath);
  }

  if (URL_SCHEME_PATTERN.test(trimmed)) {
    throw new ProjectPathError("Deck paths must be local project-relative paths, not URLs.", projectPath);
  }

  if (path.posix.isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    throw new ProjectPathError("Deck paths must be relative to the project root.", projectPath);
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ProjectPathError("Deck paths must not contain empty, '.', or '..' segments.", projectPath);
  }

  if (segments[0] === "exports") {
    throw new ProjectPathError("Deck source paths must not point into exports/.", projectPath);
  }

  return segments.join("/");
}

export function isDeckPathSafe(projectPath: string): boolean {
  try {
    normalizeDeckPath(projectPath);
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectRelativePath(projectRoot: string, projectPath: string): string {
  const normalizedPath = normalizeDeckPath(projectPath);
  const absoluteRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(absoluteRoot, normalizedPath);

  if (!isPathInside(absoluteRoot, resolvedPath)) {
    throw new ProjectPathError("Resolved path escapes the project root.", projectPath);
  }

  return resolvedPath;
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
