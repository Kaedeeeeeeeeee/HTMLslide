import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSlidePreviewDocument,
  exportDeck,
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

type BrowserVisualFixture = {
  name: string;
  slideIds: string[];
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRootPath = path.resolve(testDir, "../../test-fixtures/decks");
const goldenOutputRootPath = path.resolve(testDir, "goldens");
const browserVisualDiffOutputPath = path.resolve(testDir, "../../../dist/visual-regression/renderer");
const browserSlideDiffThreshold = 0.002;
const updateBrowserGoldens = process.env.HTMLSLIDE_UPDATE_BROWSER_GOLDENS === "1";
const browserVisualFixtures = [
  {
    name: "browser-visual-deck",
    slideIds: ["001-composition", "002-chart"]
  }
] satisfies BrowserVisualFixture[];

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
): Promise<{ root: string; projectPath: string; project: CompilerProjectInput }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-browser-visual-"));
  const projectPath = path.join(root, fixtureName);
  await cp(path.join(fixtureRootPath, fixtureName), projectPath, { recursive: true });
  return {
    root,
    projectPath,
    project: await loadCompilerProject(projectPath)
  };
};

const assertGoldenExists = async (goldenPath: string): Promise<void> => {
  try {
    await access(goldenPath);
  } catch {
    throw new Error(
      `Missing browser visual golden: ${goldenPath}. Run HTMLSLIDE_UPDATE_BROWSER_GOLDENS=1 pnpm test -- packages/compiler/test/browser-visual-regression.test.ts to refresh baselines.`
    );
  }
};

const waitForPageAssets = async (page: Page | Frame): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) => {
        if (image.complete) {
          return undefined;
        }
        return new Promise<void>((resolve, reject) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => reject(new Error(`Image failed to load: ${image.currentSrc}`)), {
            once: true
          });
        });
      })
    );
  });
};

describe("browser-rendered visual regression", () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each(browserVisualFixtures)(
    "matches full-slide browser screenshot goldens for $name",
    async ({ name, slideIds }) => {
      const { root, project } = await copyCompilerFixture(name);
      if (!browser) {
        throw new Error("Chromium was not available for browser visual regression.");
      }

      const context = await browser.newContext({
        colorScheme: "light",
        deviceScaleFactor: 1,
        locale: "en-US",
        reducedMotion: "reduce",
        viewport: project.viewport
      });
      try {
        await rm(browserVisualDiffOutputPath, { recursive: true, force: true });
        const exported = await exportDeck(project);
        expect(exported.artifacts.html).toBeTruthy();

        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            consoleErrors.push(message.text());
          }
        });
        page.on("pageerror", (error) => consoleErrors.push(error.message));

        await page.emulateMedia({ media: "print" });
        await page.goto(pathToFileURL(exported.artifacts.html!).href, { waitUntil: "load" });
        await waitForPageAssets(page);

        for (const slideId of slideIds) {
          const slide = page.locator(`.htmlslide-page[data-slide-id="${slideId}"]`);
          await expect(await slide.count()).toBe(1);
          await slide.scrollIntoViewIfNeeded();

          const screenshotPath = path.join(root, `${slideId}.png`);
          await slide.screenshot({
            animations: "disabled",
            caret: "hide",
            path: screenshotPath
          });
          expect(readPngSize(await readFile(screenshotPath))).toEqual(project.viewport);

          const goldenPath = path.join(goldenOutputRootPath, name, "browser", `${slideId}.png`);
          if (updateBrowserGoldens) {
            await mkdir(path.dirname(goldenPath), { recursive: true });
            await copyFile(screenshotPath, goldenPath);
          } else {
            await assertGoldenExists(goldenPath);
            const result = await comparePngWithGolden({
              actualPath: screenshotPath,
              goldenPath,
              artifactDir: browserVisualDiffOutputPath,
              artifactName: `${name}-${slideId}`,
              maxDiffRatio: browserSlideDiffThreshold
            });

            expect({
              height: result.height,
              width: result.width
            }).toEqual(project.viewport);
            expect(result.diffRatio, result.message).toBeLessThanOrEqual(browserSlideDiffThreshold);
          }
        }

        await page.close();

        const parityPage = await context.newPage();
        parityPage.on("console", (message) => {
          if (message.type() === "error") {
            consoleErrors.push(message.text());
          }
        });
        parityPage.on("pageerror", (error) => consoleErrors.push(error.message));
        await parityPage.emulateMedia({ media: "screen" });
        await parityPage.goto(pathToFileURL(exported.artifacts.html!).href, { waitUntil: "load" });
        await waitForPageAssets(parityPage);
        await parityPage.addStyleTag({
          content: ".htmlslide-deck { display: block; padding: 0; gap: 0; } .htmlslide-page { box-shadow: none; outline: none; }"
        });
        for (const slideId of slideIds) {
          await parityPage.locator(".htmlslide-page").evaluateAll((pages, selectedSlideId) => {
            for (const page of pages) {
              if (page instanceof HTMLElement) {
                page.style.display = page.dataset.slideId === selectedSlideId ? "block" : "none";
              }
            }
          }, slideId);
          const paritySlide = parityPage.locator(`.htmlslide-page[data-slide-id="${slideId}"]`);
          await paritySlide.scrollIntoViewIfNeeded();
          await paritySlide.screenshot({
            animations: "disabled",
            caret: "hide",
            path: path.join(root, `${slideId}-screen-export.png`)
          });
        }
        await parityPage.close();

        for (const slideId of slideIds) {
          const screenshotPath = path.join(root, `${slideId}-screen-export.png`);
          const preview = await buildSlidePreviewDocument(project.projectPath, { slideId });
          const previewPage = await context.newPage();

          const previewScreenshotPath = path.join(root, `${slideId}-preview.png`);
          try {
            const previewUrl = `data:text/html;base64,${Buffer.from(preview.htmlDocument).toString("base64")}`;
            await previewPage.goto(previewUrl, { waitUntil: "load" });
            const previewSlide = previewPage.locator(`.htmlslide-page[data-slide-id="${slideId}"]`);
            await previewSlide.waitFor();
            await waitForPageAssets(previewPage);
            await previewSlide.screenshot({
              animations: "disabled",
              caret: "hide",
              path: previewScreenshotPath
            });
          } finally {
            await previewPage.close();
          }
          expect(readPngSize(await readFile(previewScreenshotPath))).toEqual(project.viewport);

          const previewParity = await comparePngWithGolden({
            actualPath: previewScreenshotPath,
            goldenPath: screenshotPath,
            artifactDir: browserVisualDiffOutputPath,
            artifactName: `${name}-${slideId}-preview-parity`,
            maxDiffRatio: browserSlideDiffThreshold
          });

          expect({
            height: previewParity.height,
            width: previewParity.width
          }).toEqual(project.viewport);
          expect(previewParity.diffRatio, previewParity.message).toBeLessThanOrEqual(browserSlideDiffThreshold);
        }

        expect(consoleErrors).toEqual([]);
      } finally {
        await context.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
