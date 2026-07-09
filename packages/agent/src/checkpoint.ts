import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHECKPOINT_SCHEMA_VERSION } from "@htmlslide/core/version";
import type {
  CheckpointFile,
  CheckpointMetadata,
  CheckpointReferenceInput,
  CheckpointTextDiff,
  CreateFileCopyCheckpointInput,
  FileCopyCheckpointDiff,
  FileCopyCheckpointRevertResult,
  RecordCheckpointChangesInput
} from "./types.js";

const manifestFileName = "manifest.json";
const snapshotDirectoryName = "snapshot";

const sourceRoots = ["deck.json", "slides/", "notes/", "theme/", "assets/"] as const;
const scopedDirectories = ["slides", "notes", "theme", "assets"] as const;
const maxTextDiffFiles = 8;
const maxTextDiffInputLines = 600;
const maxTextDiffOutputLines = 160;
const textDiffContextLines = 2;

export const createFileCopyCheckpoint = async (
  input: CreateFileCopyCheckpointInput
): Promise<CheckpointMetadata> => {
  const projectRoot = path.resolve(input.projectRoot);
  const runId = normalizeCheckpointRunId(input.runId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const checkpointRoot = checkpointRootFor(projectRoot, runId);
  const snapshotRoot = path.join(checkpointRoot, snapshotDirectoryName);

  await mkdir(checkpointRoot, { recursive: true });
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });

  const sourceFiles = await listSourceFiles(projectRoot);
  const files: CheckpointFile[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = resolveProjectPath(projectRoot, filePath);
    const digest = await digestFile(absolutePath);
    const snapshotPath = snapshotPathFor(filePath);
    const snapshotAbsolutePath = resolveCheckpointPath(checkpointRoot, snapshotPath);

    await mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
    await copyFile(absolutePath, snapshotAbsolutePath);

    files.push({
      path: filePath,
      status: "unchanged",
      digest,
      originalDigest: digest,
      currentDigest: digest,
      snapshotPath,
      origin: "snapshot"
    });
  }

  const checkpoint: CheckpointMetadata = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    id: checkpointIdForRun(runId),
    runId,
    projectRoot,
    strategy: "file-copy",
    createdAt,
    updatedAt: createdAt,
    label: `Before agent run ${runId}`,
    sourceRoots: [...sourceRoots],
    files,
    manifestPath: manifestFileName,
    snapshotRoot: snapshotDirectoryName,
    restore: {
      canRevert: true,
      notes:
        "File-copy checkpoint. Revert restores snapshotted source files and deletes only recorded agent-added files whose digest still matches."
    }
  };

  await writeCheckpointManifest(projectRoot, checkpoint);
  return checkpoint;
};

export const recordCheckpointChanges = async (
  input: RecordCheckpointChangesInput
): Promise<CheckpointMetadata> => {
  const projectRoot = path.resolve(input.projectRoot);
  const checkpoint = await readCheckpointManifest(input);
  const filesByPath = new Map(checkpoint.files.map((file) => [file.path, file]));
  const changedPaths = [...new Set(input.filesChanged.map((filePath) => normalizeSourcePath(filePath)))].sort(
    compareSourcePaths
  );

  for (const filePath of changedPaths) {
    const currentDigest = await digestExistingFile(resolveProjectPath(projectRoot, filePath));
    const existing = filesByPath.get(filePath);

    if (existing === undefined && currentDigest === undefined) {
      continue;
    }

    const originalDigest = existing?.originalDigest ?? existing?.digest;
    const status =
      existing === undefined
        ? "added"
        : existing.origin === "agent" && existing.snapshotPath === undefined
          ? currentDigest === undefined
            ? "deleted"
            : "added"
        : currentDigest === undefined
          ? "deleted"
          : currentDigest === originalDigest
            ? "unchanged"
            : "modified";

    filesByPath.set(filePath, cleanCheckpointFile({
      path: filePath,
      status,
      digest: currentDigest,
      originalDigest,
      currentDigest,
      snapshotPath: existing?.snapshotPath,
      origin: existing?.origin ?? (status === "added" ? "agent" : "snapshot")
    }));
  }

  checkpoint.files = [...filesByPath.values()].sort((left, right) => compareSourcePaths(left.path, right.path));
  checkpoint.updatedAt = input.recordedAt ?? new Date().toISOString();

  await writeCheckpointManifest(projectRoot, checkpoint);
  return checkpoint;
};

export const diffFileCopyCheckpoint = async (
  input: CheckpointReferenceInput
): Promise<FileCopyCheckpointDiff> => {
  const projectRoot = path.resolve(input.projectRoot);
  const checkpoint = await readCheckpointManifest(input);
  const checkpointRoot = checkpointRootFor(projectRoot, checkpoint.runId);
  const currentFiles = await currentSourceDigests(projectRoot);
  const originalFiles = checkpoint.files.filter((file) => file.origin !== "agent" && file.snapshotPath !== undefined);
  const originalByPath = new Map(originalFiles.map((file) => [file.path, file]));
  const allPaths = [...new Set([...originalByPath.keys(), ...currentFiles.keys()])].sort(compareSourcePaths);

  const changed: CheckpointFile[] = [];
  const added: CheckpointFile[] = [];
  const deleted: CheckpointFile[] = [];
  const unchanged: CheckpointFile[] = [];

  for (const filePath of allPaths) {
    const original = originalByPath.get(filePath);
    const currentDigest = currentFiles.get(filePath);

    if (original === undefined && currentDigest !== undefined) {
      added.push(cleanCheckpointFile({
        path: filePath,
        status: "added",
        digest: currentDigest,
        currentDigest,
        origin: checkpoint.files.find((file) => file.path === filePath)?.origin
      }));
      continue;
    }

    if (original !== undefined && currentDigest === undefined) {
      deleted.push(cleanCheckpointFile({
        path: filePath,
        status: "deleted",
        originalDigest: original.originalDigest ?? original.digest,
        snapshotPath: original.snapshotPath,
        origin: original.origin
      }));
      continue;
    }

    if (original === undefined || currentDigest === undefined) {
      continue;
    }

    const originalDigest = original.originalDigest ?? original.digest;
    const file: CheckpointFile = cleanCheckpointFile({
      path: filePath,
      status: currentDigest === originalDigest ? "unchanged" : "modified",
      digest: currentDigest,
      originalDigest,
      currentDigest,
      snapshotPath: original.snapshotPath,
      origin: original.origin
    });

    if (file.status === "modified") {
      changed.push(file);
    } else {
      unchanged.push(file);
    }
  }

  return {
    checkpoint,
    changed,
    added,
    deleted,
    unchanged,
    textDiffs: await buildTextDiffs(projectRoot, checkpointRoot, [...changed, ...added, ...deleted]),
    summary: {
      changed: changed.length,
      added: added.length,
      deleted: deleted.length,
      unchanged: unchanged.length
    }
  };
};

export const revertFileCopyCheckpoint = async (
  input: CheckpointReferenceInput
): Promise<FileCopyCheckpointRevertResult> => {
  const projectRoot = path.resolve(input.projectRoot);
  const checkpoint = await readCheckpointManifest(input);
  const checkpointRoot = checkpointRootFor(projectRoot, checkpoint.runId);
  const restored: string[] = [];
  const deleted: string[] = [];
  const preserved: string[] = [];
  const skipped: FileCopyCheckpointRevertResult["skipped"] = [];

  for (const file of checkpoint.files.sort((left, right) => compareSourcePaths(left.path, right.path))) {
    if (file.origin === "agent" || file.snapshotPath === undefined) {
      continue;
    }

    const snapshotAbsolutePath = resolveCheckpointPath(checkpointRoot, file.snapshotPath);
    if (!(await isRegularFile(snapshotAbsolutePath))) {
      skipped.push({
        path: file.path,
        reason: "Snapshot file is missing."
      });
      continue;
    }

    const projectAbsolutePath = resolveProjectPath(projectRoot, file.path);
    await mkdir(path.dirname(projectAbsolutePath), { recursive: true });
    await copyFile(snapshotAbsolutePath, projectAbsolutePath);
    restored.push(file.path);
  }

  const agentAddedFiles = checkpoint.files
    .filter((file) => file.status === "added" && file.origin === "agent")
    .sort((left, right) => compareSourcePaths(left.path, right.path));

  for (const file of agentAddedFiles) {
    const recordedDigest = file.currentDigest ?? file.digest;
    if (recordedDigest === undefined) {
      skipped.push({
        path: file.path,
        reason: "Agent-added file has no recorded digest."
      });
      continue;
    }

    const absolutePath = resolveProjectPath(projectRoot, file.path);
    const currentDigest = await digestExistingFile(absolutePath);
    if (currentDigest === undefined) {
      skipped.push({
        path: file.path,
        reason: "Agent-added file is already absent."
      });
      continue;
    }

    if (currentDigest !== recordedDigest) {
      preserved.push(file.path);
      skipped.push({
        path: file.path,
        reason: "Current digest differs from the recorded agent-added digest."
      });
      continue;
    }

    await unlink(absolutePath);
    deleted.push(file.path);
  }

  return {
    checkpoint,
    restored,
    deleted,
    preserved,
    skipped
  };
};

const readCheckpointManifest = async (input: CheckpointReferenceInput): Promise<CheckpointMetadata> => {
  const projectRoot = path.resolve(input.projectRoot);
  const runId = resolveCheckpointRunId(input);
  const manifestPath = path.join(checkpointRootFor(projectRoot, runId), manifestFileName);
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as CheckpointMetadata;

  if (rawManifest.strategy !== "file-copy") {
    throw new Error(`Checkpoint ${rawManifest.id ?? runId} is not a file-copy checkpoint.`);
  }

  rawManifest.projectRoot = projectRoot;
  rawManifest.runId = normalizeCheckpointRunId(rawManifest.runId);
  rawManifest.id = checkpointIdForRun(rawManifest.runId);
  rawManifest.files = rawManifest.files.map((file) => cleanCheckpointFile({
    ...file,
    path: normalizeSourcePath(file.path),
    snapshotPath: file.snapshotPath === undefined ? undefined : normalizeCheckpointRelativePath(file.snapshotPath)
  }));

  return rawManifest;
};

const writeCheckpointManifest = async (projectRoot: string, checkpoint: CheckpointMetadata): Promise<void> => {
  const checkpointRoot = checkpointRootFor(projectRoot, checkpoint.runId);
  await mkdir(checkpointRoot, { recursive: true });
  await writeFile(
    path.join(checkpointRoot, manifestFileName),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf8"
  );
};

const listSourceFiles = async (projectRoot: string): Promise<string[]> => {
  const files: string[] = [];
  const deckPath = resolveProjectPath(projectRoot, "deck.json");

  if (await isRegularFile(deckPath)) {
    files.push("deck.json");
  }

  for (const directory of scopedDirectories) {
    await collectSourceFiles(projectRoot, directory, files);
  }

  return files.sort(compareSourcePaths);
};

const collectSourceFiles = async (projectRoot: string, relativeDirectory: string, files: string[]): Promise<void> => {
  const absoluteDirectory = resolveProjectDirectoryPath(projectRoot, relativeDirectory);
  let entries;

  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSourceFiles(projectRoot, relativePath, files);
    } else if (entry.isFile()) {
      files.push(normalizeSourcePath(relativePath));
    }
  }
};

const currentSourceDigests = async (projectRoot: string): Promise<Map<string, string>> => {
  const files = await listSourceFiles(projectRoot);
  const digests = new Map<string, string>();

  for (const file of files) {
    digests.set(file, await digestFile(resolveProjectPath(projectRoot, file)));
  }

  return digests;
};

const digestExistingFile = async (absolutePath: string): Promise<string | undefined> => {
  if (!(await isRegularFile(absolutePath))) {
    return undefined;
  }

  return digestFile(absolutePath);
};

const digestFile = async (absolutePath: string): Promise<string> =>
  createHash("sha256").update(await readFile(absolutePath)).digest("hex");

const buildTextDiffs = async (
  projectRoot: string,
  checkpointRoot: string,
  files: CheckpointFile[]
): Promise<CheckpointTextDiff[]> => {
  const diffs: CheckpointTextDiff[] = [];

  for (const file of files.sort((left, right) => compareSourcePaths(left.path, right.path))) {
    if (diffs.length >= maxTextDiffFiles || !isDiffableStatus(file.status)) {
      continue;
    }

    const language = textDiffLanguage(file.path);
    if (language === undefined) {
      continue;
    }

    const originalText =
      file.status === "added" || file.snapshotPath === undefined
        ? ""
        : await readDiffableText(resolveCheckpointPath(checkpointRoot, file.snapshotPath));
    const currentText =
      file.status === "deleted"
        ? ""
        : await readDiffableText(resolveProjectPath(projectRoot, file.path));

    if (originalText === undefined || currentText === undefined) {
      continue;
    }

    const diff = compactTextDiff(buildLineTextDiff(originalText, currentText));
    diffs.push({
      path: file.path,
      status: file.status,
      language,
      lines: diff.lines,
      truncated: diff.truncated
    });
  }

  return diffs;
};

const isDiffableStatus = (status: CheckpointFile["status"]): status is CheckpointTextDiff["status"] =>
  status === "added" || status === "modified" || status === "deleted";

const textDiffLanguage = (filePath: string): CheckpointTextDiff["language"] | undefined => {
  if (filePath === "deck.json" || filePath.endsWith(".json")) {
    return "json";
  }

  if (filePath.endsWith(".html")) {
    return "html";
  }

  if (filePath.endsWith(".css")) {
    return "css";
  }

  if (filePath.endsWith(".md")) {
    return "markdown";
  }

  if (filePath.endsWith(".txt")) {
    return "text";
  }

  return undefined;
};

const readDiffableText = async (absolutePath: string): Promise<string | undefined> => {
  try {
    const text = await readFile(absolutePath, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    throw error;
  }
};

const buildLineTextDiff = (
  originalText: string,
  currentText: string
): CheckpointTextDiff["lines"] => {
  const originalLines = splitTextLines(originalText);
  const currentLines = splitTextLines(currentText);

  if (originalLines.length > maxTextDiffInputLines || currentLines.length > maxTextDiffInputLines) {
    return summarizeLargeTextDiff(originalLines, currentLines);
  }

  const lcsLengths = Array.from({ length: originalLines.length + 1 }, () =>
    Array.from({ length: currentLines.length + 1 }, () => 0)
  );

  for (let oldIndex = originalLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = lcsLengths[oldIndex];
    if (row === undefined) {
      continue;
    }

    for (let newIndex = currentLines.length - 1; newIndex >= 0; newIndex -= 1) {
      row[newIndex] =
        originalLines[oldIndex] === currentLines[newIndex]
          ? lcsValue(lcsLengths, oldIndex + 1, newIndex + 1) + 1
          : Math.max(lcsValue(lcsLengths, oldIndex + 1, newIndex), lcsValue(lcsLengths, oldIndex, newIndex + 1));
    }
  }

  const lines: CheckpointTextDiff["lines"] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalLines.length && newIndex < currentLines.length) {
    const originalLine = originalLines[oldIndex];
    const currentLine = currentLines[newIndex];
    if (originalLine === undefined || currentLine === undefined) {
      break;
    }

    if (originalLine === currentLine) {
      lines.push({
        type: "context",
        text: originalLine,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (lcsValue(lcsLengths, oldIndex + 1, newIndex) >= lcsValue(lcsLengths, oldIndex, newIndex + 1)) {
      lines.push({
        type: "removed",
        text: originalLine,
        oldLine: oldIndex + 1
      });
      oldIndex += 1;
    } else {
      lines.push({
        type: "added",
        text: currentLine,
        newLine: newIndex + 1
      });
      newIndex += 1;
    }
  }

  while (oldIndex < originalLines.length) {
    const originalLine = originalLines[oldIndex];
    if (originalLine === undefined) {
      break;
    }

    lines.push({
      type: "removed",
      text: originalLine,
      oldLine: oldIndex + 1
    });
    oldIndex += 1;
  }

  while (newIndex < currentLines.length) {
    const currentLine = currentLines[newIndex];
    if (currentLine === undefined) {
      break;
    }

    lines.push({
      type: "added",
      text: currentLine,
      newLine: newIndex + 1
    });
    newIndex += 1;
  }

  return lines;
};

const lcsValue = (matrix: number[][], oldIndex: number, newIndex: number): number =>
  matrix[oldIndex]?.[newIndex] ?? 0;

const splitTextLines = (text: string): string[] => {
  if (text.length === 0) {
    return [];
  }

  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedText = normalizedText.endsWith("\n") ? normalizedText.slice(0, -1) : normalizedText;
  return trimmedText.length === 0 ? [] : trimmedText.split("\n");
};

const summarizeLargeTextDiff = (
  originalLines: string[],
  currentLines: string[]
): CheckpointTextDiff["lines"] => [
  {
    type: "omitted",
    text: `Large text diff omitted (${originalLines.length} original lines, ${currentLines.length} current lines).`
  }
];

const compactTextDiff = (
  lines: CheckpointTextDiff["lines"]
): {
  lines: CheckpointTextDiff["lines"];
  truncated: boolean;
} => {
  if (lines.length <= maxTextDiffOutputLines && lines.every((line) => line.type !== "context")) {
    return {
      lines,
      truncated: lines.some((line) => line.type === "omitted")
    };
  }

  const changedIndexes = lines
    .map((line, index) => (line.type === "context" ? -1 : index))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) {
    return {
      lines: lines.slice(0, maxTextDiffOutputLines),
      truncated: lines.length > maxTextDiffOutputLines
    };
  }

  const keepIndexes = new Set<number>();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - textDiffContextLines);
    const end = Math.min(lines.length - 1, index + textDiffContextLines);
    for (let keepIndex = start; keepIndex <= end; keepIndex += 1) {
      keepIndexes.add(keepIndex);
    }
  }

  const compacted: CheckpointTextDiff["lines"] = [];
  let omitted = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!keepIndexes.has(index)) {
      omitted += 1;
      continue;
    }

    if (omitted > 0) {
      compacted.push({
        type: "omitted",
        text: `${omitted} unchanged ${omitted === 1 ? "line" : "lines"} omitted.`
      });
      omitted = 0;
    }

    const line = lines[index];
    if (line !== undefined) {
      compacted.push(line);
    }
  }

  if (omitted > 0) {
    compacted.push({
      type: "omitted",
      text: `${omitted} unchanged ${omitted === 1 ? "line" : "lines"} omitted.`
    });
  }

  if (compacted.length <= maxTextDiffOutputLines) {
    return {
      lines: compacted,
      truncated: compacted.length !== lines.length
    };
  }

  return {
    lines: [
      ...compacted.slice(0, maxTextDiffOutputLines - 1),
      {
        type: "omitted",
        text: `${compacted.length - maxTextDiffOutputLines + 1} diff lines omitted.`
      }
    ],
    truncated: true
  };
};

const isRegularFile = async (absolutePath: string): Promise<boolean> => {
  try {
    return (await lstat(absolutePath)).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const normalizeSourcePath = (filePath: string): string => {
  if (filePath.length === 0 || filePath.includes("\0") || path.posix.isAbsolute(filePath) || filePath.includes("\\")) {
    throw new Error(`Invalid project-relative source path: ${filePath}`);
  }

  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid project-relative source path: ${filePath}`);
  }

  if (segments.some((segment) => segment.startsWith("."))) {
    throw new Error(`Hidden source paths are not part of checkpoint scope: ${filePath}`);
  }

  if (!isInSourceScope(filePath)) {
    throw new Error(`Path is outside file-copy checkpoint source scope: ${filePath}`);
  }

  return filePath;
};

const isInSourceScope = (filePath: string): boolean =>
  filePath === "deck.json" || scopedDirectories.some((directory) => filePath.startsWith(`${directory}/`));

const normalizeCheckpointRelativePath = (filePath: string): string => {
  if (filePath.length === 0 || filePath.includes("\0") || path.posix.isAbsolute(filePath) || filePath.includes("\\")) {
    throw new Error(`Invalid checkpoint-relative path: ${filePath}`);
  }

  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid checkpoint-relative path: ${filePath}`);
  }

  if (!filePath.startsWith(`${snapshotDirectoryName}/`)) {
    throw new Error(`Checkpoint snapshot path must stay under ${snapshotDirectoryName}/: ${filePath}`);
  }

  return filePath;
};

const normalizeCheckpointRunId = (runId: string): string => {
  if (runId.length === 0 || runId.includes("\0") || runId.includes("/") || runId.includes("\\") || runId === "." || runId === "..") {
    throw new Error(`Invalid checkpoint run id: ${runId}`);
  }

  return runId;
};

const resolveCheckpointRunId = (input: CheckpointReferenceInput): string => {
  const runIdFromCheckpointId =
    input.checkpointId === undefined
      ? undefined
      : input.checkpointId.startsWith("checkpoint-")
        ? input.checkpointId.slice("checkpoint-".length)
        : input.checkpointId;
  const runId = input.runId ?? runIdFromCheckpointId;

  if (runId === undefined) {
    throw new Error("A checkpoint runId or checkpointId is required.");
  }

  if (input.runId !== undefined && runIdFromCheckpointId !== undefined && input.runId !== runIdFromCheckpointId) {
    throw new Error(`Checkpoint id ${input.checkpointId} does not match run id ${input.runId}.`);
  }

  return normalizeCheckpointRunId(runId);
};

const checkpointRootFor = (projectRoot: string, runId: string): string =>
  path.join(path.resolve(projectRoot), ".htmlslide", "checkpoints", normalizeCheckpointRunId(runId));

const checkpointIdForRun = (runId: string): string => `checkpoint-${runId}`;

const snapshotPathFor = (filePath: string): string => `${snapshotDirectoryName}/${normalizeSourcePath(filePath)}`;

const resolveProjectPath = (projectRoot: string, relativePath: string): string => {
  const normalizedPath = normalizeSourcePath(relativePath);
  const absolutePath = path.resolve(projectRoot, ...normalizedPath.split("/"));
  assertInside(projectRoot, absolutePath);
  return absolutePath;
};

const resolveProjectDirectoryPath = (projectRoot: string, relativePath: string): string => {
  if (relativePath.length === 0 || relativePath.includes("\0") || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`Invalid project-relative directory path: ${relativePath}`);
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error(`Invalid project-relative directory path: ${relativePath}`);
  }

  if (!scopedDirectories.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`))) {
    throw new Error(`Directory is outside file-copy checkpoint source scope: ${relativePath}`);
  }

  const absolutePath = path.resolve(projectRoot, ...relativePath.split("/"));
  assertInside(projectRoot, absolutePath);
  return absolutePath;
};

const resolveCheckpointPath = (checkpointRoot: string, relativePath: string): string => {
  const normalizedPath = normalizeCheckpointRelativePath(relativePath);
  const absolutePath = path.resolve(checkpointRoot, ...normalizedPath.split("/"));
  assertInside(checkpointRoot, absolutePath);
  return absolutePath;
};

const assertInside = (root: string, target: string): void => {
  const relativePath = path.relative(path.resolve(root), target);
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }

  throw new Error(`Resolved path escapes root: ${target}`);
};

const compareSourcePaths = (left: string, right: string): number => {
  const leftRank = sourceRank(left);
  const rightRank = sourceRank(right);
  return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
};

const sourceRank = (filePath: string): number => {
  if (filePath === "deck.json") {
    return 0;
  }

  const root = filePath.split("/")[0];
  const index = scopedDirectories.findIndex((directory) => directory === root);
  return index === -1 ? scopedDirectories.length + 1 : index + 1;
};

const cleanCheckpointFile = (file: CheckpointFile): CheckpointFile =>
  Object.fromEntries(Object.entries(file).filter(([, value]) => value !== undefined)) as CheckpointFile;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
