import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  applyPresenterKeyboardAction,
  createPresenterSession,
  DECK_PACKAGE_RESOURCE_LIMITS,
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
  readDeckPackageBytes,
  resumeTimer,
  setNotesFontSize,
  toggleBlackScreen,
  toggleWhiteScreen,
  validateDeckPackage,
  validateDeckPackageBytes
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

type FixtureDeckPackageOptions = {
  compression?: "DEFLATE" | "STORE";
  manifestOverride?: unknown;
  notesOverride?: unknown;
  omitAccentAsset?: boolean;
  omitSecondThumbnail?: boolean;
};

const createFixtureDeckPackageBytes = async (
  options: FixtureDeckPackageOptions = {}
): Promise<Uint8Array> => {
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

  return zip.generateAsync({
    type: "uint8array",
    compression: options.compression ?? "DEFLATE",
    compressionOptions: {
      level: 9
    },
    platform: "UNIX"
  });
};

const flipStoredEntryPayloadByte = (sourceBytes: Uint8Array, entryName: string): Uint8Array => {
  const bytes = Uint8Array.from(sourceBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (decoder.decode(bytes.subarray(nameStart, nameEnd)) === entryName) {
      expect(view.getUint16(offset + 10, true)).toBe(0);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressedSize = view.getUint32(offset + 20, true);
      if (compressedSize === 0) {
        throw new Error(`ZIP entry has no payload: ${entryName}`);
      }
      bytes[dataStart] = (bytes[dataStart] ?? 0) ^ 0x01;
      return bytes;
    }
    offset = nameEnd + extraLength + commentLength - 1;
  }

  throw new Error(`ZIP entry not found: ${entryName}`);
};

const writeFixtureDeckPackage = async (
  deckpkgPath: string,
  options: FixtureDeckPackageOptions = {}
): Promise<void> => {
  await writeFile(deckpkgPath, await createFixtureDeckPackageBytes(options));
};

const withFixtureDeckPackage = async <T>(
  test: (deckpkgPath: string) => Promise<T>,
  options: FixtureDeckPackageOptions = {}
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

const setDeclaredUncompressedSize = (
  sourceBytes: Uint8Array,
  entryName: string,
  uncompressedSize: number
): Uint8Array => {
  const bytes = Uint8Array.from(sourceBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (decoder.decode(bytes.subarray(nameStart, nameEnd)) === entryName) {
      const localHeaderOffset = view.getUint32(offset + 42, true);
      view.setUint32(offset + 24, uncompressedSize, true);
      view.setUint32(localHeaderOffset + 22, uncompressedSize, true);
      return bytes;
    }
    offset = nameEnd + extraLength + commentLength - 1;
  }

  throw new Error(`ZIP entry not found: ${entryName}`);
};

const createForgedUnderreportedDeflateEntry = (): Uint8Array => {
  const entryName = new TextEncoder().encode("bomb.bin");
  const declaredUncompressedSize = 1;
  const compressed = deflateRawSync(
    new Uint8Array(DECK_PACKAGE_RESOURCE_LIMITS.maxEntryUncompressedBytes + 1),
    { level: 9 }
  );
  const localHeaderSize = 30 + entryName.byteLength;
  const centralDirectoryOffset = localHeaderSize + compressed.byteLength;
  const centralDirectorySize = 46 + entryName.byteLength;
  const bytes = new Uint8Array(centralDirectoryOffset + centralDirectorySize + 22);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, declaredUncompressedSize, true);
  view.setUint16(26, entryName.byteLength, true);
  bytes.set(entryName, 30);
  bytes.set(compressed, localHeaderSize);

  view.setUint32(centralDirectoryOffset, 0x02014b50, true);
  view.setUint16(centralDirectoryOffset + 4, 20, true);
  view.setUint16(centralDirectoryOffset + 6, 20, true);
  view.setUint16(centralDirectoryOffset + 10, 8, true);
  view.setUint32(centralDirectoryOffset + 20, compressed.byteLength, true);
  view.setUint32(centralDirectoryOffset + 24, declaredUncompressedSize, true);
  view.setUint16(centralDirectoryOffset + 28, entryName.byteLength, true);
  bytes.set(entryName, centralDirectoryOffset + 46);

  const endOffset = centralDirectoryOffset + centralDirectorySize;
  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, centralDirectorySize, true);
  view.setUint32(endOffset + 16, centralDirectoryOffset, true);
  return bytes;
};

const setEncryptedFlag = (sourceBytes: Uint8Array, entryName: string): Uint8Array => {
  const bytes = Uint8Array.from(sourceBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (decoder.decode(bytes.subarray(nameStart, nameEnd)) === entryName) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 0x0001, true);
      return bytes;
    }
  }

  throw new Error(`ZIP entry not found: ${entryName}`);
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

  it("keeps a valid package within every alpha resource limit", async () => {
    const bytes = await createFixtureDeckPackageBytes();
    const deckPackage = await readDeckPackageBytes(bytes, { sourcePath: "valid.deckpkg" });

    expect(bytes.byteLength).toBeLessThan(DECK_PACKAGE_RESOURCE_LIMITS.maxArchiveBytes);
    expect(deckPackage.sourcePath).toBe("valid.deckpkg");
    expect(deckPackage.slides).toHaveLength(2);
  });

  it("rejects an over-limit archive from file metadata before ZIP parsing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-presenter-limit-"));
    try {
      const deckpkgPath = path.join(root, "oversized.deckpkg");
      await writeFile(deckpkgPath, "");
      await truncate(deckpkgPath, DECK_PACKAGE_RESOURCE_LIMITS.maxArchiveBytes + 1);

      const result = await validateDeckPackage(deckpkgPath);

      expect(result.status).toBe("failed");
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: deckpkgPath,
          type: "deckpkg-archive-too-large"
        })
      ]);
      expect(result.issues[0]?.message).toContain("re-export the deck");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an archive whose declared entry count exceeds the alpha limit", async () => {
    const zip = new JSZip();
    for (let index = 0; index <= DECK_PACKAGE_RESOURCE_LIMITS.maxEntryCount; index += 1) {
      zip.file(`entry-${index.toString().padStart(4, "0")}.txt`, "", {
        createFolders: false,
        date: ZIP_DATE
      });
    }
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE", platform: "UNIX" });

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "too-many.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "too-many.deckpkg",
        type: "deckpkg-entry-count-exceeded"
      })
    ]);
  });

  it("rejects an entry whose declared uncompressed size exceeds the per-entry limit", async () => {
    const bytes = setDeclaredUncompressedSize(
      await createFixtureDeckPackageBytes(),
      "deck.pdf",
      DECK_PACKAGE_RESOURCE_LIMITS.maxEntryUncompressedBytes + 1
    );

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "large-entry.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "deck.pdf",
        type: "deckpkg-entry-too-large"
      })
    ]);
    expect(result.issues[0]?.message).toContain("Reduce or split this asset");
  });

  it("rejects excessive total declared uncompressed data", async () => {
    let bytes = await createFixtureDeckPackageBytes();
    for (const entryName of [
      "manifest.json",
      "deck.html",
      "deck.pdf",
      "notes.json",
      "presenter-settings.json"
    ]) {
      bytes = setDeclaredUncompressedSize(
        bytes,
        entryName,
        DECK_PACKAGE_RESOURCE_LIMITS.maxEntryUncompressedBytes
      );
    }

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "expanded.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "expanded.deckpkg",
        type: "deckpkg-total-uncompressed-size-exceeded"
      })
    ]);
  });

  it("bounds actual DEFLATE expansion when ZIP metadata under-reports the entry size", async () => {
    const bytes = createForgedUnderreportedDeflateEntry();

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "forged-size.deckpkg" });

    expect(bytes.byteLength).toBeLessThan(DECK_PACKAGE_RESOURCE_LIMITS.maxArchiveBytes);
    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "bomb.bin",
        type: "deckpkg-entry-too-large"
      })
    ]);
    expect(result.issues[0]?.message).toContain("expands beyond");
  });

  it("rejects a stored entry whose payload does not match its declared CRC32", async () => {
    const bytes = flipStoredEntryPayloadByte(
      await createFixtureDeckPackageBytes({ compression: "STORE" }),
      "thumbnails/001-title.png"
    );

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "crc-mismatch.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "thumbnails/001-title.png",
        type: "deckpkg-entry-crc-mismatch"
      })
    ]);
  });

  it("maps observable ZIP encryption to a stable validation issue", async () => {
    const bytes = setEncryptedFlag(await createFixtureDeckPackageBytes(), "deck.pdf");

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "encrypted.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "encrypted.deckpkg",
        type: "encrypted-deckpkg-archive"
      })
    ]);
  });

  it("rejects ZIP entries whose original paths were sanitized by JSZip", async () => {
    const zip = new JSZip();
    zip.file("../manifest.json", "{}", { createFolders: false, date: ZIP_DATE });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE", platform: "UNIX" });

    const result = await validateDeckPackageBytes(bytes, { sourcePath: "unsafe.deckpkg" });

    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "../manifest.json",
        type: "unsafe-deckpkg-entry-path"
      })
    ]);
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
