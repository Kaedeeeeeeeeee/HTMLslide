import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDeck, readPngSize, type CompilerProjectInput } from "../src/index";
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
            continue;
          }

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

        expect(consoleErrors).toEqual([]);
      } finally {
        await context.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
