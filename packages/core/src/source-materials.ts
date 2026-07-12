import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeDeckPath, resolveProjectRelativePathInsideRealProject } from "./paths.js";
import {
  MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
  MAX_SOURCE_MATERIAL_BYTES_TOTAL,
  MAX_SOURCE_MATERIAL_COUNT
} from "./source-material-limits.js";

export {
  MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
  MAX_SOURCE_MATERIAL_BYTES_TOTAL,
  MAX_SOURCE_MATERIAL_COUNT
} from "./source-material-limits.js";

export const SOURCE_MATERIAL_INDEX_PATH = "assets/sources/index.json" as const;
export const SOURCE_MATERIAL_INDEX_SCHEMA_VERSION = 1 as const;

const SOURCE_MATERIAL_DIRECTORY = "assets/sources";
const SOURCE_MATERIAL_INDEX_NAME = "index.json";
const SECRET_LIKE_EXTENSION_PATTERN = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;
const SECRET_LIKE_NAME_PATTERN = /(?:^|[._-])(?:api[-_]?key|credential|credentials|env|id_(?:rsa|dsa|ecdsa|ed25519)|passwd|password|private[-_]?key|secret|secrets|ssh[-_]?key|token|tokens)(?:$|[._-])/iu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type SourceMaterialKind = "file" | "text";

export interface SourceMaterialFileInput {
  kind: "file";
  sourcePath: string;
  name?: string;
  mediaType?: string;
}

export interface SourceMaterialTextInput {
  kind: "text";
  name: string;
  content: string;
}

export type SourceMaterialInput = SourceMaterialFileInput | SourceMaterialTextInput;

export interface SourceMaterialRecord {
  kind: SourceMaterialKind;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface SourceMaterialIndex {
  schemaVersion: typeof SOURCE_MATERIAL_INDEX_SCHEMA_VERSION;
  materials: SourceMaterialRecord[];
}

export interface StageSourceMaterialsOptions {
  /** Optional lower per-file cap. It may not exceed MAX_SOURCE_MATERIAL_BYTES_PER_FILE. */
  maxBytesPerFile?: number;
  /** Optional lower total cap. It may not exceed MAX_SOURCE_MATERIAL_BYTES_TOTAL. */
  maxBytesTotal?: number;
  /** Optional lower source count cap. It may not exceed MAX_SOURCE_MATERIAL_COUNT. */
  maxCount?: number;
}

export interface StageSourceMaterialsResult {
  indexPath: typeof SOURCE_MATERIAL_INDEX_PATH;
  records: SourceMaterialRecord[];
  totalBytes: number;
}

export type SourceMaterialErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_INPUT"
  | "SOURCE_PATH_NOT_ABSOLUTE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_SYMLINK"
  | "SOURCE_NOT_REGULAR_FILE"
  | "SOURCE_SECRET_LIKE"
  | "SOURCE_READ_FAILED"
  | "SOURCE_CHANGED_WHILE_READING"
  | "SOURCE_FILE_TOO_LARGE"
  | "SOURCE_TOTAL_TOO_LARGE"
  | "SOURCE_COUNT_TOO_LARGE"
  | "SOURCE_NAME_INVALID"
  | "SOURCE_INDEX_INVALID"
  | "SOURCE_TARGET_UNSAFE"
  | "SOURCE_TARGET_CONFLICT"
  | "SOURCE_WRITE_FAILED";

export class SourceMaterialError extends Error {
  readonly name = "SourceMaterialError";

  constructor(
    readonly code: SourceMaterialErrorCode,
    message: string,
    readonly details: {
      inputIndex?: number;
      sourcePath?: string;
      projectPath?: string;
      limitBytes?: number;
      actualBytes?: number;
    } = {}
  ) {
    super(message);
  }
}

const SourceMaterialRecordSchema = z
  .object({
    kind: z.enum(["file", "text"]),
    name: z.string().min(1),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_PATTERN)
  })
  .strict();

const SourceMaterialIndexSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_MATERIAL_INDEX_SCHEMA_VERSION),
    materials: z.array(SourceMaterialRecordSchema)
  })
  .strict();

type EffectiveLimits = {
  maxBytesPerFile: number;
  maxBytesTotal: number;
  maxCount: number;
};

type PreparedSourceMaterial = {
  inputIndex: number;
  kind: SourceMaterialKind;
  desiredName: string;
  bytes: Buffer;
};

/**
 * Copy user-owned source files or pasted Markdown into the project source area.
 * All input validation and destination safety checks happen before any project
 * file is written. Existing source files are preserved with deterministic names.
 */
export async function stageSourceMaterials(
  projectRoot: string,
  inputs: readonly SourceMaterialInput[],
  options: StageSourceMaterialsOptions = {}
): Promise<StageSourceMaterialsResult> {
  const limits = resolveLimits(options);
  if (!Array.isArray(inputs)) {
    throw new SourceMaterialError("INVALID_INPUT", "Source materials must be provided as an array.");
  }
  if (inputs.length > limits.maxCount) {
    throw new SourceMaterialError(
      "SOURCE_COUNT_TOO_LARGE",
      `Select at most ${limits.maxCount} source materials; received ${inputs.length}.`,
      { limitBytes: limits.maxCount, actualBytes: inputs.length }
    );
  }

  const indexAbsolutePath = await resolveSourceTarget(projectRoot, SOURCE_MATERIAL_INDEX_PATH);
  const existingRecords = await readExistingIndex(indexAbsolutePath, projectRoot);

  if (inputs.length === 0) {
    return { indexPath: SOURCE_MATERIAL_INDEX_PATH, records: [], totalBytes: 0 };
  }

  const prepared = await prepareInputs(inputs, limits);
  const totalBytes = prepared.reduce((total, material) => total + material.bytes.byteLength, 0);
  if (totalBytes > limits.maxBytesTotal) {
    throw new SourceMaterialError(
      "SOURCE_TOTAL_TOO_LARGE",
      `Source materials total ${formatBytes(totalBytes)}; the per-run limit is ${formatBytes(limits.maxBytesTotal)}. Remove some files or paste less text and try again.`,
      { limitBytes: limits.maxBytesTotal, actualBytes: totalBytes }
    );
  }

  const sourceDirectoryAbsolutePath = path.dirname(indexAbsolutePath);
  const existingNames = await readExistingNames(sourceDirectoryAbsolutePath);
  for (const record of existingRecords) {
    existingNames.add(record.name);
  }
  existingNames.add(SOURCE_MATERIAL_INDEX_NAME);

  const staged = prepared.map((material) => {
    const name = allocateDeterministicName(material.desiredName, existingNames);
    existingNames.add(name);
    const projectPath = `${SOURCE_MATERIAL_DIRECTORY}/${name}`;
    return {
      ...material,
      name,
      projectPath
    };
  });

  const targetAbsolutePaths = await Promise.all(
    staged.map(async (material) => ({
      ...material,
      absolutePath: await resolveSourceTarget(projectRoot, material.projectPath)
    }))
  );

  await mkdir(sourceDirectoryAbsolutePath, { recursive: true });

  const writtenMaterialPaths: string[] = [];
  let temporaryIndexPath: string | undefined;
  try {
    // Re-resolve after creating the directory so a pre-existing symlink cannot
    // become the destination between the preflight and the write.
    await resolveSourceTarget(projectRoot, SOURCE_MATERIAL_INDEX_PATH);
    for (const material of targetAbsolutePaths) {
      await resolveSourceTarget(projectRoot, material.projectPath);
      try {
        await writeFile(material.absolutePath, material.bytes, { flag: "wx" });
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new SourceMaterialError(
            "SOURCE_TARGET_CONFLICT",
            `The staged source target already exists: ${material.projectPath}. Retry to allocate a new deterministic name.`,
            { inputIndex: material.inputIndex, projectPath: material.projectPath }
          );
        }
        throw error;
      }
      writtenMaterialPaths.push(material.absolutePath);
    }

    const newRecords = targetAbsolutePaths.map<SourceMaterialRecord>((material) => ({
      kind: material.kind,
      name: material.name,
      path: material.projectPath,
      bytes: material.bytes.byteLength,
      sha256: sha256Hex(material.bytes)
    }));
    const nextIndex: SourceMaterialIndex = {
      schemaVersion: SOURCE_MATERIAL_INDEX_SCHEMA_VERSION,
      materials: [...existingRecords, ...newRecords].sort(compareRecords)
    };

    temporaryIndexPath = `${indexAbsolutePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryIndexPath, serializeIndex(nextIndex), { flag: "wx" });
    await ensureSafeIndexDestination(indexAbsolutePath, projectRoot);
    await rename(temporaryIndexPath, indexAbsolutePath);
    temporaryIndexPath = undefined;

    return {
      indexPath: SOURCE_MATERIAL_INDEX_PATH,
      records: newRecords,
      totalBytes
    };
  } catch (error) {
    if (temporaryIndexPath) {
      await unlink(temporaryIndexPath).catch(() => undefined);
    }
    await Promise.all(writtenMaterialPaths.map((filePath) => unlink(filePath).catch(() => undefined)));
    if (error instanceof SourceMaterialError) {
      throw error;
    }
    throw new SourceMaterialError(
      "SOURCE_WRITE_FAILED",
      `Unable to stage source materials under ${SOURCE_MATERIAL_DIRECTORY}: ${formatUnknownError(error)}. Check the project permissions and try again.`,
      { projectPath: SOURCE_MATERIAL_DIRECTORY }
    );
  }
}

function resolveLimits(options: StageSourceMaterialsOptions): EffectiveLimits {
  if (typeof options !== "object" || options === null) {
    throw new SourceMaterialError("INVALID_OPTIONS", "Source material staging options must be an object.");
  }

  const maxBytesPerFile = resolveLimit(
    options.maxBytesPerFile,
    MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
    "maxBytesPerFile"
  );
  const maxBytesTotal = resolveLimit(options.maxBytesTotal, MAX_SOURCE_MATERIAL_BYTES_TOTAL, "maxBytesTotal");
  const maxCount = resolveLimit(options.maxCount, MAX_SOURCE_MATERIAL_COUNT, "maxCount");

  return { maxBytesPerFile, maxBytesTotal, maxCount };
}

function resolveLimit(value: number | undefined, hardLimit: number, label: string): number {
  if (value === undefined) {
    return hardLimit;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > hardLimit) {
    throw new SourceMaterialError(
      "INVALID_OPTIONS",
      `${label} must be a non-negative integer no greater than ${hardLimit}; received ${String(value)}.`
    );
  }
  return value;
}

async function prepareInputs(
  inputs: readonly SourceMaterialInput[],
  limits: EffectiveLimits
): Promise<PreparedSourceMaterial[]> {
  const prepared: PreparedSourceMaterial[] = [];
  let totalBytes = 0;
  for (const [inputIndex, input] of inputs.entries()) {
    if (!isRecord(input) || (input.kind !== "file" && input.kind !== "text")) {
      throw new SourceMaterialError(
        "INVALID_INPUT",
        `Source material ${inputIndex + 1} must be a file or text input with kind "file" or "text".`,
        { inputIndex }
      );
    }

    if (input.kind === "file") {
      if (typeof input.sourcePath !== "string" || input.sourcePath.length === 0) {
        throw new SourceMaterialError(
          "INVALID_INPUT",
          `Source material ${inputIndex + 1} must include a selected sourcePath.`,
          { inputIndex }
        );
      }
      if (!path.isAbsolute(input.sourcePath) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(input.sourcePath)) {
        throw new SourceMaterialError(
          "SOURCE_PATH_NOT_ABSOLUTE",
          `Selected source ${inputIndex + 1} must use an absolute file path. Choose the file through the system picker and try again.`,
          { inputIndex, sourcePath: input.sourcePath }
        );
      }
      if (input.mediaType !== undefined && (typeof input.mediaType !== "string" || input.mediaType.trim().length === 0)) {
        throw new SourceMaterialError(
          "INVALID_INPUT",
          `Source material ${inputIndex + 1} has an invalid mediaType; omit it or provide a non-empty string.`,
          { inputIndex }
        );
      }

      const sourceName = path.basename(input.sourcePath);
      if (isSecretLikeName(sourceName)) {
        throw new SourceMaterialError(
          "SOURCE_SECRET_LIKE",
          `The selected source "${sourceName}" looks like a secret or credential file and cannot be imported. Choose a non-secret source document.`,
          { inputIndex }
        );
      }

      const bytes = await readSelectedSource(input.sourcePath, limits.maxBytesPerFile, inputIndex);
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxBytesTotal) {
        throw new SourceMaterialError(
          "SOURCE_TOTAL_TOO_LARGE",
          `Source materials total exceeds ${formatBytes(limits.maxBytesTotal)} while reading item ${inputIndex + 1}. Remove some files or paste less text and try again.`,
          { inputIndex, limitBytes: limits.maxBytesTotal, actualBytes: totalBytes }
        );
      }
      prepared.push({
        inputIndex,
        kind: "file",
        desiredName: normalizeMaterialName(input.name ?? sourceName, inputIndex, "file"),
        bytes
      });
      continue;
    }

    if (typeof input.name !== "string" || typeof input.content !== "string") {
      throw new SourceMaterialError(
        "INVALID_INPUT",
        `Text source material ${inputIndex + 1} must include string name and content fields.`,
        { inputIndex }
      );
    }
    const contentBytes = Buffer.from(input.content, "utf8");
    if (contentBytes.byteLength > limits.maxBytesPerFile) {
      throw new SourceMaterialError(
        "SOURCE_FILE_TOO_LARGE",
        `Pasted Markdown "${input.name}" is ${formatBytes(contentBytes.byteLength)}; the per-file limit is ${formatBytes(limits.maxBytesPerFile)}. Shorten the text and try again.`,
        { inputIndex, limitBytes: limits.maxBytesPerFile, actualBytes: contentBytes.byteLength }
      );
    }
    totalBytes += contentBytes.byteLength;
    if (totalBytes > limits.maxBytesTotal) {
      throw new SourceMaterialError(
        "SOURCE_TOTAL_TOO_LARGE",
        `Source materials total exceeds ${formatBytes(limits.maxBytesTotal)} at item ${inputIndex + 1}. Remove some files or paste less text and try again.`,
        { inputIndex, limitBytes: limits.maxBytesTotal, actualBytes: totalBytes }
      );
    }
    prepared.push({
      inputIndex,
      kind: "text",
      desiredName: normalizeMaterialName(input.name, inputIndex, "text"),
      bytes: contentBytes
    });
  }
  return prepared;
}

async function readSelectedSource(sourcePath: string, maxBytes: number, inputIndex: number): Promise<Buffer> {
  let initialInfo: Stats;
  try {
    initialInfo = await lstat(sourcePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new SourceMaterialError(
        "SOURCE_NOT_FOUND",
        `The selected source file does not exist: ${path.basename(sourcePath)}. Choose an existing file and try again.`,
        { inputIndex, sourcePath }
      );
    }
    throw new SourceMaterialError(
      "SOURCE_READ_FAILED",
      `Unable to inspect the selected source file ${path.basename(sourcePath)}: ${formatUnknownError(error)}. Check its permissions and try again.`,
      { inputIndex, sourcePath }
    );
  }

  if (initialInfo.isSymbolicLink()) {
    throw new SourceMaterialError(
      "SOURCE_SYMLINK",
      `The selected source ${path.basename(sourcePath)} is a symbolic link. Select the real file instead.`,
      { inputIndex, sourcePath }
    );
  }
  if (!initialInfo.isFile()) {
    throw new SourceMaterialError(
      "SOURCE_NOT_REGULAR_FILE",
      `The selected source ${path.basename(sourcePath)} is not a regular file. Select a file, not a directory or device.`,
      { inputIndex, sourcePath }
    );
  }
  if (initialInfo.size > maxBytes) {
    throw new SourceMaterialError(
      "SOURCE_FILE_TOO_LARGE",
      `The selected source ${path.basename(sourcePath)} is ${formatBytes(initialInfo.size)}; the per-file limit is ${formatBytes(maxBytes)}. Choose a smaller file.`,
      { inputIndex, sourcePath, limitBytes: maxBytes, actualBytes: initialInfo.size }
    );
  }

  let handle: FileHandle | undefined;
  try {
    const noFollowFlag = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    handle = await open(sourcePath, constants.O_RDONLY | noFollowFlag);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !sameFileSnapshot(initialInfo, openedInfo)) {
      throw new SourceMaterialError(
        "SOURCE_CHANGED_WHILE_READING",
        `The selected source ${path.basename(sourcePath)} changed while it was being staged. Select it again and retry.`,
        { inputIndex, sourcePath }
      );
    }
    if (openedInfo.size > maxBytes) {
      throw new SourceMaterialError(
        "SOURCE_FILE_TOO_LARGE",
        `The selected source ${path.basename(sourcePath)} grew to ${formatBytes(openedInfo.size)}; the per-file limit is ${formatBytes(maxBytes)}. Select a smaller file.`,
        { inputIndex, sourcePath, limitBytes: maxBytes, actualBytes: openedInfo.size }
      );
    }

    const bytes = await handle.readFile();
    const finalInfo = await handle.stat();
    if (!sameFileSnapshot(openedInfo, finalInfo) || bytes.byteLength !== finalInfo.size) {
      throw new SourceMaterialError(
        "SOURCE_CHANGED_WHILE_READING",
        `The selected source ${path.basename(sourcePath)} changed while it was being staged. Select it again and retry.`,
        { inputIndex, sourcePath }
      );
    }
    if (bytes.byteLength > maxBytes) {
      throw new SourceMaterialError(
        "SOURCE_FILE_TOO_LARGE",
        `The selected source ${path.basename(sourcePath)} is ${formatBytes(bytes.byteLength)}; the per-file limit is ${formatBytes(maxBytes)}. Choose a smaller file.`,
        { inputIndex, sourcePath, limitBytes: maxBytes, actualBytes: bytes.byteLength }
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof SourceMaterialError) {
      throw error;
    }
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new SourceMaterialError(
        "SOURCE_SYMLINK",
        `The selected source ${path.basename(sourcePath)} is a symbolic link. Select the real file instead.`,
        { inputIndex, sourcePath }
      );
    }
    throw new SourceMaterialError(
      "SOURCE_READ_FAILED",
      `Unable to read the selected source file ${path.basename(sourcePath)}: ${formatUnknownError(error)}. Check its permissions and try again.`,
      { inputIndex, sourcePath }
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveSourceTarget(projectRoot: string, projectPath: string): Promise<string> {
  try {
    return await resolveProjectRelativePathInsideRealProject(projectRoot, projectPath);
  } catch (error) {
    throw new SourceMaterialError(
      "SOURCE_TARGET_UNSAFE",
      `Cannot stage source material at ${projectPath}: ${formatUnknownError(error)} Choose a normal project folder without symlinked source directories.`,
      { projectPath }
    );
  }
}

async function ensureSafeIndexDestination(indexAbsolutePath: string, projectRoot: string): Promise<void> {
  await resolveSourceTarget(projectRoot, SOURCE_MATERIAL_INDEX_PATH);
  try {
    const info = await lstat(indexAbsolutePath);
    if (info.isSymbolicLink()) {
      throw new SourceMaterialError(
        "SOURCE_TARGET_UNSAFE",
        `The source index target ${SOURCE_MATERIAL_INDEX_PATH} is a symbolic link and will not be overwritten.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
    if (!info.isFile()) {
      throw new SourceMaterialError(
        "SOURCE_TARGET_CONFLICT",
        `The source index target ${SOURCE_MATERIAL_INDEX_PATH} is not a regular file. Remove it or choose a different project.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
  } catch (error) {
    if (error instanceof SourceMaterialError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new SourceMaterialError(
        "SOURCE_TARGET_UNSAFE",
        `Cannot verify the source index target ${SOURCE_MATERIAL_INDEX_PATH}: ${formatUnknownError(error)}.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
  }
}

async function readExistingIndex(indexAbsolutePath: string, projectRoot: string): Promise<SourceMaterialRecord[]> {
  let raw: string;
  try {
    raw = await readFile(indexAbsolutePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    if (isNodeError(error) && (error.code === "EISDIR" || error.code === "ELOOP")) {
      throw new SourceMaterialError(
        "SOURCE_INDEX_INVALID",
        `The source index ${SOURCE_MATERIAL_INDEX_PATH} is not a readable regular file. Remove or repair it before staging more sources.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
    throw new SourceMaterialError(
      "SOURCE_INDEX_INVALID",
      `Unable to read ${SOURCE_MATERIAL_INDEX_PATH}: ${formatUnknownError(error)}. Check the project permissions and repair the index before staging more sources.`,
      { projectPath: SOURCE_MATERIAL_INDEX_PATH }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SourceMaterialError(
      "SOURCE_INDEX_INVALID",
      `The source index ${SOURCE_MATERIAL_INDEX_PATH} contains invalid JSON: ${formatUnknownError(error)}. Repair or remove it before staging more sources.`,
      { projectPath: SOURCE_MATERIAL_INDEX_PATH }
    );
  }

  const result = SourceMaterialIndexSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SourceMaterialError(
      "SOURCE_INDEX_INVALID",
      `The source index ${SOURCE_MATERIAL_INDEX_PATH} is invalid${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}. Repair or remove it before staging more sources.`,
      { projectPath: SOURCE_MATERIAL_INDEX_PATH }
    );
  }

  const records = [...result.data.materials].sort(compareRecords);
  for (const record of records) {
    try {
      normalizeDeckPath(record.path);
    } catch (error) {
      throw new SourceMaterialError(
        "SOURCE_INDEX_INVALID",
        `The source index contains an unsafe path ${record.path}: ${formatUnknownError(error)}. Repair or remove it before staging more sources.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
    if (
      record.path !== `${SOURCE_MATERIAL_DIRECTORY}/${record.name}` ||
      record.name === SOURCE_MATERIAL_INDEX_NAME ||
      !record.path.startsWith(`${SOURCE_MATERIAL_DIRECTORY}/`)
    ) {
      throw new SourceMaterialError(
        "SOURCE_INDEX_INVALID",
        `The source index record ${record.name} must point to a non-index file directly under ${SOURCE_MATERIAL_DIRECTORY}/. Repair or remove the index before staging more sources.`,
        { projectPath: SOURCE_MATERIAL_INDEX_PATH }
      );
    }
    await resolveSourceTarget(projectRoot, record.path);
  }
  return records;
}

async function readExistingNames(sourceDirectoryAbsolutePath: string): Promise<Set<string>> {
  try {
    const entries = await readdir(sourceDirectoryAbsolutePath, { withFileTypes: true });
    return new Set(entries.map((entry) => entry.name));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return new Set();
    }
    throw new SourceMaterialError(
      "SOURCE_TARGET_UNSAFE",
      `Unable to inspect ${SOURCE_MATERIAL_DIRECTORY}/: ${formatUnknownError(error)}. Check that it is a directory and try again.`,
      { projectPath: SOURCE_MATERIAL_DIRECTORY }
    );
  }
}

function normalizeMaterialName(rawName: string, inputIndex: number, kind: SourceMaterialKind): string {
  const name = rawName.trim().normalize("NFC");
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(name) ||
    hasUnsafeNameCharacter(name)
  ) {
    throw new SourceMaterialError(
      "SOURCE_NAME_INVALID",
      `Source material ${inputIndex + 1} has an unsafe ${kind} name. Use one plain file name without path separators or control characters.`,
      { inputIndex }
    );
  }
  if (kind === "text" && !/\.(?:md|markdown)$/iu.test(name)) {
    return `${name}.md`;
  }
  return name;
}

function allocateDeterministicName(desiredName: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(desiredName)) {
    return desiredName;
  }
  const extension = path.posix.extname(desiredName);
  const stem = extension.length > 0 ? desiredName.slice(0, -extension.length) : desiredName;
  let suffix = 2;
  while (usedNames.has(`${stem}-${suffix}${extension}`)) {
    suffix += 1;
  }
  return `${stem}-${suffix}${extension}`;
}

function isSecretLikeName(name: string): boolean {
  return SECRET_LIKE_EXTENSION_PATTERN.test(name) || SECRET_LIKE_NAME_PATTERN.test(name);
}

function hasUnsafeNameCharacter(name: string): boolean {
  return [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || ':<>"|?*'.includes(character);
  });
}

function serializeIndex(index: SourceMaterialIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function compareRecords(left: SourceMaterialRecord, right: SourceMaterialRecord): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
