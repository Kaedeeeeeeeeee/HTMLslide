import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{7,64}$/u;

export async function readPackageManifestProvenance(manifestPath, { requireSourceCommit = false } = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  let bytes;
  let manifest;
  try {
    bytes = await readFile(resolvedManifestPath);
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Package manifest is missing or invalid JSON: ${resolvedManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(manifest)) {
    throw new Error("Package manifest must be a JSON object.");
  }
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error("Package manifest version must be a non-empty string.");
  }
  if (manifest.channel !== "alpha" && manifest.channel !== "release") {
    throw new Error(`Package manifest channel is unsupported: ${String(manifest.channel)}.`);
  }

  const sourceCommit = typeof manifest.sourceCommit === "string" ? manifest.sourceCommit.trim() : "";
  if (sourceCommit && !commitPattern.test(sourceCommit)) {
    throw new Error("Package manifest sourceCommit must be a 7-64 character lowercase hexadecimal SHA.");
  }
  if (requireSourceCommit && !sourceCommit) {
    throw new Error("Package manifest sourceCommit is required for RC provenance binding.");
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const dmgArtifacts = artifacts.filter((artifact) => typeof artifact === "string" && artifact.endsWith(".dmg"));
  if (dmgArtifacts.length !== 1) {
    throw new Error(`Package manifest must contain exactly one primary DMG artifact; found ${dmgArtifacts.length}.`);
  }

  const artifactMetadata = Array.isArray(manifest.artifactMetadata) ? manifest.artifactMetadata : [];
  const primaryArtifact = dmgArtifacts[0];
  const manifestDirectory = path.dirname(resolvedManifestPath);
  const primaryArtifactPath = resolveManifestReference(primaryArtifact, manifestDirectory);
  const primaryMetadata = artifactMetadata.find((entry) => (
    isRecord(entry) &&
    typeof entry.path === "string" &&
    resolveManifestReference(entry.path, manifestDirectory) === primaryArtifactPath
  ));
  if (!primaryMetadata) {
    throw new Error(`Package manifest is missing artifact metadata for ${primaryArtifact}.`);
  }
  if (!sha256Pattern.test(String(primaryMetadata.sha256 ?? ""))) {
    throw new Error(`Package manifest has an invalid primary DMG SHA-256 for ${primaryArtifact}.`);
  }

  return {
    manifest,
    manifestPath: resolvedManifestPath,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    version: manifest.version,
    channel: manifest.channel,
    sourceCommit: sourceCommit || undefined,
    primaryArtifact,
    primaryArtifactFileName: typeof primaryMetadata.fileName === "string"
      ? primaryMetadata.fileName
      : path.basename(primaryArtifactPath),
    primaryArtifactSha256: primaryMetadata.sha256
  };
}

export function validateCommit(value, label = "Commit") {
  const commit = String(value ?? "").trim();
  if (!commitPattern.test(commit)) {
    throw new Error(`${label} must be a 7-64 character lowercase hexadecimal SHA.`);
  }
  return commit;
}

function resolveManifestReference(reference, manifestDirectory) {
  return path.resolve(manifestDirectory, reference);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
