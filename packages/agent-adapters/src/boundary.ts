import path from "node:path";

import { AgentAdapterFailureError, createAgentAdapterFailure } from "./failures.js";

export function resolveProjectPath(projectRoot: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(path.resolve(projectRoot), candidatePath);
}

export function isPathInsideProject(projectRoot: string, candidatePath: string): boolean {
  const root = path.resolve(projectRoot);
  const candidate = resolveProjectPath(root, candidatePath);
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function assertPathInsideProject(projectRoot: string, candidatePath: string, label: string): string {
  const resolvedPath = resolveProjectPath(projectRoot, candidatePath);

  if (!isPathInsideProject(projectRoot, resolvedPath)) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("project-boundary-violation", {
        detail: `${label} must be inside the HTMLslide project.`,
        path: resolvedPath
      })
    );
  }

  return resolvedPath;
}

export function assertProjectRootVariable(projectRoot: string, candidatePath: string, label: string): string {
  const root = path.resolve(projectRoot);
  const candidate = resolveProjectPath(root, candidatePath);

  if (candidate !== root) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("project-boundary-violation", {
        detail: `${label} must resolve to the HTMLslide project root.`,
        path: candidate
      })
    );
  }

  return candidate;
}

export function inferPathVariableNames(variables: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(variables).filter(
    (name) =>
      name === "writeManifest" ||
      name === "manifestFile" ||
      name.endsWith("File") ||
      name.endsWith("Path")
  );
}

export function validateTemplatePathVariables(
  projectRoot: string,
  variables: Readonly<Record<string, string | undefined>>,
  pathVariableNames: readonly string[]
): void {
  for (const variableName of pathVariableNames) {
    const value = variables[variableName];
    if (value === undefined) {
      continue;
    }

    if (variableName === "projectPath" || variableName === "projectRoot") {
      assertProjectRootVariable(projectRoot, value, variableName);
    } else {
      assertPathInsideProject(projectRoot, value, variableName);
    }
  }
}

export function validateReportedFileWrites(projectRoot: string, reportedWrites: readonly string[]): string[] {
  const normalizedWrites = reportedWrites.map((reportedWrite) => resolveProjectPath(projectRoot, reportedWrite));
  const forbiddenWrite = normalizedWrites.find((reportedWrite) => !isPathInsideProject(projectRoot, reportedWrite));

  if (forbiddenWrite !== undefined) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("forbidden-file-write", {
        detail: "External agents may only edit project source files.",
        path: forbiddenWrite
      })
    );
  }

  const forbiddenSourceWrite = normalizedWrites.find((reportedWrite) => !isEditableProjectSourcePath(projectRoot, reportedWrite));
  if (forbiddenSourceWrite !== undefined) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("forbidden-file-write", {
        detail: "External agents may only report writes to deck source files: deck.json, slides/, notes/, theme/, or assets/.",
        path: forbiddenSourceWrite
      })
    );
  }

  return normalizedWrites;
}

export function isEditableProjectSourcePath(projectRoot: string, candidatePath: string): boolean {
  if (!isPathInsideProject(projectRoot, candidatePath)) {
    return false;
  }

  const root = path.resolve(projectRoot);
  const candidate = resolveProjectPath(root, candidatePath);
  const relativePath = path.relative(root, candidate).split(path.sep).join(path.posix.sep);
  if (relativePath.length === 0 || relativePath.includes("\0") || relativePath.startsWith("../")) {
    return false;
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }

  return (
    relativePath === "deck.json" ||
    relativePath.startsWith("slides/") ||
    relativePath.startsWith("notes/") ||
    relativePath.startsWith("theme/") ||
    relativePath.startsWith("assets/")
  );
}
