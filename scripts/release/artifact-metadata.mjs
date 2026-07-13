import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function buildArtifactMetadata(artifactPaths, { relativeTo } = {}) {
  return Promise.all(artifactPaths.map(async (artifactPath) => {
    const [bytes, stats] = await Promise.all([
      readFile(artifactPath),
      stat(artifactPath)
    ]);

    return {
      path: relativeTo
        ? path.relative(relativeTo, artifactPath).split(path.sep).join("/")
        : artifactPath,
      fileName: path.basename(artifactPath),
      sizeBytes: stats.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }));
}
