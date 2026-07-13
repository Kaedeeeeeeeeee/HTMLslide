import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateReleaseManifest } from "./validate-release-contract.mjs";

const releaseSecurityEvidencePattern = /^release-security-evidence-.+\.json$/u;

export async function verifyReleaseBundle({ bundleDir, expectedArch = "arm64", expectedTeamIdentifier } = {}) {
  if (typeof bundleDir !== "string" || bundleDir.trim().length === 0) {
    throw new Error("Release bundle directory must be a non-empty path.");
  }
  if (typeof expectedArch !== "string" || expectedArch.trim().length === 0) {
    throw new Error("Expected release architecture must be a non-empty string.");
  }

  const resolvedBundleDir = path.resolve(bundleDir);
  const bundleEntries = await readBundleEntries(resolvedBundleDir);
  const manifestCandidates = await findManifestCandidates(bundleEntries, expectedArch);
  if (manifestCandidates.length === 0) {
    throw new Error(
      `No release manifest candidate found in ${path.basename(resolvedBundleDir)}; expected one JSON object with appName HTMLslide, channel release, arch ${expectedArch}, and artifacts.`
    );
  }
  if (manifestCandidates.length > 1) {
    throw new Error(
      `Expected exactly one release manifest candidate in ${path.basename(resolvedBundleDir)}; found ${manifestCandidates.length}: ${manifestCandidates.map(({ fileName }) => fileName).join(", ")}.`
    );
  }

  const manifestCandidate = manifestCandidates[0];
  const manifest = manifestCandidate.value;
  const artifactFileName = requireBasenameReference(manifest.artifacts?.[0], "manifest artifact");
  const securityEvidenceFileName = requireBasenameReference(
    manifest.securityEvidence?.fileName,
    "manifest security evidence"
  );

  const dmgFiles = bundleEntries
    .filter(({ fileName }) => fileName.endsWith(".dmg"))
    .map(({ fileName }) => fileName);
  if (dmgFiles.length !== 1) {
    throw new Error(
      `Expected exactly one release DMG in ${path.basename(resolvedBundleDir)}; found ${dmgFiles.length}${dmgFiles.length > 0 ? `: ${dmgFiles.join(", ")}` : ""}.`
    );
  }
  if (dmgFiles[0] !== artifactFileName) {
    throw new Error(
      `Release DMG filename mismatch: manifest artifact ${artifactFileName} does not match bundle DMG ${dmgFiles[0]}.`
    );
  }

  const securityEvidenceFiles = bundleEntries
    .filter(({ fileName }) => releaseSecurityEvidencePattern.test(fileName))
    .map(({ fileName }) => fileName);
  if (securityEvidenceFiles.length !== 1) {
    throw new Error(
      `Expected exactly one release security evidence file in ${path.basename(resolvedBundleDir)}; found ${securityEvidenceFiles.length}${securityEvidenceFiles.length > 0 ? `: ${securityEvidenceFiles.join(", ")}` : ""}.`
    );
  }
  if (securityEvidenceFiles[0] !== securityEvidenceFileName) {
    throw new Error(
      `Release security evidence filename mismatch: manifest references ${securityEvidenceFileName}, but the bundle contains ${securityEvidenceFiles[0]}.`
    );
  }

  const manifestPath = path.join(resolvedBundleDir, manifestCandidate.fileName);
  const dmgPath = path.join(resolvedBundleDir, dmgFiles[0]);
  const securityEvidencePath = path.join(resolvedBundleDir, securityEvidenceFiles[0]);
  const validatedManifest = await validateReleaseManifest(manifestPath, {
    expectedArch,
    expectedTeamIdentifier
  });
  const [manifestMetadata, dmgMetadata, securityEvidenceMetadata] = await Promise.all([
    fileMetadata(manifestPath),
    fileMetadata(dmgPath),
    fileMetadata(securityEvidencePath)
  ]);

  return {
    bundleDir: path.basename(resolvedBundleDir),
    manifest: {
      fileName: manifestMetadata.fileName,
      sha256: manifestMetadata.sha256
    },
    dmg: dmgMetadata,
    securityEvidence: {
      fileName: securityEvidenceMetadata.fileName,
      sha256: securityEvidenceMetadata.sha256
    },
    validatedManifest
  };
}

export function parseArgs(args) {
  const parsed = {};
  const allowed = new Set(["bundleDir", "expectedArch", "teamId", "output"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: --${rawKey}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    parsed[key] = value;
    if (inlineValue === undefined) index += 1;
  }

  if (typeof parsed.bundleDir !== "string" || parsed.bundleDir.trim().length === 0) {
    throw new Error("Missing required --bundle-dir value.");
  }
  if (parsed.output !== undefined && parsed.output.trim().length === 0) {
    throw new Error("Missing value for --output.");
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const result = await verifyReleaseBundle({
    bundleDir: options.bundleDir,
    expectedArch: options.expectedArch ?? "arm64",
    expectedTeamIdentifier: options.teamId
  });
  if (options.output !== undefined) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(await sanitizeVerificationResult(result), null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `Release bundle verified: ${result.bundleDir}/${result.dmg.fileName} (${result.dmg.sizeBytes} bytes); manifest ${result.manifest.fileName}; security evidence ${result.securityEvidence.fileName}.\n`
  );
  return result;
}

async function sanitizeVerificationResult(result) {
  const manifestPath = result.validatedManifest.manifestPath;
  const securityEvidencePath = path.join(path.dirname(manifestPath), result.securityEvidence.fileName);
  const [manifestMetadata, securityEvidenceMetadata] = await Promise.all([
    fileMetadata(manifestPath),
    fileMetadata(securityEvidencePath)
  ]);

  return {
    bundleDir: result.bundleDir,
    manifest: {
      fileName: manifestMetadata.fileName,
      sizeBytes: manifestMetadata.sizeBytes,
      sha256: manifestMetadata.sha256
    },
    dmg: {
      fileName: result.dmg.fileName,
      sizeBytes: result.dmg.sizeBytes,
      sha256: result.dmg.sha256
    },
    securityEvidence: {
      fileName: securityEvidenceMetadata.fileName,
      sizeBytes: securityEvidenceMetadata.sizeBytes,
      sha256: securityEvidenceMetadata.sha256
    },
    validatedManifest: {
      arch: result.validatedManifest.arch,
      channel: result.validatedManifest.channel
    }
  };
}

async function readBundleEntries(bundleDir) {
  let bundleStats;
  try {
    bundleStats = await lstat(bundleDir);
  } catch (error) {
    throw new Error(`Release bundle directory is missing: ${bundleDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!bundleStats.isDirectory()) {
    throw new Error(`Release bundle path is not a directory: ${bundleDir}`);
  }

  const entries = await readdir(bundleDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Release bundle contains a symlink; expected copied regular files: ${entry.name}`);
    }
    if (entry.isFile()) {
      files.push({ fileName: entry.name, filePath: path.join(bundleDir, entry.name) });
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.fileName), Buffer.from(right.fileName)));
  return files;
}

async function findManifestCandidates(bundleEntries, expectedArch) {
  const candidates = [];
  for (const entry of bundleEntries.filter(({ fileName }) => path.extname(fileName).toLowerCase() === ".json")) {
    let value;
    try {
      value = JSON.parse(await readFile(entry.filePath, "utf8"));
    } catch {
      continue;
    }
    if (
      isRecord(value) &&
      value.appName === "HTMLslide" &&
      value.channel === "release" &&
      value.arch === expectedArch &&
      Object.hasOwn(value, "artifacts")
    ) {
      candidates.push({ fileName: entry.fileName, value });
    }
  }
  return candidates;
}

function requireBasenameReference(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty basename-only path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized.includes("/") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("../") ||
    normalized.includes("./")
  ) {
    throw new Error(`${label} must be a basename-only path without absolute or traversal components: ${value}`);
  }
  return value;
}

async function fileMetadata(filePath) {
  const [bytes, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  if (!fileStats.isFile()) {
    throw new Error(`Release bundle entry is not a regular file: ${path.basename(filePath)}`);
  }
  return {
    fileName: path.basename(filePath),
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
