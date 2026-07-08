import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { buildDeckHtml, type RenderDeck } from "@htmlslide/renderer";

export type CompilerSlideInput = {
  id: string;
  title: string;
  sourcePath: string;
  notesPath?: string;
  durationSec?: number;
};

export type CompilerProjectInput = {
  projectPath: string;
  title: string;
  language?: string;
  viewport: {
    width: number;
    height: number;
  };
  safeArea?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  themeCssPath?: string;
  slides: CompilerSlideInput[];
};

export type ThumbnailSize = {
  width: number;
  height: number;
};

export type ExportOptions = {
  pdf?: boolean;
  html?: boolean;
  deckpkg?: boolean;
  thumbnails?: boolean;
  thumbnailSize?: ThumbnailSize;
};

export type ExportVerification = {
  expectedPageCount: number;
  pdfPageCount?: number;
  pdfPageCountMatches?: boolean;
};

export type ExportResult = {
  projectPath: string;
  exportsPath: string;
  artifacts: {
    pdf?: string;
    html?: string;
    deckpkg?: string;
    thumbnails?: string[];
    thumbnailCache?: string[];
    notes?: string;
  };
  verification: ExportVerification;
};

export type NotesSidecarSlide = {
  id: string;
  title: string;
  index: number;
  pdfPage: number;
  source: string;
  notesPath: string | null;
  durationSec: number;
  hasNotes: boolean;
  markdown: string;
};

export type NotesSidecar = {
  schemaVersion: "0.1.0";
  title: string;
  language: string | null;
  slideCount: number;
  slides: NotesSidecarSlide[];
};

export type DeckPackageManifestSlide = {
  id: string;
  title: string;
  index: number;
  pdfPage: number;
  source: string;
  thumbnail: string;
  notes: string | null;
  durationSec: number;
};

export type DeckPackageManifest = {
  schemaVersion: "0.1.0";
  title: string;
  language: string | null;
  viewport: CompilerProjectInput["viewport"];
  safeArea: NonNullable<CompilerProjectInput["safeArea"]>;
  pdf: "deck.pdf";
  html: "deck.html";
  notes: "notes.json";
  presenterSettings: "presenter-settings.json";
  thumbnailSize: ThumbnailSize;
  slideCount: number;
  pageCount: number;
  slides: DeckPackageManifestSlide[];
};

type PreparedSlide = CompilerSlideInput & {
  index: number;
  pdfPage: number;
  sourceHtml: string;
  exportHtml: string;
  notes: string;
  durationSec: number;
};

type PreparedProject = {
  renderable: RenderDeck;
  slides: PreparedSlide[];
};

type ThumbnailEntry = {
  slideId: string;
  packagePath: string;
  exportPath: string;
  cachePath: string;
  bytes: Buffer;
};

const DEFAULT_OPTIONS = {
  pdf: true,
  html: true,
  deckpkg: true,
  thumbnails: true
};

const DEFAULT_THUMBNAIL_SIZE: ThumbnailSize = {
  width: 960,
  height: 540
};

const DEFAULT_SAFE_AREA: NonNullable<CompilerProjectInput["safeArea"]> = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0
};

const ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PDF_DATE = new Date("2000-01-01T00:00:00.000Z");
const PACKAGE_HTML_PATH = "deck.html";
const PACKAGE_PDF_PATH = "deck.pdf";
const PACKAGE_NOTES_PATH = "notes.json";
const PACKAGE_PRESENTER_SETTINGS_PATH = "presenter-settings.json";
const PROJECT_TOP_LEVEL_DIRS = new Set(["assets", "slides", "notes", "theme", "skills", ".htmlslide"]);

const fileExistsText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const slugFileName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "deck";

const toPosixPath = (value: string): string => value.split(path.sep).join(path.posix.sep);

const normalizeProjectPath = (value: string): string => toPosixPath(value).replace(/^\.\/+/, "");

const hasExternalOrAbsoluteUrl = (value: string): boolean =>
  /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value.trim());

const splitUrlSuffix = (value: string): { pathname: string; suffix: string } => {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  let suffixIndex = value.length;
  if (queryIndex >= 0) {
    suffixIndex = Math.min(suffixIndex, queryIndex);
  }
  if (hashIndex >= 0) {
    suffixIndex = Math.min(suffixIndex, hashIndex);
  }

  return {
    pathname: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex)
  };
};

const toExportRelativeUrl = (sourcePath: string, rawValue: string): string => {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0 || hasExternalOrAbsoluteUrl(trimmedValue)) {
    return rawValue;
  }

  const { pathname, suffix } = splitUrlSuffix(trimmedValue);
  if (pathname.length === 0) {
    return rawValue;
  }

  const normalizedSource = normalizeProjectPath(sourcePath);
  const sourceDir = path.posix.dirname(normalizedSource);
  const firstSegment = pathname.split("/")[0] ?? "";
  const projectRelativeTarget = PROJECT_TOP_LEVEL_DIRS.has(firstSegment)
    ? path.posix.normalize(pathname)
    : path.posix.normalize(path.posix.join(sourceDir, pathname));

  if (projectRelativeTarget.startsWith("../") || projectRelativeTarget === "..") {
    return rawValue;
  }

  return `../${projectRelativeTarget}${suffix}`;
};

const rewriteSrcsetForExport = (sourcePath: string, rawValue: string): string =>
  rawValue
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        return trimmed;
      }
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (!url) {
        return trimmed;
      }
      return [toExportRelativeUrl(sourcePath, url), ...descriptor].join(" ");
    })
    .join(", ");

const rewriteHtmlUrlsForExport = (sourcePath: string, html: string): string =>
  html
    .replace(/\b(src|href|poster|srcset)\s*=\s*(["'])([^"']+)\2/gi, (match, attr: string, quote: string, value: string) => {
      const rewrittenValue = attr.toLowerCase() === "srcset" ? rewriteSrcsetForExport(sourcePath, value) : toExportRelativeUrl(sourcePath, value);
      return `${attr}=${quote}${rewrittenValue}${quote}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
      const rewrittenValue = toExportRelativeUrl(sourcePath, value);
      return `url(${quote}${rewrittenValue}${quote})`;
    });

const rewriteCssUrlsForExport = (sourcePath: string, css: string): string =>
  css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
    const rewrittenValue = toExportRelativeUrl(sourcePath, value);
    return `url(${quote}${rewrittenValue}${quote})`;
  });

const buildPreparedProject = async (project: CompilerProjectInput): Promise<PreparedProject> => {
  const themeCss = project.themeCssPath
    ? rewriteCssUrlsForExport(project.themeCssPath, await fileExistsText(path.resolve(project.projectPath, project.themeCssPath)))
    : undefined;

  const slides = await Promise.all(
    project.slides.map(async (slide, index): Promise<PreparedSlide> => {
      const sourcePath = path.resolve(project.projectPath, slide.sourcePath);
      const sourceHtml = await readFile(sourcePath, "utf8");
      const notes = slide.notesPath ? await fileExistsText(path.resolve(project.projectPath, slide.notesPath)) : "";

      return {
        ...slide,
        index,
        pdfPage: index + 1,
        durationSec: slide.durationSec ?? 60,
        sourceHtml,
        exportHtml: rewriteHtmlUrlsForExport(slide.sourcePath, sourceHtml),
        notes
      };
    })
  );

  return {
    renderable: {
      title: project.title,
      language: project.language,
      viewport: project.viewport,
      safeArea: project.safeArea,
      themeCss,
      slides: slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        html: slide.exportHtml,
        notes: slide.notes
      }))
    },
    slides
  };
};

const buildStandaloneHtml = (prepared: PreparedProject): string =>
  `${buildDeckHtml(prepared.renderable, {
    mode: "print",
    includeRuntimeScript: true,
    includeNotesPanel: true
  })}\n`;

export const buildNotesSidecar = async (project: CompilerProjectInput): Promise<NotesSidecar> => {
  const prepared = await buildPreparedProject(project);
  return buildNotesSidecarFromPrepared(project, prepared);
};

const buildNotesSidecarFromPrepared = (project: CompilerProjectInput, prepared: PreparedProject): NotesSidecar => ({
  schemaVersion: "0.1.0",
  title: project.title,
  language: project.language ?? null,
  slideCount: prepared.slides.length,
  slides: prepared.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    index: slide.index,
    pdfPage: slide.pdfPage,
    source: slide.sourcePath,
    notesPath: slide.notesPath ?? null,
    durationSec: slide.durationSec,
    hasNotes: slide.notes.trim().length > 0,
    markdown: slide.notes
  }))
});

export const buildDeckPackageManifest = (
  project: CompilerProjectInput,
  options: {
    thumbnailSize?: ThumbnailSize;
    pageCount?: number;
  } = {}
): DeckPackageManifest => {
  const thumbnailSize = options.thumbnailSize ?? DEFAULT_THUMBNAIL_SIZE;

  return {
    schemaVersion: "0.1.0",
    title: project.title,
    language: project.language ?? null,
    viewport: project.viewport,
    safeArea: project.safeArea ?? DEFAULT_SAFE_AREA,
    pdf: PACKAGE_PDF_PATH,
    html: PACKAGE_HTML_PATH,
    notes: PACKAGE_NOTES_PATH,
    presenterSettings: PACKAGE_PRESENTER_SETTINGS_PATH,
    thumbnailSize,
    slideCount: project.slides.length,
    pageCount: options.pageCount ?? project.slides.length,
    slides: project.slides.map((slide, index) => ({
      id: slide.id,
      title: slide.title,
      index,
      pdfPage: index + 1,
      source: slide.sourcePath,
      thumbnail: `thumbnails/${slide.id}.png`,
      notes: slide.notesPath ?? null,
      durationSec: slide.durationSec ?? 60
    }))
  };
};

const writeJson = async (filePath: string, value: unknown): Promise<string> => {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, json);
  return json;
};

const htmlToText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, codePoint: string) => String.fromCodePoint(Number(codePoint)))
    .replace(/\s+/g, " ")
    .trim();

const toPdfSafeText = (value: string): string => value.replace(/[^\x20-\x7E]/g, "?");

const wrapWords = (value: string, maxCharacters: number): string[] => {
  const words = toPdfSafeText(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + word.length + 1 <= maxCharacters) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }

    while (current.length > maxCharacters) {
      lines.push(current.slice(0, maxCharacters));
      current = current.slice(maxCharacters);
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
};

const drawWrappedText = (
  page: PDFPage,
  font: PDFFont,
  value: string,
  options: {
    x: number;
    y: number;
    size: number;
    lineHeight: number;
    maxCharacters: number;
    maxLines: number;
    color: ReturnType<typeof rgb>;
  }
): number => {
  const lines = wrapWords(value, options.maxCharacters).slice(0, options.maxLines);
  let y = options.y;

  for (const line of lines) {
    page.drawText(line, {
      x: options.x,
      y,
      size: options.size,
      font,
      color: options.color
    });
    y -= options.lineHeight;
  }

  return y;
};

type Rgba = readonly [number, number, number, number];

const colorFromString = (value: string): Rgba => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return [
    56 + (hash & 0x5f),
    72 + ((hash >>> 8) & 0x5f),
    96 + ((hash >>> 16) & 0x5f),
    255
  ];
};

const writeRect = (
  buffer: Buffer,
  size: ThumbnailSize,
  rect: { x: number; y: number; width: number; height: number },
  color: Rgba
): void => {
  const stride = size.width * 4 + 1;
  const startX = Math.max(0, Math.floor(rect.x));
  const startY = Math.max(0, Math.floor(rect.y));
  const endX = Math.min(size.width, Math.ceil(rect.x + rect.width));
  const endY = Math.min(size.height, Math.ceil(rect.y + rect.height));

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = y * stride + 1 + x * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
};

let crcTable: Uint32Array | undefined;

const getCrcTable = (): Uint32Array => {
  if (crcTable) {
    return crcTable;
  }

  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
};

const crc32 = (buffers: Buffer[]): number => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32([typeBuffer, data]), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
};

const encodePng = (size: ThumbnailSize, paint: (raw: Buffer) => void): Buffer => {
  const raw = Buffer.alloc((size.width * 4 + 1) * size.height);
  for (let y = 0; y < size.height; y += 1) {
    raw[y * (size.width * 4 + 1)] = 0;
  }

  paint(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size.width, 0);
  ihdr.writeUInt32BE(size.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
};

const renderThumbnailPng = (project: CompilerProjectInput, slide: PreparedSlide, size: ThumbnailSize): Buffer => {
  const accent = colorFromString(`${project.title}:${slide.id}`);
  const secondary = colorFromString(`${slide.title}:${slide.index}`);
  const text = htmlToText(slide.sourceHtml);
  const hash = colorFromString(text || slide.title);
  const scaleX = size.width / project.viewport.width;
  const scaleY = size.height / project.viewport.height;
  const safe = project.safeArea ?? { top: 72, right: 96, bottom: 72, left: 96 };
  const safeRect = {
    x: safe.left * scaleX,
    y: safe.top * scaleY,
    width: Math.max(48, (project.viewport.width - safe.left - safe.right) * scaleX),
    height: Math.max(48, (project.viewport.height - safe.top - safe.bottom) * scaleY)
  };

  return encodePng(size, (raw) => {
    writeRect(raw, size, { x: 0, y: 0, width: size.width, height: size.height }, [248, 249, 251, 255]);
    writeRect(raw, size, { x: 0, y: 0, width: size.width, height: Math.max(10, size.height * 0.04) }, accent);
    writeRect(raw, size, safeRect, [255, 255, 255, 255]);
    writeRect(raw, size, { x: safeRect.x, y: safeRect.y, width: Math.max(8, safeRect.width * 0.015), height: safeRect.height }, secondary);

    const lineCount = Math.max(4, Math.min(9, wrapWords(text || slide.title, 44).length + 2));
    for (let index = 0; index < lineCount; index += 1) {
      const blockWidthSeed = (hash[(index % 3) as 0 | 1 | 2] ?? 72) / 255;
      const blockWidth = safeRect.width * (0.35 + blockWidthSeed * 0.55);
      const blockHeight = Math.max(8, size.height * 0.018);
      const blockY = safeRect.y + safeRect.height * 0.2 + index * blockHeight * 2.3;
      const shade = 52 + index * 10;
      writeRect(raw, size, { x: safeRect.x + safeRect.width * 0.08, y: blockY, width: blockWidth, height: blockHeight }, [
        Math.min(210, shade),
        Math.min(216, shade + 8),
        Math.min(226, shade + 18),
        255
      ]);
    }

    const pageBadgeSize = Math.max(36, size.height * 0.09);
    writeRect(
      raw,
      size,
      {
        x: size.width - pageBadgeSize - 18,
        y: size.height - pageBadgeSize - 18,
        width: pageBadgeSize,
        height: pageBadgeSize
      },
      accent
    );
  });
};

export const readPngSize = (bytes: Uint8Array): ThumbnailSize => {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Invalid PNG file.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
};

const buildPdfBytes = async (project: CompilerProjectInput, prepared: PreparedProject): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(project.title);
  pdf.setCreator("HTMLslide compiler");
  pdf.setProducer("HTMLslide compiler");
  pdf.setCreationDate(PDF_DATE);
  pdf.setModificationDate(PDF_DATE);

  const regularFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = project.viewport.width * 0.75;
  const pageHeight = project.viewport.height * 0.75;

  for (const slide of prepared.slides) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    const accent = colorFromString(`${project.title}:${slide.id}`);
    const accentColor = rgb(accent[0] / 255, accent[1] / 255, accent[2] / 255);

    page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(0.98, 0.985, 0.99) });
    page.drawRectangle({ x: 0, y: pageHeight - 18, width: pageWidth, height: 18, color: accentColor });
    page.drawText(toPdfSafeText(project.title), {
      x: 48,
      y: pageHeight - 64,
      size: 13,
      font: regularFont,
      color: rgb(0.35, 0.38, 0.43)
    });
    page.drawText(`${slide.pdfPage}/${prepared.slides.length}`, {
      x: pageWidth - 88,
      y: pageHeight - 64,
      size: 12,
      font: regularFont,
      color: rgb(0.35, 0.38, 0.43)
    });

    let y = drawWrappedText(page, boldFont, slide.title, {
      x: 48,
      y: pageHeight - 112,
      size: 30,
      lineHeight: 38,
      maxCharacters: 40,
      maxLines: 2,
      color: rgb(0.06, 0.08, 0.12)
    });

    y -= 24;
    y = drawWrappedText(page, regularFont, htmlToText(slide.sourceHtml), {
      x: 64,
      y,
      size: 16,
      lineHeight: 24,
      maxCharacters: 84,
      maxLines: 12,
      color: rgb(0.13, 0.16, 0.22)
    });

    page.drawText(toPdfSafeText(`slide-id: ${slide.id}`), {
      x: 48,
      y: 48,
      size: 10,
      font: regularFont,
      color: rgb(0.42, 0.45, 0.5)
    });
    page.drawText(toPdfSafeText(`notes: ${slide.notesPath ?? "none"}`), {
      x: 48,
      y: 32,
      size: 10,
      font: regularFont,
      color: rgb(0.42, 0.45, 0.5)
    });

    if (y < 80) {
      page.drawText("Content truncated in deterministic fallback PDF.", {
        x: pageWidth - 260,
        y: 32,
        size: 9,
        font: regularFont,
        color: rgb(0.55, 0.29, 0.08)
      });
    }
  }

  return pdf.save({ useObjectStreams: false });
};

export const readPdfPageCount = async (input: string | Uint8Array): Promise<number> => {
  const bytes = typeof input === "string" ? await readFile(input) : input;
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
};

const writeThumbnails = async (
  project: CompilerProjectInput,
  prepared: PreparedProject,
  exportsPath: string,
  size: ThumbnailSize
): Promise<ThumbnailEntry[]> => {
  const thumbnailsPath = path.join(exportsPath, "thumbnails");
  const cachePath = path.join(project.projectPath, ".htmlslide", "cache", "thumbnails");
  await Promise.all([mkdir(thumbnailsPath, { recursive: true }), mkdir(cachePath, { recursive: true })]);

  const entries: ThumbnailEntry[] = [];
  for (const slide of prepared.slides) {
    const bytes = renderThumbnailPng(project, slide, size);
    const fileName = `${slide.id}.png`;
    const exportPath = path.join(thumbnailsPath, fileName);
    const cacheThumbnailPath = path.join(cachePath, fileName);
    await Promise.all([writeFile(exportPath, bytes), writeFile(cacheThumbnailPath, bytes)]);
    entries.push({
      slideId: slide.id,
      packagePath: `thumbnails/${fileName}`,
      exportPath,
      cachePath: cacheThumbnailPath,
      bytes
    });
  }

  return entries;
};

const presenterSettings = {
  schemaVersion: "0.1.0",
  mode: "rehearsal",
  timer: true,
  notes: {
    visibleByDefault: false
  }
};

const addZipFile = (zip: JSZip, filePath: string, content: string | Uint8Array): void => {
  zip.file(filePath, content, {
    date: ZIP_DATE
  });
};

export const exportDeck = async (
  project: CompilerProjectInput,
  options: ExportOptions = DEFAULT_OPTIONS
): Promise<ExportResult> => {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    thumbnailSize: options.thumbnailSize ?? DEFAULT_THUMBNAIL_SIZE
  };
  const exportsPath = path.join(project.projectPath, "exports");
  await mkdir(exportsPath, { recursive: true });

  const baseName = slugFileName(project.title);
  const prepared = await buildPreparedProject(project);
  const html = buildStandaloneHtml(prepared);
  const notesSidecar = buildNotesSidecarFromPrepared(project, prepared);
  const notesPath = path.join(exportsPath, "notes.json");
  const notesJson = await writeJson(notesPath, notesSidecar);
  const artifacts: ExportResult["artifacts"] = {
    notes: notesPath
  };
  const verification: ExportVerification = {
    expectedPageCount: prepared.slides.length
  };

  if (resolvedOptions.html || resolvedOptions.deckpkg) {
    if (resolvedOptions.html) {
      const htmlPath = path.join(exportsPath, `${baseName}.html`);
      await writeFile(htmlPath, html);
      artifacts.html = htmlPath;
    }
  }

  let pdfBytes: Uint8Array | undefined;
  if (resolvedOptions.pdf || resolvedOptions.deckpkg) {
    pdfBytes = await buildPdfBytes(project, prepared);
    verification.pdfPageCount = await readPdfPageCount(pdfBytes);
    verification.pdfPageCountMatches = verification.pdfPageCount === verification.expectedPageCount;
    if (!verification.pdfPageCountMatches) {
      throw new Error(
        `PDF page count mismatch: expected ${verification.expectedPageCount}, got ${verification.pdfPageCount}.`
      );
    }

    if (resolvedOptions.pdf) {
      const pdfPath = path.join(exportsPath, `${baseName}.pdf`);
      await writeFile(pdfPath, pdfBytes);
      artifacts.pdf = pdfPath;
    }
  }

  let thumbnailEntries: ThumbnailEntry[] = [];
  if (resolvedOptions.thumbnails || resolvedOptions.deckpkg) {
    thumbnailEntries = await writeThumbnails(project, prepared, exportsPath, resolvedOptions.thumbnailSize);
    artifacts.thumbnails = thumbnailEntries.map((entry) => entry.exportPath);
    artifacts.thumbnailCache = thumbnailEntries.map((entry) => entry.cachePath);
  }

  if (resolvedOptions.deckpkg) {
    if (!pdfBytes) {
      throw new Error("deckpkg export requires a PDF artifact.");
    }
    if (thumbnailEntries.length !== prepared.slides.length) {
      throw new Error("deckpkg export requires one thumbnail per slide.");
    }

    const zip = new JSZip();
    const manifest = buildDeckPackageManifest(project, {
      thumbnailSize: resolvedOptions.thumbnailSize,
      pageCount: verification.pdfPageCount
    });
    addZipFile(zip, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    addZipFile(zip, PACKAGE_HTML_PATH, html);
    addZipFile(zip, PACKAGE_PDF_PATH, pdfBytes);
    addZipFile(zip, PACKAGE_NOTES_PATH, notesJson);
    addZipFile(zip, PACKAGE_PRESENTER_SETTINGS_PATH, `${JSON.stringify(presenterSettings, null, 2)}\n`);
    for (const thumbnail of thumbnailEntries) {
      addZipFile(zip, thumbnail.packagePath, thumbnail.bytes);
    }

    const deckpkgPath = path.join(exportsPath, `${baseName}.deckpkg`);
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
    artifacts.deckpkg = deckpkgPath;
  }

  return {
    projectPath: project.projectPath,
    exportsPath,
    artifacts,
    verification
  };
};
