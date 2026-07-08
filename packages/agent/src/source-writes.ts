import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSourceWrite } from "./types.js";

export type ApplyAgentSourceWritesInput = {
  projectPath: string;
  writes: readonly AgentSourceWrite[];
};

export type ApplyAgentSourceWritesResult = {
  projectPath: string;
  filesChanged: string[];
  writes: AgentSourceWrite[];
};

const sourceDirectoryRoots = new Set(["assets", "notes", "slides", "theme"]);
const sourceFileRoots = new Set(["deck.json"]);
const forbiddenRoots = new Set([".htmlslide", "exports"]);

export function parseAgentSourceWrites(value: unknown): AgentSourceWrite[] {
  const rawWrites = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.writes)
      ? value.writes
      : undefined;

  if (rawWrites === undefined) {
    throw new Error("Agent source writes must be an array or an object with a writes array.");
  }

  return rawWrites.map((write, index) => {
    if (!isRecord(write)) {
      throw new Error(`Agent source write at index ${index} must be an object.`);
    }

    if (typeof write.path !== "string" || write.path.trim().length === 0) {
      throw new Error(`Agent source write at index ${index} must include a non-empty path.`);
    }

    if (typeof write.content !== "string") {
      throw new Error(`Agent source write for ${write.path} must include string content.`);
    }

    return {
      path: write.path,
      content: write.content
    };
  });
}

export async function applyAgentSourceWrites(
  input: ApplyAgentSourceWritesInput
): Promise<ApplyAgentSourceWritesResult> {
  const projectPath = path.resolve(input.projectPath);
  const writes = normalizeAgentSourceWrites(input.writes);

  for (const write of writes) {
    const absolutePath = resolveAgentSourceWritePath(projectPath, write.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, write.content, "utf8");
  }

  return {
    projectPath,
    filesChanged: writes.map((write) => write.path),
    writes
  };
}

export function normalizeAgentSourceWrites(writes: readonly AgentSourceWrite[]): AgentSourceWrite[] {
  if (writes.length === 0) {
    throw new Error("Agent source writes cannot be empty.");
  }

  const seenPaths = new Set<string>();

  return writes.map((write) => {
    const normalizedPath = normalizeAgentSourceWritePath(write.path);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate agent source write path: ${normalizedPath}`);
    }
    seenPaths.add(normalizedPath);

    if (typeof write.content !== "string") {
      throw new Error(`Agent source write for ${normalizedPath} must include string content.`);
    }

    return {
      path: normalizedPath,
      content: write.content
    };
  });
}

export function normalizeAgentSourceWritePath(projectRelativePath: string): string {
  const trimmedPath = projectRelativePath.trim();
  assertSafeAgentSourceWritePath(trimmedPath);
  return trimmedPath;
}

export function resolveAgentSourceWritePath(projectPath: string, projectRelativePath: string): string {
  const normalizedPath = normalizeAgentSourceWritePath(projectRelativePath);
  const projectRoot = path.resolve(projectPath);
  const absolutePath = path.resolve(projectRoot, ...normalizedPath.split("/"));
  const relative = path.relative(projectRoot, absolutePath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the project: ${normalizedPath}`);
  }

  return absolutePath;
}

function assertSafeAgentSourceWritePath(projectRelativePath: string): void {
  if (
    projectRelativePath.length === 0 ||
    projectRelativePath.includes("\\") ||
    projectRelativePath.includes(":") ||
    path.posix.isAbsolute(projectRelativePath)
  ) {
    throw new Error(`Invalid project-relative source path: ${projectRelativePath}`);
  }

  const segments = projectRelativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid project-relative source path: ${projectRelativePath}`);
  }

  const root = segments[0];
  if (root === undefined || forbiddenRoots.has(root)) {
    throw new Error(`Refusing to write non-source path: ${projectRelativePath}`);
  }

  if (sourceFileRoots.has(root)) {
    if (segments.length !== 1) {
      throw new Error(`Invalid source file path: ${projectRelativePath}`);
    }
    return;
  }

  if (!sourceDirectoryRoots.has(root)) {
    throw new Error(`Refusing to write non-source path: ${projectRelativePath}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
