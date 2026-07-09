import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  exportDeck,
  type CompilerProjectInput
} from "@htmlslide/compiler";
import { loadDeckProject } from "@htmlslide/core";
import { checkProject } from "@htmlslide/linter";
import {
  applyPresenterKeyboardAction,
  createPresenterSession,
  createRehearsalPresenterDeck,
  getPresenterSessionView
} from "../../packages/presenter/src/session.js";
import { loadProjectPreview } from "../../apps/desktop/electron/desktop-services.js";

type PerformanceMetric = {
  name: string;
  description: string;
  elapsedMs: number;
  targetMs: number;
  guardrailMs: number;
  targetPassed: boolean;
  guardrailPassed: boolean;
};

type PerformanceReport = {
  schemaVersion: "0.1.0";
  generatedAt: string;
  slideCount: number;
  node: string;
  platform: string;
  arch: string;
  projectPath: string;
  metrics: PerformanceMetric[];
};

const SLIDE_COUNT = 20;
const SHOULD_KEEP_PROJECT = process.env.HTMLSLIDE_PERF_KEEP === "1";
const REPORT_PATH = path.resolve("dist", "performance", "performance-smoke.json");

const PERFORMANCE_BUDGETS = {
  warmProjectPreview: {
    targetMs: 2_000,
    guardrailMs: 10_000
  },
  singleSlidePreviewAfterChange: {
    targetMs: 500,
    guardrailMs: 5_000
  },
  exportTwentySlidePdf: {
    targetMs: 15_000,
    guardrailMs: 60_000
  },
  checkTwentySlideDeck: {
    targetMs: 10_000,
    guardrailMs: 60_000
  },
  presenterNextSlideAverage: {
    targetMs: 100,
    guardrailMs: 100
  }
} as const;

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-performance-"));
  const projectPath = path.join(tempRoot, "twenty-slide-deck");
  const metrics: PerformanceMetric[] = [];

  try {
    const project = await writeTwentySlideProject(projectPath);

    await loadProjectPreview(projectPath);
    metrics.push(await measure("warmProjectPreview", "Open 20-slide project preview after warm load.", () =>
      loadProjectPreview(projectPath)
    ));

    await writeSlide(projectPath, 1, "changed");
    const changedPreview = await measure("singleSlidePreviewAfterChange", "Reload preview after one typical slide file change.", () =>
      loadProjectPreview(projectPath)
    );
    metrics.push(changedPreview);

    const preview = await loadProjectPreview(projectPath);
    if (!preview.slides[0]?.html.includes("Revision changed")) {
      throw new Error("Performance fixture preview did not include the changed slide source.");
    }

    metrics.push(await measure("exportTwentySlidePdf", "Export a 20-slide PDF without AI/provider work.", async () => {
      const exported = await exportDeck(project, {
        pdf: true,
        html: false,
        deckpkg: false,
        thumbnails: false
      });
      if (exported.verification.pdfPageCount !== SLIDE_COUNT) {
        throw new Error(`Expected ${SLIDE_COUNT} exported PDF pages, got ${exported.verification.pdfPageCount ?? "none"}.`);
      }
    }));

    metrics.push(await measure("checkTwentySlideDeck", "Run the checker against a 20-slide source deck.", async () => {
      const report = await checkProject(projectPath);
      if (report.status !== "passed") {
        throw new Error(`Expected performance fixture check to pass, got ${report.status}.`);
      }
    }));

    metrics.push(measurePresenterNextSlideLatency(project));

    const report: PerformanceReport = {
      schemaVersion: "0.1.0",
      generatedAt: new Date().toISOString(),
      slideCount: SLIDE_COUNT,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      projectPath,
      metrics
    };

    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printReport(report);

    const failures = metrics.filter((metric) => !metric.guardrailPassed);
    if (failures.length > 0) {
      throw new Error(`Performance smoke guardrail failed: ${failures.map((metric) => metric.name).join(", ")}.`);
    }
  } finally {
    if (SHOULD_KEEP_PROJECT) {
      process.stdout.write(`Kept performance fixture at ${projectPath}\n`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function measure<T>(
  name: keyof typeof PERFORMANCE_BUDGETS,
  description: string,
  action: () => Promise<T>
): Promise<PerformanceMetric> {
  const start = performance.now();
  await action();
  const elapsedMs = roundMs(performance.now() - start);
  const budget = PERFORMANCE_BUDGETS[name];
  return {
    name,
    description,
    elapsedMs,
    targetMs: budget.targetMs,
    guardrailMs: budget.guardrailMs,
    targetPassed: elapsedMs <= budget.targetMs,
    guardrailPassed: elapsedMs <= budget.guardrailMs
  };
}

function measurePresenterNextSlideLatency(project: CompilerProjectInput): PerformanceMetric {
  const deck = createRehearsalPresenterDeck({
    title: project.title,
    slides: project.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      source: slide.sourcePath,
      notesPath: slide.notesPath,
      durationSec: slide.durationSec
    }))
  });
  let state = createPresenterSession(deck, { nowMs: 0 });
  const iterations = 5_000;
  const start = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    if (state.slideIndex === state.slideCount - 1) {
      state = createPresenterSession(deck, { nowMs: index });
    }
    state = applyPresenterKeyboardAction(deck, state, "next", { nowMs: index });
    getPresenterSessionView(deck, state, index);
  }

  const elapsedMs = roundMs((performance.now() - start) / iterations, 6);
  const budget = PERFORMANCE_BUDGETS.presenterNextSlideAverage;
  return {
    name: "presenterNextSlideAverage",
    description: "Average presenter next-slide state transition over 5000 iterations.",
    elapsedMs,
    targetMs: budget.targetMs,
    guardrailMs: budget.guardrailMs,
    targetPassed: elapsedMs <= budget.targetMs,
    guardrailPassed: elapsedMs <= budget.guardrailMs
  };
}

async function writeTwentySlideProject(projectPath: string): Promise<CompilerProjectInput> {
  await Promise.all([
    mkdir(path.join(projectPath, "slides"), { recursive: true }),
    mkdir(path.join(projectPath, "notes"), { recursive: true }),
    mkdir(path.join(projectPath, "theme"), { recursive: true })
  ]);

  await writeFile(
    path.join(projectPath, "theme", "theme.css"),
    `.performance-slide { font-family: Inter, Arial, sans-serif; color: #17202a; background: #f8fafc; }\n`,
    "utf8"
  );

  const slides = [];
  for (let index = 1; index <= SLIDE_COUNT; index += 1) {
    await writeSlide(projectPath, index, "initial");
    await writeFile(
      path.join(projectPath, "notes", slideFileName(index, "md")),
      `# Slide ${index} notes\n\nThese presenter notes provide enough local words for the checker to validate this performance fixture without warnings.\n`,
      "utf8"
    );
    slides.push({
      id: slideId(index),
      title: `Performance Slide ${index}`,
      source: `slides/${slideFileName(index, "html")}`,
      notes: `notes/${slideFileName(index, "md")}`,
      durationSec: 60,
      kind: index === 1 ? "title" : "content",
      status: "ready"
    });
  }

  await writeFile(
    path.join(projectPath, "deck.json"),
    `${JSON.stringify({
      schemaVersion: "0.1.0",
      appVersion: "0.1.0",
      id: "performance_twenty_slide_deck",
      title: "Performance Twenty Slide Deck",
      language: "en-US",
      aspectRatio: "16:9",
      viewport: {
        width: 1920,
        height: 1080
      },
      safeArea: {
        top: 72,
        right: 96,
        bottom: 72,
        left: 96
      },
      theme: {
        css: "theme/theme.css"
      },
      slides,
      export: {
        pdf: false,
        html: false,
        deckpkg: false,
        thumbnails: false,
        speakerNotes: false
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const loaded = await loadDeckProject(projectPath);
  return {
    projectPath,
    title: loaded.deck.title,
    language: loaded.deck.language,
    viewport: loaded.deck.viewport,
    safeArea: loaded.deck.safeArea,
    themeCssPath: loaded.deck.theme?.css,
    slides: loaded.deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes,
      durationSec: slide.durationSec
    }))
  };
}

async function writeSlide(projectPath: string, index: number, revision: string): Promise<void> {
  await writeFile(
    path.join(projectPath, "slides", slideFileName(index, "html")),
    `<section class="slide performance-slide" data-slide-id="${slideId(index)}">
  <h1>Performance Slide ${index}</h1>
  <p>Revision ${revision} keeps the preview path deterministic and local.</p>
  <ul>
    <li>Local project files only</li>
    <li>Stable 16:9 layout</li>
    <li>Twenty slide performance smoke</li>
  </ul>
</section>
`,
    "utf8"
  );
}

function slideId(index: number): string {
  return `slide-${String(index).padStart(2, "0")}`;
}

function slideFileName(index: number, extension: "html" | "md"): string {
  return `${slideId(index)}.${extension}`;
}

function roundMs(value: number, decimalPlaces = 3): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

function printReport(report: PerformanceReport): void {
  const rows = report.metrics.map((metric) => ({
    metric: metric.name,
    elapsedMs: metric.elapsedMs,
    targetMs: metric.targetMs,
    guardrailMs: metric.guardrailMs,
    target: metric.targetPassed ? "pass" : "miss",
    guardrail: metric.guardrailPassed ? "pass" : "fail"
  }));
  console.table(rows);
  process.stdout.write(`Performance smoke report: ${REPORT_PATH}\n`);
}

await main();
