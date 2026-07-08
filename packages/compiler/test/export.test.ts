import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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

const testDir = path.dirname(fileURLToPath(import.meta.url));
const goldenFixturePath = path.resolve(testDir, "../../test-fixtures/decks/golden-export-basic");
const goldenOutputPath = path.resolve(testDir, "goldens/golden-export-basic");

const copyGoldenFixture = async (): Promise<{ root: string; projectPath: string; project: CompilerProjectInput }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-export-"));
  const projectPath = path.join(root, "golden-export-basic");
  await cp(goldenFixturePath, projectPath, { recursive: true });
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

const expectBytesToMatchGolden = async (actualPath: string, goldenPath: string): Promise<void> => {
  const actual = await readFile(actualPath);
  const golden = await readFile(goldenPath);
  expect({
    bytes: actual.byteLength,
    hash: sha256(actual)
  }).toEqual({
    bytes: golden.byteLength,
    hash: sha256(golden)
  });
};

const artifactHashes = async (project: CompilerProjectInput) => {
  const exported = await exportDeck(project);
  expect(exported.artifacts.pdf).toBeTruthy();
  expect(exported.artifacts.html).toBeTruthy();
  expect(exported.artifacts.deckpkg).toBeTruthy();
  expect(exported.artifacts.notes).toBeTruthy();
  expect(exported.artifacts.thumbnails).toHaveLength(2);

  return {
    pdf: sha256(await readFile(exported.artifacts.pdf!)),
    html: sha256(await readFile(exported.artifacts.html!, "utf8")),
    deckpkg: sha256(await readFile(exported.artifacts.deckpkg!)),
    notes: sha256(await readFile(exported.artifacts.notes!, "utf8")),
    firstThumbnail: sha256(await readFile(exported.artifacts.thumbnails![0]!)),
    secondThumbnail: sha256(await readFile(exported.artifacts.thumbnails![1]!))
  };
};

describe("exportDeck", () => {
  it("writes verifiable HTML, PDF, notes, thumbnails, and deckpkg artifacts", async () => {
    const { root, projectPath, project } = await copyGoldenFixture();
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

  it("matches golden fallback thumbnail PNGs", async () => {
    const { root, project } = await copyGoldenFixture();
    try {
      const exported = await exportDeck(project);
      expect(exported.artifacts.thumbnails).toHaveLength(2);

      for (const thumbnailPath of exported.artifacts.thumbnails ?? []) {
        await expectBytesToMatchGolden(
          thumbnailPath,
          path.join(goldenOutputPath, "thumbnails", path.basename(thumbnailPath))
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is deterministic across repeated exports of the same project", async () => {
    const { root, project } = await copyGoldenFixture();
    try {
      const first = await artifactHashes(project);
      const second = await artifactHashes(project);
      expect(second).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
