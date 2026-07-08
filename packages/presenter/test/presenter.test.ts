import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  applyPresenterKeyboardAction,
  createPresenterSession,
  getCurrentSlide,
  getElapsedMs,
  getNextSlide,
  getPresenterKeyboardAction,
  getPresenterSessionView,
  getRemainingMs,
  increaseNotesFontSize,
  jumpToSlideId,
  jumpToSlideNumber,
  nextSlide,
  pauseTimer,
  previousSlide,
  readDeckPackage,
  resumeTimer,
  setNotesFontSize,
  toggleBlackScreen,
  toggleWhiteScreen,
  validateDeckPackage
} from "../src/index";

const ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

const manifest = {
  schemaVersion: "0.1.0",
  title: "Presenter Fixture",
  language: "en-US",
  viewport: { width: 1920, height: 1080 },
  safeArea: { top: 72, right: 96, bottom: 72, left: 96 },
  pdf: "deck.pdf",
  html: "deck.html",
  notes: "notes.json",
  presenterSettings: "presenter-settings.json",
  thumbnailSize: { width: 960, height: 540 },
  slideCount: 2,
  pageCount: 2,
  slides: [
    {
      id: "001-title",
      title: "Opening",
      index: 0,
      pdfPage: 1,
      source: "slides/001-title.html",
      thumbnail: "thumbnails/001-title.png",
      notes: "notes/001-title.md",
      durationSec: 45
    },
    {
      id: "002-plan",
      title: "Plan",
      index: 1,
      pdfPage: 2,
      source: "slides/002-plan.html",
      thumbnail: "thumbnails/002-plan.png",
      notes: "notes/002-plan.md",
      durationSec: 75
    }
  ]
};

const notes = {
  schemaVersion: "0.1.0",
  title: "Presenter Fixture",
  language: "en-US",
  slideCount: 2,
  slides: [
    {
      id: "001-title",
      title: "Opening",
      index: 0,
      pdfPage: 1,
      source: "slides/001-title.html",
      notesPath: "notes/001-title.md",
      durationSec: 45,
      hasNotes: true,
      markdown: "Open with the fixed artifact contract."
    },
    {
      id: "002-plan",
      title: "Plan",
      index: 1,
      pdfPage: 2,
      source: "slides/002-plan.html",
      notesPath: "notes/002-plan.md",
      durationSec: 75,
      hasNotes: true,
      markdown: "Explain rehearsal mode before dual-screen mode."
    }
  ]
};

const settings = {
  schemaVersion: "0.1.0",
  mode: "rehearsal",
  timer: true,
  notes: {
    visibleByDefault: false,
    fontSizePx: 22
  }
};

const writeFixtureDeckPackage = async (
  deckpkgPath: string,
  options: { omitSecondThumbnail?: boolean; notesOverride?: unknown } = {}
): Promise<void> => {
  const zip = new JSZip();
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, { date: ZIP_DATE });
  zip.file("deck.html", "<!doctype html><title>Presenter Fixture</title>\n", { date: ZIP_DATE });
  zip.file("deck.pdf", PDF_BYTES, { date: ZIP_DATE });
  zip.file("notes.json", `${JSON.stringify(options.notesOverride ?? notes, null, 2)}\n`, { date: ZIP_DATE });
  zip.file("presenter-settings.json", `${JSON.stringify(settings, null, 2)}\n`, { date: ZIP_DATE });
  zip.file("thumbnails/001-title.png", PNG_BYTES, { date: ZIP_DATE });
  if (!options.omitSecondThumbnail) {
    zip.file("thumbnails/002-plan.png", PNG_BYTES, { date: ZIP_DATE });
  }

  await writeFile(
    deckpkgPath,
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: {
        level: 9
      },
      platform: "UNIX"
    })
  );
};

const withFixtureDeckPackage = async <T>(
  test: (deckpkgPath: string) => Promise<T>,
  options: { omitSecondThumbnail?: boolean; notesOverride?: unknown } = {}
): Promise<T> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-presenter-"));
  try {
    const deckpkgPath = path.join(root, "presenter-fixture.deckpkg");
    await writeFixtureDeckPackage(deckpkgPath, options);
    return await test(deckpkgPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("@htmlslide/presenter deckpkg reader", () => {
  it("reads and validates a deterministic compiler-shaped deckpkg", async () => {
    await withFixtureDeckPackage(async (deckpkgPath) => {
      const deckPackage = await readDeckPackage(deckpkgPath);

      expect(deckPackage.sourcePath).toBe(deckpkgPath);
      expect(deckPackage.manifest.title).toBe("Presenter Fixture");
      expect(deckPackage.artifacts.html.text).toContain("<title>Presenter Fixture</title>");
      expect(deckPackage.artifacts.pdf.bytes.byteLength).toBeGreaterThan(0);
      expect(deckPackage.slides.map((slide) => [slide.id, slide.slideNumber, slide.notesMarkdown])).toEqual([
        ["001-title", 1, "Open with the fixed artifact contract."],
        ["002-plan", 2, "Explain rehearsal mode before dual-screen mode."]
      ]);
      expect(deckPackage.slides[0]?.thumbnail.size).toEqual({ width: 960, height: 540 });
    });
  });

  it("returns validation issues for malformed deckpkg assets", async () => {
    await withFixtureDeckPackage(
      async (deckpkgPath) => {
        const result = await validateDeckPackage(deckpkgPath);

        expect(result.status).toBe("failed");
        expect(result.summary.errors).toBeGreaterThan(0);
        expect(result.issues.map((issue) => issue.type)).toContain("missing-package-file");
        expect(result.issues.some((issue) => issue.path === "thumbnails/002-plan.png")).toBe(true);
      },
      { omitSecondThumbnail: true }
    );
  });

  it("validates notes alignment against the manifest slide order", async () => {
    await withFixtureDeckPackage(
      async (deckpkgPath) => {
        const result = await validateDeckPackage(deckpkgPath);

        expect(result.status).toBe("failed");
        expect(result.issues.map((issue) => issue.type)).toContain("notes-slide-mismatch");
      },
      {
        notesOverride: {
          ...notes,
          slides: [
            {
              ...notes.slides[0],
              id: "wrong-slide"
            },
            notes.slides[1]
          ]
        }
      }
    );
  });
});

describe("@htmlslide/presenter session helpers", () => {
  it("tracks current and next slides, navigation, overlays, and notes size", async () => {
    await withFixtureDeckPackage(async (deckpkgPath) => {
      const deckPackage = await readDeckPackage(deckpkgPath);
      let state = createPresenterSession(deckPackage, { nowMs: 1_000 });

      expect(getCurrentSlide(deckPackage, state).id).toBe("001-title");
      expect(getNextSlide(deckPackage, state)?.id).toBe("002-plan");

      state = nextSlide(state);
      expect(getCurrentSlide(deckPackage, state).id).toBe("002-plan");
      expect(nextSlide(state)).toBe(state);

      state = previousSlide(state);
      expect(getCurrentSlide(deckPackage, state).id).toBe("001-title");

      state = jumpToSlideNumber(state, 2);
      expect(getCurrentSlide(deckPackage, state).id).toBe("002-plan");

      state = jumpToSlideId(deckPackage, state, "001-title");
      expect(getCurrentSlide(deckPackage, state).id).toBe("001-title");

      state = toggleBlackScreen(state);
      expect(state.screen).toBe("black");
      state = toggleWhiteScreen(state);
      expect(state.screen).toBe("white");

      expect(increaseNotesFontSize(state).notesFontSizePx).toBe(24);
      expect(setNotesFontSize(state, 500).notesFontSizePx).toBe(40);
      expect(setNotesFontSize(state, -1).notesFontSizePx).toBe(12);
    });
  });

  it("calculates elapsed and remaining time with pause and resume", async () => {
    await withFixtureDeckPackage(async (deckpkgPath) => {
      const deckPackage = await readDeckPackage(deckpkgPath);
      let state = createPresenterSession(deckPackage, { nowMs: 10_000 });

      expect(getElapsedMs(state, 40_000)).toBe(30_000);
      expect(getRemainingMs(state, 40_000)).toBe(90_000);

      state = pauseTimer(state, 40_000);
      expect(getElapsedMs(state, 80_000)).toBe(30_000);

      state = resumeTimer(state, 80_000);
      expect(getElapsedMs(state, 90_000)).toBe(40_000);

      const view = getPresenterSessionView(deckPackage, state, 90_000);
      expect(view.timerStatus).toBe("running");
      expect(view.elapsedMs).toBe(40_000);
      expect(view.remainingMs).toBe(80_000);
      expect(view.progress).toBe(0.5);
    });
  });

  it("maps keyboard controls to pure state transitions", async () => {
    await withFixtureDeckPackage(async (deckpkgPath) => {
      const deckPackage = await readDeckPackage(deckpkgPath);
      let state = createPresenterSession(deckPackage, { nowMs: 0 });

      expect(getPresenterKeyboardAction("ArrowRight")).toBe("next");
      expect(getPresenterKeyboardAction(" ")).toBe("next");
      expect(getPresenterKeyboardAction("b")).toBe("toggle-black-screen");
      expect(getPresenterKeyboardAction("+")).toBe("increase-notes-font-size");

      state = applyPresenterKeyboardAction(deckPackage, state, "next");
      expect(getCurrentSlide(deckPackage, state).id).toBe("002-plan");

      state = applyPresenterKeyboardAction(deckPackage, state, "pause-resume-timer", { nowMs: 5_000 });
      expect(getPresenterSessionView(deckPackage, state, 20_000).timerStatus).toBe("paused");

      state = applyPresenterKeyboardAction(deckPackage, state, "jump", { jumpSlideId: "001-title" });
      expect(getCurrentSlide(deckPackage, state).id).toBe("001-title");
    });
  });
});
