import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXPORT_MANIFEST_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "./version.js";

export const EXPORT_MANIFEST_FILE_NAME = "export-manifest.json";
export const EXPORT_MANIFEST_PROJECT_PATH = `exports/${EXPORT_MANIFEST_FILE_NAME}`;
export const EXPORT_HASH_ALGORITHM = "sha256";
export const EXPORT_ARTIFACT_KINDS = ["deckpkg", "html", "notes", "pdf", "thumbnail"] as const;
export const MAX_EXPORT_MANIFEST_ENTRIES = 10_000;
export const MAX_EXPORT_MANIFEST_BYTES = 5 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const FingerprintPathSchema = z.string().min(1).refine(isSafeFingerprintPath, {
  message: "Fingerprint paths must be safe POSIX project-relative paths."
});

export const ExportFileFingerprintSchema = z
  .object({
    path: FingerprintPathSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: Sha256Schema
  })
  .strict();

export const ExportArtifactFingerprintSchema = ExportFileFingerprintSchema.extend({
  kind: z.enum(EXPORT_ARTIFACT_KINDS),
  slideId: z.string().min(1).optional()
})
  .refine((entry) => entry.path.startsWith("exports/") && entry.path !== EXPORT_MANIFEST_PROJECT_PATH, {
    message: "Artifact fingerprints must reference generated files under exports/ other than the manifest itself.",
    path: ["path"]
  })
  .superRefine((entry, context) => {
    const isThumbnail = entry.kind === "thumbnail";
    if (isThumbnail !== (entry.slideId !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slideId"],
        message: "Thumbnail fingerprints require slideId and other artifact kinds must omit it."
      });
    }

    const validPath =
      (entry.kind === "notes" && entry.path === "exports/notes.json") ||
      (entry.kind === "pdf" && entry.path.endsWith(".pdf")) ||
      (entry.kind === "html" && entry.path.endsWith(".html")) ||
      (entry.kind === "deckpkg" && entry.path.endsWith(".deckpkg")) ||
      (entry.kind === "thumbnail" && /^exports\/thumbnails\/[^/]+\.png$/u.test(entry.path));
    if (!validPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: `Artifact path does not match kind ${entry.kind}.`
      });
    }
  });

export const ExportManifestSchema = z
  .object({
    schemaVersion: z.literal(EXPORT_MANIFEST_SCHEMA_VERSION),
    compilerVersion: SemverSchema,
    hashAlgorithm: z.literal(EXPORT_HASH_ALGORITHM),
    sourceDigest: Sha256Schema,
    sources: z.array(ExportFileFingerprintSchema).min(1).max(MAX_EXPORT_MANIFEST_ENTRIES),
    artifacts: z.array(ExportArtifactFingerprintSchema).min(1).max(MAX_EXPORT_MANIFEST_ENTRIES)
  })
  .strict()
  .superRefine((manifest, context) => {
    addEntryOrderingIssues(manifest.sources, "sources", context);
    addEntryOrderingIssues(manifest.artifacts, "artifacts", context);

    if (manifest.sources.some((entry) => entry.path === "exports" || entry.path.startsWith("exports/"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "Source fingerprints must not reference compiler-owned exports/."
      });
    }

    const expectedDigest = fingerprintEntriesDigest(manifest.sources);
    if (manifest.sourceDigest !== expectedDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceDigest"],
        message: "sourceDigest does not match the canonical source fingerprints."
      });
    }
  });

export type ExportFileFingerprint = z.infer<typeof ExportFileFingerprintSchema>;
export type ExportArtifactFingerprint = z.infer<typeof ExportArtifactFingerprintSchema>;
export type ExportArtifactKind = ExportArtifactFingerprint["kind"];
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
export type ExportFileSnapshot = {
  bytes: Buffer;
  fingerprint: ExportFileFingerprint;
};

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export const fingerprintBytes = (projectPath: string, bytes: Uint8Array | string): ExportFileFingerprint => {
  if (!isSafeFingerprintPath(projectPath)) {
    throw new Error(`Unsafe fingerprint path: ${projectPath}`);
  }
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return {
    path: projectPath,
    sizeBytes: buffer.byteLength,
    sha256: sha256Hex(buffer)
  };
};

export const fingerprintEntriesDigest = (entries: readonly ExportFileFingerprint[]): string =>
  sha256Hex(
    JSON.stringify(
      [...entries]
        .sort((left, right) => compareFingerprintPaths(left.path, right.path))
        .map((entry) => ({ path: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }))
    )
  );

export const fingerprintProjectFile = async (
  projectRoot: string,
  projectPath: string
): Promise<ExportFileFingerprint> => {
  if (!isSafeFingerprintPath(projectPath)) {
    throw new Error(`Unsafe fingerprint path: ${projectPath}`);
  }

  const { handle, fileInfo } = await openVerifiedProjectFile(projectRoot, projectPath);
  try {
    const sha256 = await sha256File(handle);
    const finalHandleInfo = await handle.stat();
    assertSameFileSnapshot(projectPath, fileInfo, finalHandleInfo);
    const finalFile = await resolveRegularProjectFile(projectRoot, projectPath);
    assertSameFileSnapshot(projectPath, fileInfo, finalFile.fileInfo);

    return {
      path: projectPath,
      sizeBytes: fileInfo.size,
      sha256
    };
  } finally {
    await handle.close();
  }
};

export const readProjectFileSnapshot = async (
  projectRoot: string,
  projectPath: string
): Promise<ExportFileSnapshot> => {
  if (!isSafeFingerprintPath(projectPath)) {
    throw new Error(`Unsafe fingerprint path: ${projectPath}`);
  }
  const { handle, fileInfo } = await openVerifiedProjectFile(projectRoot, projectPath);
  try {
    const bytes = await handle.readFile();
    const finalHandleInfo = await handle.stat();
    assertSameFileSnapshot(projectPath, fileInfo, finalHandleInfo);
    const finalFile = await resolveRegularProjectFile(projectRoot, projectPath);
    assertSameFileSnapshot(projectPath, fileInfo, finalFile.fileInfo);
    if (bytes.byteLength !== fileInfo.size) {
      throw new Error(`Fingerprint target changed while reading: ${projectPath}`);
    }
    return {
      bytes,
      fingerprint: fingerprintBytes(projectPath, bytes)
    };
  } finally {
    await handle.close();
  }
};

export const toFingerprintProjectPath = (projectRoot: string, filePath: string): string => {
  const absoluteRoot = path.resolve(projectRoot);
  const absolutePath = path.resolve(absoluteRoot, filePath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Fingerprint path escapes project root: ${filePath}`);
  }
  const projectPath = relativePath.split(path.sep).join(path.posix.sep);
  if (projectPath !== projectPath.normalize("NFC")) {
    throw new Error(`Fingerprint path must use NFC Unicode normalization: ${filePath}`);
  }
  return projectPath;
};

export const fingerprintProjectFiles = async (
  projectRoot: string,
  projectPaths: Iterable<string>
): Promise<ExportFileFingerprint[]> => {
  const sortedPaths = [...new Set(projectPaths)].sort(compareFingerprintPaths);
  const fingerprints: ExportFileFingerprint[] = [];
  for (const projectPath of sortedPaths) {
    fingerprints.push(await fingerprintProjectFile(projectRoot, projectPath));
  }
  return fingerprints;
};

export const createExportManifest = (input: {
  artifacts: readonly ExportArtifactFingerprint[];
  compilerVersion?: string;
  sources: readonly ExportFileFingerprint[];
}): ExportManifest => {
  const sources = [...input.sources].sort((left, right) => compareFingerprintPaths(left.path, right.path));
  const artifacts = [...input.artifacts].sort((left, right) => compareFingerprintPaths(left.path, right.path));
  return ExportManifestSchema.parse({
    schemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
    compilerVersion: input.compilerVersion ?? HTMLSLIDE_APP_VERSION,
    hashAlgorithm: EXPORT_HASH_ALGORITHM,
    sourceDigest: fingerprintEntriesDigest(sources),
    sources,
    artifacts
  });
};

export const changedFingerprintPaths = (
  current: readonly ExportFileFingerprint[],
  recorded: readonly ExportFileFingerprint[]
): string[] => {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const recordedByPath = new Map(recorded.map((entry) => [entry.path, entry]));
  const paths = new Set([...currentByPath.keys(), ...recordedByPath.keys()]);

  return [...paths]
    .filter((entryPath) => {
      const currentEntry = currentByPath.get(entryPath);
      const recordedEntry = recordedByPath.get(entryPath);
      return (
        currentEntry === undefined ||
        recordedEntry === undefined ||
        currentEntry.sizeBytes !== recordedEntry.sizeBytes ||
        currentEntry.sha256 !== recordedEntry.sha256
      );
    })
    .sort(compareFingerprintPaths);
};

function isSafeFingerprintPath(value: string): boolean {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function addEntryOrderingIssues(
  entries: readonly ExportFileFingerprint[],
  field: "artifacts" | "sources",
  context: z.RefinementCtx
): void {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${field} must not contain duplicate paths.`
    });
  }

  const collisionKeys = paths.map((entryPath) => entryPath.normalize("NFC").toLowerCase());
  if (new Set(collisionKeys).size !== collisionKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${field} must not contain case-insensitive or Unicode-normalized path collisions.`
    });
  }

  const sortedPaths = [...paths].sort(compareFingerprintPaths);
  if (paths.some((entryPath, index) => entryPath !== sortedPaths[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${field} must be sorted by path.`
    });
  }
}

export function compareFingerprintPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertSameFileSnapshot(projectPath: string, before: Stats, after: Stats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`Fingerprint target changed while reading: ${projectPath}`);
  }
}

async function sha256File(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function openVerifiedProjectFile(
  projectRoot: string,
  projectPath: string
): Promise<{ handle: FileHandle; fileInfo: Stats }> {
  const { absolutePath, fileInfo } = await resolveRegularProjectFile(projectRoot, projectPath);
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedFileInfo = await handle.stat();
    assertSameFileSnapshot(projectPath, fileInfo, openedFileInfo);
    return { handle, fileInfo: openedFileInfo };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function resolveRegularProjectFile(
  projectRoot: string,
  projectPath: string
): Promise<{ absolutePath: string; fileInfo: Stats }> {
  const normalizedPath = projectPath.split("/").join(path.sep);
  const absoluteRoot = path.resolve(projectRoot);
  const absolutePath = path.resolve(absoluteRoot, normalizedPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Fingerprint path escapes project root: ${projectPath}`);
  }

  const [rootRealPath, fileInfo] = await Promise.all([realpath(absoluteRoot), lstat(absolutePath)]);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`Fingerprint target must be a regular file: ${projectPath}`);
  }
  const fileRealPath = await realpath(absolutePath);
  const realRelativePath = path.relative(rootRealPath, fileRealPath);
  if (realRelativePath === "" || realRelativePath.startsWith("..") || path.isAbsolute(realRelativePath)) {
    throw new Error(`Fingerprint target escapes project root through a symlink: ${projectPath}`);
  }
  return { absolutePath, fileInfo };
}
