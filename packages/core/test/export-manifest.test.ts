import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedFingerprintPaths,
  createExportManifest,
  ExportManifestSchema,
  fingerprintEntriesDigest,
  fingerprintProjectFile,
  sha256Hex,
  type ExportArtifactFingerprint,
  type ExportFileFingerprint
} from "../src/index.js";

const fingerprint = (filePath: string, contents: string): ExportFileFingerprint => ({
  path: filePath,
  sizeBytes: Buffer.byteLength(contents),
  sha256: sha256Hex(contents)
});

describe("export manifest", () => {
  it("sorts entries and builds a self-consistent deterministic source digest", () => {
    const sources = [fingerprint("slides/b.html", "b"), fingerprint("deck.json", "deck")];
    const artifacts: ExportArtifactFingerprint[] = [
      { ...fingerprint("exports/deck.pdf", "pdf"), kind: "pdf" },
      { ...fingerprint("exports/notes.json", "notes"), kind: "notes" }
    ];

    const manifest = createExportManifest({ sources, artifacts });

    expect(manifest.sources.map((entry) => entry.path)).toEqual(["deck.json", "slides/b.html"]);
    expect(manifest.artifacts.map((entry) => entry.path)).toEqual(["exports/deck.pdf", "exports/notes.json"]);
    expect(manifest.sourceDigest).toBe(fingerprintEntriesDigest(manifest.sources));
    expect(ExportManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects traversal, export sources, duplicate paths, and inconsistent source digests", () => {
    const source = fingerprint("deck.json", "deck");
    const artifact = { ...fingerprint("exports/notes.json", "notes"), kind: "notes" as const };
    const manifest = createExportManifest({ sources: [source], artifacts: [artifact] });

    expect(ExportManifestSchema.safeParse({
      ...manifest,
      sources: [{ ...source, path: "../deck.json" }]
    }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({
      ...manifest,
      sources: [{ ...source, path: "exports/deck.html" }]
    }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({
      ...manifest,
      sources: [source, source]
    }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({
      ...manifest,
      sourceDigest: sha256Hex("wrong")
    }).success).toBe(false);
  });

  it("enforces artifact kind metadata and portable path uniqueness", () => {
    const source = fingerprint("deck.json", "deck");
    const thumbnail = {
      ...fingerprint("exports/thumbnails/slide-a.png", "png"),
      kind: "thumbnail" as const,
      slideId: "slide-a"
    };
    const manifest = createExportManifest({ sources: [source], artifacts: [thumbnail] });

    expect(ExportManifestSchema.safeParse({
      ...manifest,
      artifacts: [{ ...thumbnail, slideId: undefined }]
    }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({
      ...manifest,
      artifacts: [{ ...thumbnail, kind: "pdf", slideId: "slide-a" }]
    }).success).toBe(false);
    expect(() => createExportManifest({
      sources: [fingerprint("slides/A.html", "a"), fingerprint("slides/a.html", "a")],
      artifacts: [thumbnail]
    })).toThrow("case-insensitive or Unicode-normalized path collisions");
  });

  it("fingerprints project files and reports changed, added, and removed paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-export-manifest-"));
    try {
      await mkdir(path.join(root, "slides"), { recursive: true });
      await writeFile(path.join(root, "deck.json"), "deck");
      await writeFile(path.join(root, "slides", "a.html"), "a");

      const recorded = [
        await fingerprintProjectFile(root, "deck.json"),
        await fingerprintProjectFile(root, "slides/a.html")
      ];
      await writeFile(path.join(root, "slides", "a.html"), "changed");
      await writeFile(path.join(root, "slides", "b.html"), "b");
      const current = [
        await fingerprintProjectFile(root, "slides/a.html"),
        await fingerprintProjectFile(root, "slides/b.html")
      ];

      expect(changedFingerprintPaths(current, recorded)).toEqual([
        "deck.json",
        "slides/a.html",
        "slides/b.html"
      ]);
      await expect(fingerprintProjectFile(root, "../outside.txt")).rejects.toThrow("Unsafe fingerprint path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects file and parent-directory symlinks that escape the project", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-export-symlink-"));
    const projectRoot = path.join(tempRoot, "project");
    const outsideRoot = path.join(tempRoot, "outside");
    try {
      await mkdir(path.join(projectRoot, "slides"), { recursive: true });
      await mkdir(outsideRoot);
      await writeFile(path.join(outsideRoot, "outside.html"), "outside");
      await symlink(path.join(outsideRoot, "outside.html"), path.join(projectRoot, "slides", "linked.html"));

      await expect(fingerprintProjectFile(projectRoot, "slides/linked.html")).rejects.toThrow(
        "must be a regular file"
      );

      await rm(path.join(projectRoot, "slides"), { recursive: true, force: true });
      await symlink(outsideRoot, path.join(projectRoot, "slides"));
      await expect(fingerprintProjectFile(projectRoot, "slides/outside.html")).rejects.toThrow(
        "escapes project root through a symlink"
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
