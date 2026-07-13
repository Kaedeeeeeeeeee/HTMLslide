import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportDeck,
  rasterizePdfPages,
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
    tokens?: string;
  };
  slides: Array<{
    id: string;
    title: string;
    source: string;
    notes?: string;
    durationSec?: number;
  }>;
};

type PdfVisualFixture = {
  name: string;
  slideIds: string[];
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRootPath = path.resolve(testDir, "../../test-fixtures/decks");
const goldenRootPath = path.resolve(testDir, "goldens");
const visualDiffOutputPath = path.resolve(testDir, "../../../dist/visual-regression/pdf");
const pdfGoldenPlatform = `${process.platform}-${process.arch}`;
const pdfDiffThreshold = 0.002;
const updatePdfGoldens = process.env.HTMLSLIDE_UPDATE_PDF_GOLDENS === "1";
const pdfVisualFixtures = [
  {
    name: "browser-visual-deck",
    slideIds: ["001-composition", "002-chart"]
  }
] satisfies PdfVisualFixture[];

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const loadCompilerProject = async (projectPath: string): Promise<CompilerProjectInput> => {
  const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as DeckJson;
  return {
    projectPath,
    title: deck.title,
    language: deck.language,
    viewport: deck.viewport,
    safeArea: deck.safeArea,
    themeCssPath: deck.theme?.css,
    themeTokensPath: deck.theme?.tokens,
    slides: deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes,
      durationSec: slide.durationSec
    }))
  };
};

const copyCompilerFixture = async (
  fixtureName: string
): Promise<{ root: string; project: CompilerProjectInput }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-pdf-visual-"));
  temporaryRoots.push(root);
  const projectPath = path.join(root, fixtureName);
  await cp(path.join(fixtureRootPath, fixtureName), projectPath, { recursive: true });
  return { root, project: await loadCompilerProject(projectPath) };
};

const assertGoldenExists = async (goldenPath: string, actualPath: string, artifactName: string): Promise<void> => {
  try {
    await access(goldenPath);
  } catch {
    await mkdir(visualDiffOutputPath, { recursive: true });
    await copyFile(actualPath, path.join(visualDiffOutputPath, `${artifactName}-after.png`));
    throw new Error(
      `Missing PDF visual golden: ${goldenPath}. Run HTMLSLIDE_UPDATE_PDF_GOLDENS=1 pnpm test:visual:browser to refresh this platform baseline.`
    );
  }
};

describe("PDF raster visual regression", () => {
  it.each(pdfVisualFixtures)(
    "matches Poppler rasterized PDF pages for $name",
    async ({ name, slideIds }) => {
      const { root, project } = await copyCompilerFixture(name);
      await rm(visualDiffOutputPath, { recursive: true, force: true });

      const exported = await exportDeck(project, {
        pdf: true,
        html: false,
        deckpkg: false,
        thumbnails: false
      });
      expect(exported.artifacts.pdf).toBeTruthy();

      const rasterized = await rasterizePdfPages({
        pdfPath: exported.artifacts.pdf!,
        outputDirectory: path.join(root, "rasterized-pdf"),
        expectedPageCount: slideIds.length,
        expectedPageDimensions: project.viewport,
        dpi: 96,
        timeoutMs: 30_000
      });
      expect(rasterized.pages).toHaveLength(slideIds.length);
      expect(rasterized.pages.map((page) => ({ width: page.width, height: page.height }))).toEqual(
        slideIds.map(() => project.viewport)
      );

      for (const [index, slideId] of slideIds.entries()) {
        const actualPath = rasterized.pages[index]?.path;
        expect(actualPath).toBeTruthy();
        const goldenPath = path.join(goldenRootPath, name, "pdf", pdfGoldenPlatform, `${slideId}.png`);

        if (updatePdfGoldens) {
          await mkdir(path.dirname(goldenPath), { recursive: true });
          await copyFile(actualPath!, goldenPath);
          continue;
        }

        await assertGoldenExists(goldenPath, actualPath!, `${name}-${slideId}-pdf`);
        const result = await comparePngWithGolden({
          actualPath: actualPath!,
          goldenPath,
          artifactDir: visualDiffOutputPath,
          artifactName: `${name}-${slideId}-pdf`,
          maxDiffRatio: pdfDiffThreshold
        });
        expect({ width: result.width, height: result.height }).toEqual(project.viewport);
        expect(result.diffRatio, result.message).toBeLessThanOrEqual(pdfDiffThreshold);
      }
    },
    60_000
  );
});
