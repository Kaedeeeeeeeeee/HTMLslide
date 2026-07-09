import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildDeckPackageManifest,
  exportDeck,
  readPdfPageCount,
  readPngSize,
  type CompilerProjectInput
} from "../src/index";
import { comparePngWithGolden } from "./png-visual-diff";

type DeckJson = {
  title: string;
  language?: string;
  viewport: CompilerProjectInput["viewport"];
  safeArea?: CompilerProjectInput["safeArea"];
  theme?: {
    css?: string;
  };
  slides: Array<{
    id: string;
    title: string;
    source: string;
    notes?: string;
    durationSec?: number;
  }>;
};

type CompilerRegressionFixture = {
  name: string;
  expectedSlideCount: number;
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRootPath = path.resolve(testDir, "../../test-fixtures/decks");
const goldenOutputRootPath = path.resolve(testDir, "goldens");
const basicFixtureName = "golden-export-basic";
const visualDiffOutputPath = path.resolve(testDir, "../../../dist/visual-regression/compiler");
const fallbackThumbnailDiffThreshold = 0;
const compilerRegressionFixtures = [
  { name: "minimal-deck", expectedSlideCount: 1 },
  { name: "text-heavy-deck", expectedSlideCount: 2 },
  { name: "data-chart-deck", expectedSlideCount: 2 },
  { name: "image-heavy-deck", expectedSlideCount: 2 },
  { name: "notes-deck", expectedSlideCount: 2 },
  { name: "multi-theme-deck", expectedSlideCount: 3 }
] satisfies CompilerRegressionFixture[];
const visualGoldenFixtures = [
  { name: basicFixtureName, expectedSlideCount: 2 },
  ...compilerRegressionFixtures
] satisfies CompilerRegressionFixture[];

const copyCompilerFixture = async (
  fixtureName: string
): Promise<{ root: string; projectPath: string; project: CompilerProjectInput }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-export-"));
  const projectPath = path.join(root, fixtureName);
  await cp(path.join(fixtureRootPath, fixtureName), projectPath, { recursive: true });
  return {
    root,
    projectPath,
    project: await loadCompilerProject(projectPath)
  };
};

const loadCompilerProject = async (projectPath: string): Promise<CompilerProjectInput> => {
  const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as DeckJson;
  return {
    projectPath,
    title: deck.title,
    language: deck.language,
    viewport: deck.viewport,
    safeArea: deck.safeArea,
    themeCssPath: deck.theme?.css,
    slides: deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes,
      durationSec: slide.durationSec
    }))
  };
};

const zipText = async (zip: JSZip, filePath: string): Promise<string> => {
  const file = zip.file(filePath);
  expect(file).toBeTruthy();
  return file!.async("string");
};

const zipBytes = async (zip: JSZip, filePath: string): Promise<Uint8Array> => {
  const file = zip.file(filePath);
  expect(file).toBeTruthy();
  return file!.async("uint8array");
};

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const artifactHashes = async (project: CompilerProjectInput) => {
  const exported = await exportDeck(project);
  expect(exported.artifacts.pdf).toBeTruthy();
  expect(exported.artifacts.html).toBeTruthy();
  expect(exported.artifacts.deckpkg).toBeTruthy();
  expect(exported.artifacts.notes).toBeTruthy();
  expect(exported.artifacts.thumbnails).toHaveLength(project.slides.length);

  return {
    pdf: sha256(await readFile(exported.artifacts.pdf!)),
    html: sha256(await readFile(exported.artifacts.html!, "utf8")),
    deckpkg: sha256(await readFile(exported.artifacts.deckpkg!)),
    notes: sha256(await readFile(exported.artifacts.notes!, "utf8")),
    thumbnails: await Promise.all((exported.artifacts.thumbnails ?? []).map(async (thumbnailPath) =>
      sha256(await readFile(thumbnailPath))
    ))
  };
};

describe("exportDeck", () => {
  it("writes verifiable HTML, PDF, notes, thumbnails, and deckpkg artifacts", async () => {
    const { root, projectPath, project } = await copyCompilerFixture(basicFixtureName);
    try {
      const exported = await exportDeck(project);

      expect(exported.verification).toEqual({
        expectedPageCount: 2,
        pdfPageCount: 2,
        pdfPageCountMatches: true
      });
      expect(exported.artifacts.pdf).toBe(path.join(projectPath, "exports", "golden-export-basic.pdf"));
      expect(exported.artifacts.html).toBe(path.join(projectPath, "exports", "golden-export-basic.html"));
      expect(exported.artifacts.deckpkg).toBe(path.join(projectPath, "exports", "golden-export-basic.deckpkg"));
      expect(exported.artifacts.notes).toBe(path.join(projectPath, "exports", "notes.json"));
      expect(exported.artifacts.thumbnails).toHaveLength(2);
      expect(exported.artifacts.thumbnailCache).toHaveLength(2);

      const html = await readFile(exported.artifacts.html!, "utf8");
      expect(html).toContain('data-htmlslide-mode="print"');
      expect(html).toContain('id="htmlslide-notes"');
      expect(html).toContain("htmlslide-notes-panel");
      expect(html).toContain('src="../assets/accent.svg"');
      expect(html).toContain('url("../assets/accent.svg")');
      expect(html).not.toContain("alpha export skeleton");

      const notes = JSON.parse(await readFile(exported.artifacts.notes!, "utf8"));
      expect(notes).toMatchObject({
        schemaVersion: "0.1.0",
        title: "Golden Export Basic",
        language: "en-US",
        slideCount: 2
      });
      expect(notes.slides.map((slide: { id: string; pdfPage: number; notesPath: string }) => ({
        id: slide.id,
        pdfPage: slide.pdfPage,
        notesPath: slide.notesPath
      }))).toEqual([
        { id: "001-title", pdfPage: 1, notesPath: "notes/001-title.md" },
        { id: "002-artifacts", pdfPage: 2, notesPath: "notes/002-artifacts.md" }
      ]);
      expect(notes.slides[0].markdown).toContain("fixed artifact contract");

      expect(await readPdfPageCount(exported.artifacts.pdf!)).toBe(2);

      const firstThumbnail = await readFile(exported.artifacts.thumbnails![0]!);
      const secondThumbnail = await readFile(exported.artifacts.thumbnails![1]!);
      expect(readPngSize(firstThumbnail)).toEqual({ width: 960, height: 540 });
      expect(readPngSize(secondThumbnail)).toEqual({ width: 960, height: 540 });
      expect(sha256(firstThumbnail)).not.toBe(sha256(secondThumbnail));

      const deckpkg = await JSZip.loadAsync(await readFile(exported.artifacts.deckpkg!));
      expect(deckpkg.file("manifest.json")).toBeTruthy();
      expect(deckpkg.file("deck.html")).toBeTruthy();
      expect(deckpkg.file("deck.pdf")).toBeTruthy();
      expect(deckpkg.file("notes.json")).toBeTruthy();
      expect(deckpkg.file("presenter-settings.json")).toBeTruthy();
      expect(deckpkg.file("thumbnails/001-title.png")).toBeTruthy();
      expect(deckpkg.file("thumbnails/002-artifacts.png")).toBeTruthy();

      const manifest = JSON.parse(await zipText(deckpkg, "manifest.json"));
      expect(manifest).toMatchObject({
        schemaVersion: "0.1.0",
        title: "Golden Export Basic",
        pdf: "deck.pdf",
        html: "deck.html",
        notes: "notes.json",
        pageCount: 2,
        slideCount: 2,
        thumbnailSize: { width: 960, height: 540 }
      });
      expect(manifest.slides).toEqual([
        {
          id: "001-title",
          title: "Deterministic HTML",
          index: 0,
          pdfPage: 1,
          source: "slides/001-title.html",
          thumbnail: "thumbnails/001-title.png",
          notes: "notes/001-title.md",
          durationSec: 45
        },
        {
          id: "002-artifacts",
          title: "Artifact Map",
          index: 1,
          pdfPage: 2,
          source: "slides/002-artifacts.html",
          thumbnail: "thumbnails/002-artifacts.png",
          notes: "notes/002-artifacts.md",
          durationSec: 75
        }
      ]);

      expect(await readPdfPageCount(await zipBytes(deckpkg, "deck.pdf"))).toBe(2);
      expect(JSON.parse(await zipText(deckpkg, "notes.json"))).toEqual(notes);
      expect(readPngSize(await zipBytes(deckpkg, "thumbnails/001-title.png"))).toEqual({ width: 960, height: 540 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds manifest page mappings without writing files", () => {
    const project: CompilerProjectInput = {
      projectPath: "/tmp/no-write",
      title: "Manifest Only",
      language: "en-US",
      viewport: { width: 1920, height: 1080 },
      slides: [
        { id: "a", title: "A", sourcePath: "slides/a.html", notesPath: "notes/a.md", durationSec: 10 },
        { id: "b", title: "B", sourcePath: "slides/b.html" }
      ]
    };

    expect(buildDeckPackageManifest(project, { thumbnailSize: { width: 384, height: 216 } })).toMatchObject({
      pdf: "deck.pdf",
      html: "deck.html",
      pageCount: 2,
      thumbnailSize: { width: 384, height: 216 },
      slides: [
        { id: "a", index: 0, pdfPage: 1, thumbnail: "thumbnails/a.png", notes: "notes/a.md", durationSec: 10 },
        { id: "b", index: 1, pdfPage: 2, thumbnail: "thumbnails/b.png", notes: null, durationSec: 60 }
      ]
    });
  });

  it.each(compilerRegressionFixtures)("exports compiler regression fixture $name", async ({ name, expectedSlideCount }) => {
    const { root, project, projectPath } = await copyCompilerFixture(name);
    try {
      const exported = await exportDeck(project);
      expect(exported.verification).toEqual({
        expectedPageCount: expectedSlideCount,
        pdfPageCount: expectedSlideCount,
        pdfPageCountMatches: true
      });
      expect(exported.artifacts.pdf).toBeTruthy();
      expect(exported.artifacts.html).toBeTruthy();
      expect(exported.artifacts.deckpkg).toBeTruthy();
      expect(exported.artifacts.notes).toBeTruthy();
      expect(exported.artifacts.thumbnails).toHaveLength(expectedSlideCount);
      expect(exported.artifacts.thumbnailCache).toHaveLength(expectedSlideCount);
      expect(await readPdfPageCount(exported.artifacts.pdf!)).toBe(expectedSlideCount);

      const notes = JSON.parse(await readFile(exported.artifacts.notes!, "utf8"));
      expect(notes.slideCount).toBe(expectedSlideCount);
      expect(notes.slides.map((slide: { pdfPage: number }) => slide.pdfPage)).toEqual(
        Array.from({ length: expectedSlideCount }, (_value, index) => index + 1)
      );
      expect(notes.slides.map((slide: { id: string; notesPath: string | null; hasNotes: boolean }) => ({
        hasNotes: slide.hasNotes,
        id: slide.id,
        notesPath: slide.notesPath
      }))).toEqual(project.slides.map((slide) => ({
        hasNotes: slide.notesPath !== undefined,
        id: slide.id,
        notesPath: slide.notesPath ?? null
      })));

      const deckpkg = await JSZip.loadAsync(await readFile(exported.artifacts.deckpkg!));
      const manifest = JSON.parse(await zipText(deckpkg, "manifest.json"));
      expect(manifest.slideCount).toBe(expectedSlideCount);
      expect(manifest.pageCount).toBe(expectedSlideCount);
      expect(manifest.slides.map((slide: { id: string }) => slide.id)).toEqual(
        project.slides.map((slide) => slide.id)
      );
      expect(manifest.slides.map((slide: { id: string; notes: string | null }) => ({
        id: slide.id,
        notes: slide.notes
      }))).toEqual(project.slides.map((slide) => ({
        id: slide.id,
        notes: slide.notesPath ?? null
      })));

      for (const slide of project.slides) {
        const thumbnailPath = path.join(projectPath, "exports", "thumbnails", `${slide.id}.png`);
        expect(readPngSize(await readFile(thumbnailPath))).toEqual({ width: 960, height: 540 });
        expect(readPngSize(await zipBytes(deckpkg, `thumbnails/${slide.id}.png`))).toEqual({ width: 960, height: 540 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(visualGoldenFixtures)("matches golden fallback thumbnail PNGs for $name", async ({ name }) => {
    const { root, project } = await copyCompilerFixture(name);
    try {
      await rm(visualDiffOutputPath, { recursive: true, force: true });
      const exported = await exportDeck(project);
      expect(exported.artifacts.thumbnails).toHaveLength(project.slides.length);

      for (const thumbnailPath of exported.artifacts.thumbnails ?? []) {
        const result = await comparePngWithGolden({
          actualPath: thumbnailPath,
          goldenPath: path.join(goldenOutputRootPath, name, "thumbnails", path.basename(thumbnailPath)),
          artifactDir: visualDiffOutputPath,
          artifactName: `${name}-${path.basename(thumbnailPath, ".png")}`,
          maxDiffRatio: fallbackThumbnailDiffThreshold
        });
        expect({
          height: result.height,
          width: result.width
        }).toEqual({ width: 960, height: 540 });
        expect(result.diffRatio, result.message).toBeLessThanOrEqual(fallbackThumbnailDiffThreshold);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes visual diff artifacts when a thumbnail exceeds the diff threshold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-visual-diff-"));
    try {
      const artifactDir = path.join(root, "artifacts");
      const result = await comparePngWithGolden({
        actualPath: path.join(goldenOutputRootPath, basicFixtureName, "thumbnails", "001-title.png"),
        goldenPath: path.join(goldenOutputRootPath, basicFixtureName, "thumbnails", "002-artifacts.png"),
        artifactDir,
        artifactName: "thumbnail-mismatch",
        maxDiffRatio: 0
      });

      expect(result.diffRatio).toBeGreaterThan(0);
      expect(result.artifactsWritten).toBe(true);
      await expect(access(path.join(artifactDir, "thumbnail-mismatch-before.png"))).resolves.toBeUndefined();
      await expect(access(path.join(artifactDir, "thumbnail-mismatch-after.png"))).resolves.toBeUndefined();
      await expect(access(path.join(artifactDir, "thumbnail-mismatch-diff.png"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(visualGoldenFixtures)("is deterministic across repeated exports of $name", async ({ name }) => {
    const { root, project } = await copyCompilerFixture(name);
    try {
      const first = await artifactHashes(project);
      const second = await artifactHashes(project);
      expect(second).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
