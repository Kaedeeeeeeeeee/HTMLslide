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
import {
  applyPresenterKeyboardAction as applySessionKeyboardAction,
  createPresenterSession as createSessionPresenterSession,
  createRehearsalPresenterDeck,
  getPresenterKeyboardAction as getSessionKeyboardAction,
  getPresenterSessionView as getSessionPresenterView,
  parseDurationLabel,
  PRESENTER_KEYBOARD_CONTROLS
} from "../src/session";

const ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#2563eb"/></svg>');

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

const deckHtml = `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8" />
    <title>Presenter Fixture</title>
    <style>.htmlslide-page { width: 1920px; height: 1080px; } .asset-bg { background-image: url("assets/accent.svg#bg"); }</style>
  </head>
  <body data-htmlslide-mode="print" data-htmlslide-notes="closed">
    <main class="htmlslide-deck" aria-label="Presenter Fixture">
<article class="htmlslide-page" data-slide-id="001-title" data-slide-index="0" data-slide-title="Opening" aria-current="true" tabindex="-1">
<section class="slide asset-bg" data-slide-id="001-title"><h1>Package HTML title</h1><img src="assets/accent.svg#shape" alt="" /></section>
</article>
<article class="htmlslide-page" data-slide-id="002-plan" data-slide-index="1" data-slide-title="Plan" aria-current="false" tabindex="-1">
<section class="slide" data-slide-id="002-plan"><h2>Package HTML plan</h2></section>
</article>
    </main>
  </body>
</html>`;

const writeFixtureDeckPackage = async (
  deckpkgPath: string,
  options: {
    manifestOverride?: unknown;
    notesOverride?: unknown;
    omitAccentAsset?: boolean;
    omitSecondThumbnail?: boolean;
  } = {}
): Promise<void> => {
  const zip = new JSZip();
  zip.file("manifest.json", `${JSON.stringify(options.manifestOverride ?? manifest, null, 2)}\n`, { date: ZIP_DATE });
  zip.file("deck.html", `${deckHtml}\n`, { date: ZIP_DATE });
  zip.file("deck.pdf", PDF_BYTES, { date: ZIP_DATE });
  zip.file("notes.json", `${JSON.stringify(options.notesOverride ?? notes, null, 2)}\n`, { date: ZIP_DATE });
  zip.file("presenter-settings.json", `${JSON.stringify(settings, null, 2)}\n`, { date: ZIP_DATE });
  if (!options.omitAccentAsset) {
    zip.file("assets/accent.svg", SVG_BYTES, { date: ZIP_DATE });
  }
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
  options: {
    manifestOverride?: unknown;
    notesOverride?: unknown;
    omitAccentAsset?: boolean;
    omitSecondThumbnail?: boolean;
  } = {}
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
      expect(deckPackage.slides[0]?.html).toContain("Package HTML title");
      expect(deckPackage.slides[0]?.html).toContain("data:image/svg+xml;base64,");
      expect(deckPackage.slides[0]?.html).toContain("#shape");
      expect(deckPackage.slides[0]?.htmlDocument).toContain('data-htmlslide-mode="present"');
      expect(deckPackage.slides[0]?.htmlDocument).toContain("data:image/svg+xml;base64,");
      expect(deckPackage.slides[0]?.htmlDocument).toContain("#bg");
      expect(deckPackage.slides[1]?.htmlDocument).toContain('aria-current="true"');
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

  it("returns validation issues for missing package-local HTML assets", async () => {
    await withFixtureDeckPackage(
      async (deckpkgPath) => {
        const result = await validateDeckPackage(deckpkgPath);

        expect(result.status).toBe("failed");
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "assets/accent.svg",
              type: "missing-package-file"
            })
          ])
        );
      },
      { omitAccentAsset: true }
    );
  });

  it("rejects non-zip deckpkg files as malformed archives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-presenter-"));
    try {
      const deckpkgPath = path.join(root, "not-a-zip.deckpkg");
      await writeFile(deckpkgPath, "not a zip archive", "utf8");

      const result = await validateDeckPackage(deckpkgPath);

      expect(result.status).toBe("failed");
      expect(result.issues.map((issue) => issue.type)).toContain("invalid-deckpkg-archive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects deckpkg manifests that reference traversal paths", async () => {
    await withFixtureDeckPackage(
      async (deckpkgPath) => {
        const result = await validateDeckPackage(deckpkgPath);

        expect(result.status).toBe("failed");
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "manifest.json#/slides/0/thumbnail",
              type: "invalid-manifest-path"
            })
          ])
        );
      },
      {
        manifestOverride: {
          ...manifest,
          slides: [
            {
              ...manifest.slides[0],
              thumbnail: "../outside.png"
            },
            manifest.slides[1]
          ]
        }
      }
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

  it("keeps every documented keyboard shortcut mapped to a supported action", async () => {
    await withFixtureDeckPackage(async (deckpkgPath) => {
      const deckPackage = await readDeckPackage(deckpkgPath);
      let state = createPresenterSession(deckPackage, { nowMs: 0 });

      for (const control of PRESENTER_KEYBOARD_CONTROLS) {
        for (const key of control.keys) {
          expect(getSessionKeyboardAction({ key })).toBe(control.action);
          expect(getPresenterKeyboardAction(key)).toBe(control.action);
        }
      }

      expect(getSessionKeyboardAction({ key: "Spacebar" })).toBe("next");
      expect(getSessionKeyboardAction({ key: "Esc" })).toBe("exit");
      expect(getSessionKeyboardAction({ key: "Unknown" })).toBeUndefined();

      state = applyPresenterKeyboardAction(deckPackage, state, "next");
      expect(getPresenterSessionView(deckPackage, state, 1_000).currentSlide.id).toBe("002-plan");

      state = applyPresenterKeyboardAction(deckPackage, state, "previous");
      expect(getPresenterSessionView(deckPackage, state, 2_000).currentSlide.id).toBe("001-title");

      state = applyPresenterKeyboardAction(deckPackage, state, "toggle-white-screen");
      expect(getPresenterSessionView(deckPackage, state, 3_000).screen).toBe("white");
      state = applyPresenterKeyboardAction(deckPackage, state, "toggle-white-screen");
      expect(getPresenterSessionView(deckPackage, state, 4_000).screen).toBe("normal");

      state = applyPresenterKeyboardAction(deckPackage, state, "toggle-black-screen");
      expect(getPresenterSessionView(deckPackage, state, 5_000).screen).toBe("black");
      state = applyPresenterKeyboardAction(deckPackage, state, "toggle-black-screen");
      expect(getPresenterSessionView(deckPackage, state, 6_000).screen).toBe("normal");

      state = applyPresenterKeyboardAction(deckPackage, state, "decrease-notes-font-size");
      expect(getPresenterSessionView(deckPackage, state, 7_000).notesFontSizePx).toBe(20);
      state = applyPresenterKeyboardAction(deckPackage, state, "increase-notes-font-size");
      expect(getPresenterSessionView(deckPackage, state, 8_000).notesFontSizePx).toBe(22);

      const unchangedByFullscreen = applyPresenterKeyboardAction(deckPackage, state, "fullscreen");
      const unchangedByExit = applyPresenterKeyboardAction(deckPackage, state, "exit");
      expect(unchangedByFullscreen).toBe(state);
      expect(unchangedByExit).toBe(state);
    });
  });
});

describe("@htmlslide/presenter rehearsal deck helpers", () => {
  it("creates a browser-safe presenter deck from loaded preview slides", () => {
    const deck = createRehearsalPresenterDeck({
      title: "Loaded Preview",
      notesFontSizePx: 500,
      slides: [
        {
          id: "intro",
          title: "Intro",
          source: "slides/intro.html",
          notesPath: "notes/intro.md",
          notesMarkdown: "  Open with the local project path.  ",
          duration: "1:05"
        },
        {
          id: "demo",
          title: "Demo",
          notesMarkdown: "",
          durationSec: 90
        },
        {
          id: "close",
          title: "Close",
          duration: "not a duration"
        }
      ]
    });

    expect(deck.title).toBe("Loaded Preview");
    expect(deck.settings.mode).toBe("rehearsal");
    expect(deck.settings.notes.fontSizePx).toBe(40);
    expect(deck.slides.map((slide) => [slide.id, slide.slideNumber, slide.durationSec, slide.hasNotes])).toEqual([
      ["intro", 1, 65, true],
      ["demo", 2, 90, false],
      ["close", 3, 60, false]
    ]);
    expect(deck.slides[0]?.notesMarkdown).toBe("Open with the local project path.");
    expect(deck.slides[0]?.thumbnail.bytes.byteLength).toBe(0);
  });

  it("drives rehearsal navigation and keyboard actions without deckpkg artifacts", () => {
    const deck = createRehearsalPresenterDeck({
      title: "Keyboard Preview",
      slides: [
        { id: "one", title: "One", duration: "0:10" },
        { id: "two", title: "Two", duration: "0:20" }
      ]
    });
    let state = createSessionPresenterSession(deck, { initialSlideId: "one", nowMs: 5_000 });

    expect(parseDurationLabel("1:02:03")).toBe(3723);
    expect(getSessionKeyboardAction({ key: " " })).toBe("next");

    state = applySessionKeyboardAction(deck, state, "next");
    expect(getSessionPresenterView(deck, state, 10_000).currentSlide.id).toBe("two");

    state = applySessionKeyboardAction(deck, state, "jump", { jumpSlideNumber: 1 });
    state = applySessionKeyboardAction(deck, state, "pause-resume-timer", { nowMs: 12_000 });
    const view = getSessionPresenterView(deck, state, 30_000);

    expect(view.currentSlide.id).toBe("one");
    expect(view.timerStatus).toBe("paused");
    expect(view.elapsedMs).toBe(7_000);
    expect(view.remainingMs).toBe(23_000);
  });

  it("starts single-screen rehearsal mode from a chosen slide with notes and timer bounds", () => {
    const deck = createRehearsalPresenterDeck({
      title: "Single Screen Rehearsal",
      notesFontSizePx: 18,
      timer: false,
      slides: [
        {
          id: "intro",
          title: "Intro",
          duration: "0:10",
          notesMarkdown: "Open in single-screen rehearsal."
        },
        {
          id: "demo",
          title: "Demo",
          duration: "0:20",
          notesMarkdown: "Walk through the local preview."
        }
      ]
    });

    let state = createSessionPresenterSession(deck, {
      initialSlideId: "demo",
      nowMs: 1_000
    });
    let view = getSessionPresenterView(deck, state, 6_000);

    expect(deck.settings.timer).toBe(false);
    expect(view.mode).toBe("rehearsal");
    expect(view.timerStatus).toBe("paused");
    expect(view.currentSlide.id).toBe("demo");
    expect(view.currentSlide.notesMarkdown).toBe("Walk through the local preview.");
    expect(view.previousSlide?.id).toBe("intro");
    expect(view.nextSlide).toBeNull();
    expect(view.totalDurationMs).toBe(30_000);
    expect(view.elapsedMs).toBe(0);
    expect(view.remainingMs).toBe(30_000);
    expect(view.notesFontSizePx).toBe(18);

    state = applySessionKeyboardAction(deck, state, "previous");
    state = applySessionKeyboardAction(deck, state, "pause-resume-timer", { nowMs: 6_000 });
    view = getSessionPresenterView(deck, state, 11_000);

    expect(view.currentSlide.id).toBe("intro");
    expect(view.timerStatus).toBe("running");
    expect(view.elapsedMs).toBe(5_000);
    expect(view.remainingMs).toBe(25_000);

    state = applySessionKeyboardAction(deck, state, "next");
    expect(getSessionPresenterView(deck, state, 12_000).currentSlide.id).toBe("demo");
  });
});
