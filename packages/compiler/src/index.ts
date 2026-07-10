import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  changedFingerprintPaths,
  compareFingerprintPaths,
  createExportManifest,
  ExportManifestSchema,
  EXPORT_MANIFEST_FILE_NAME,
  EXPORT_MANIFEST_PROJECT_PATH,
  fingerprintBytes,
  fingerprintProjectFile,
  fingerprintProjectFiles,
  loadDeckProject,
  MAX_EXPORT_MANIFEST_BYTES,
  readProjectFileSnapshot,
  toFingerprintProjectPath,
  type ExportArtifactFingerprint,
  type ExportArtifactKind,
  type ExportFileFingerprint,
  type ExportManifest
} from "@htmlslide/core";
import { DECK_PACKAGE_SCHEMA_VERSION } from "@htmlslide/core/version";
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
  themeTokensPath?: string;
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
  metadata: {
    manifest: string;
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
  schemaVersion: typeof DECK_PACKAGE_SCHEMA_VERSION;
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
  schemaVersion: typeof DECK_PACKAGE_SCHEMA_VERSION;
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
  packageHtml: string;
  notes: string;
  durationSec: number;
};

type PreparedProject = {
  renderable: RenderDeck;
  packageRenderable: RenderDeck;
  packageAssets: PackageAssetEntry[];
  sourceFingerprints: ExportFileFingerprint[];
  slides: PreparedSlide[];
};

type ThumbnailEntry = {
  slideId: string;
  packagePath: string;
  exportPath: string;
  stagingPath: string;
  cachePath: string;
  bytes: Buffer;
};

type PackageAssetEntry = {
  packagePath: string;
  bytes: Uint8Array;
};

type StagedArtifact = {
  finalPath: string;
  fingerprint: ExportArtifactFingerprint;
  projectPath: string;
  stagingPath: string;
};

type ExportArtifactBackup = {
  backupPath: string;
  finalPath: string;
  projectPath: string;
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
const ZIP_FILE_PERMISSIONS = 0o100644;
const ZIP_DIR_PERMISSIONS = 0o40755;
const PACKAGE_HTML_PATH = "deck.html";
const PACKAGE_PDF_PATH = "deck.pdf";
const PACKAGE_NOTES_PATH = "notes.json";
const PACKAGE_PRESENTER_SETTINGS_PATH = "presenter-settings.json";
const PROJECT_TOP_LEVEL_DIRS = new Set(["assets", "slides", "notes", "theme", "skills", ".htmlslide"]);
const PACKAGE_ASSET_TOP_LEVEL_DIRS = new Set(["assets", "slides", "theme"]);

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
  const target = resolveProjectRelativeUrl(sourcePath, rawValue);
  if (!target) {
    return rawValue;
  }

  return `../${target.projectRelativePath}${target.suffix}`;
};

const resolveProjectRelativeUrl = (
  sourcePath: string,
  rawValue: string
): { projectRelativePath: string; suffix: string } | undefined => {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0 || hasExternalOrAbsoluteUrl(trimmedValue)) {
    return undefined;
  }
  const { pathname, suffix } = splitUrlSuffix(trimmedValue);
  if (pathname.length === 0) {
    return undefined;
  }

  const normalizedSource = normalizeProjectPath(sourcePath);
  const sourceDir = path.posix.dirname(normalizedSource);
  const firstSegment = pathname.split("/")[0] ?? "";
  const projectRelativeTarget = PROJECT_TOP_LEVEL_DIRS.has(firstSegment)
    ? path.posix.normalize(pathname)
    : path.posix.normalize(path.posix.join(sourceDir, pathname));

  if (projectRelativeTarget.startsWith("../") || projectRelativeTarget === "..") {
    return undefined;
  }

  return {
    projectRelativePath: projectRelativeTarget,
    suffix
  };
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

const toPackageRelativeUrl = (sourcePath: string, rawValue: string, assetPaths: Set<string>): string => {
  const target = resolveProjectRelativeUrl(sourcePath, rawValue);
  if (!target) {
    return rawValue;
  }

  const firstSegment = target.projectRelativePath.split("/")[0] ?? "";
  if (PACKAGE_ASSET_TOP_LEVEL_DIRS.has(firstSegment)) {
    assetPaths.add(target.projectRelativePath);
  }

  return `${target.projectRelativePath}${target.suffix}`;
};

const rewriteSrcsetForPackage = (sourcePath: string, rawValue: string, assetPaths: Set<string>): string =>
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
      return [toPackageRelativeUrl(sourcePath, url, assetPaths), ...descriptor].join(" ");
    })
    .join(", ");

const rewriteHtmlUrlsForPackage = (sourcePath: string, html: string, assetPaths: Set<string>): string =>
  html
    .replace(/\b(src|href|poster|srcset)\s*=\s*(["'])([^"']+)\2/gi, (match, attr: string, quote: string, value: string) => {
      const rewrittenValue = attr.toLowerCase() === "srcset"
        ? rewriteSrcsetForPackage(sourcePath, value, assetPaths)
        : toPackageRelativeUrl(sourcePath, value, assetPaths);
      return `${attr}=${quote}${rewrittenValue}${quote}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
      const rewrittenValue = toPackageRelativeUrl(sourcePath, value, assetPaths);
      return `url(${quote}${rewrittenValue}${quote})`;
    });

const rewriteCssUrlsForPackage = (sourcePath: string, css: string, assetPaths: Set<string>): string =>
  css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
    const rewrittenValue = toPackageRelativeUrl(sourcePath, value, assetPaths);
    return `url(${quote}${rewrittenValue}${quote})`;
  });

const buildPreparedProject = async (
  project: CompilerProjectInput,
  initialFingerprints: readonly ExportFileFingerprint[] = []
): Promise<PreparedProject> => {
  const packageAssetPaths = new Set<string>();
  const sourceFingerprints = new Map<string, ExportFileFingerprint>();
  const addSourceFingerprint = (fingerprint: ExportFileFingerprint): void => {
    const existing = sourceFingerprints.get(fingerprint.path);
    if (existing && (existing.sha256 !== fingerprint.sha256 || existing.sizeBytes !== fingerprint.sizeBytes)) {
      throw new Error(`Project source changed between snapshot reads: ${fingerprint.path}`);
    }
    sourceFingerprints.set(fingerprint.path, fingerprint);
  };
  initialFingerprints.forEach(addSourceFingerprint);
  const themeSnapshot = project.themeCssPath
    ? await readProjectFileSnapshot(
        project.projectPath,
        toFingerprintProjectPath(project.projectPath, project.themeCssPath)
      )
    : undefined;
  if (themeSnapshot) {
    addSourceFingerprint(themeSnapshot.fingerprint);
  }
  if (project.themeTokensPath) {
    const tokensSnapshot = await readProjectFileSnapshot(
      project.projectPath,
      toFingerprintProjectPath(project.projectPath, project.themeTokensPath)
    );
    addSourceFingerprint(tokensSnapshot.fingerprint);
  }
  const rawThemeCss = themeSnapshot?.bytes.toString("utf8");
  const themeCss = project.themeCssPath
    ? rewriteCssUrlsForExport(project.themeCssPath, rawThemeCss ?? "")
    : undefined;
  const packageThemeCss = project.themeCssPath
    ? rewriteCssUrlsForPackage(project.themeCssPath, rawThemeCss ?? "", packageAssetPaths)
    : undefined;

  const slides: PreparedSlide[] = [];
  for (const [index, slide] of project.slides.entries()) {
    const sourceSnapshot = await readProjectFileSnapshot(
      project.projectPath,
      toFingerprintProjectPath(project.projectPath, slide.sourcePath)
    );
    addSourceFingerprint(sourceSnapshot.fingerprint);
    const notesSnapshot = slide.notesPath
      ? await readProjectFileSnapshot(
          project.projectPath,
          toFingerprintProjectPath(project.projectPath, slide.notesPath)
        )
      : undefined;
    if (notesSnapshot) {
      addSourceFingerprint(notesSnapshot.fingerprint);
    }
    const sourceHtml = sourceSnapshot.bytes.toString("utf8");
    const notes = notesSnapshot?.bytes.toString("utf8") ?? "";

    slides.push({
      ...slide,
      index,
      pdfPage: index + 1,
      durationSec: slide.durationSec ?? 60,
      sourceHtml,
      exportHtml: rewriteHtmlUrlsForExport(slide.sourcePath, sourceHtml),
      packageHtml: rewriteHtmlUrlsForPackage(slide.sourcePath, sourceHtml, packageAssetPaths),
      notes
    });
  }

  const packageAssets: PackageAssetEntry[] = [];
  for (const assetPath of [...packageAssetPaths].sort()) {
    if (!isSafePackageAssetPath(assetPath)) {
      throw new Error(`Unsafe package asset path: ${assetPath}`);
    }
    const assetSnapshot = await readProjectFileSnapshot(project.projectPath, assetPath);
    addSourceFingerprint(assetSnapshot.fingerprint);
    packageAssets.push({ packagePath: assetPath, bytes: assetSnapshot.bytes });
  }

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
    packageRenderable: {
      title: project.title,
      language: project.language,
      viewport: project.viewport,
      safeArea: project.safeArea,
      themeCss: packageThemeCss,
      slides: slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        html: slide.packageHtml,
        notes: slide.notes
      }))
    },
    packageAssets,
    sourceFingerprints: [...sourceFingerprints.values()].sort((left, right) =>
      compareFingerprintPaths(left.path, right.path)
    ),
    slides
  };
};

const buildStandaloneHtml = (renderable: RenderDeck): string =>
  `${buildDeckHtml(renderable, {
    mode: "print",
    includeRuntimeScript: true,
    includeNotesPanel: true
  })}\n`;

export const buildNotesSidecar = async (project: CompilerProjectInput): Promise<NotesSidecar> => {
  const prepared = await buildPreparedProject(project);
  return buildNotesSidecarFromPrepared(project, prepared);
};

const buildNotesSidecarFromPrepared = (project: CompilerProjectInput, prepared: PreparedProject): NotesSidecar => ({
  schemaVersion: DECK_PACKAGE_SCHEMA_VERSION,
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
    schemaVersion: DECK_PACKAGE_SCHEMA_VERSION,
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
  stagingExportsPath: string,
  finalExportsPath: string,
  size: ThumbnailSize
): Promise<ThumbnailEntry[]> => {
  const stagingThumbnailsPath = path.join(stagingExportsPath, "thumbnails");
  const finalThumbnailsPath = path.join(finalExportsPath, "thumbnails");
  const cachePath = path.join(project.projectPath, ".htmlslide", "cache", "thumbnails");
  await mkdir(stagingThumbnailsPath, { recursive: true });

  const entries: ThumbnailEntry[] = [];
  for (const slide of prepared.slides) {
    const bytes = renderThumbnailPng(project, slide, size);
    const fileName = `${slide.id}.png`;
    const stagingPath = path.join(stagingThumbnailsPath, fileName);
    const exportPath = path.join(finalThumbnailsPath, fileName);
    const cacheThumbnailPath = path.join(cachePath, fileName);
    await writeFile(stagingPath, bytes);
    entries.push({
      slideId: slide.id,
      packagePath: `thumbnails/${fileName}`,
      exportPath,
      stagingPath,
      cachePath: cacheThumbnailPath,
      bytes
    });
  }

  return entries;
};

const presenterSettings = {
  schemaVersion: DECK_PACKAGE_SCHEMA_VERSION,
  mode: "rehearsal",
  timer: true,
  notes: {
    visibleByDefault: false
  }
};

const addZipFile = (zip: JSZip, filePath: string, content: string | Uint8Array): void => {
  zip.file(filePath, content, {
    date: ZIP_DATE,
    unixPermissions: ZIP_FILE_PERMISSIONS
  });
};

const addZipDirectory = (zip: JSZip, directoryPath: string): void => {
  zip.file(directoryPath.endsWith("/") ? directoryPath : `${directoryPath}/`, null, {
    date: ZIP_DATE,
    dir: true,
    unixPermissions: ZIP_DIR_PERMISSIONS
  });
};

const isSafePackageAssetPath = (assetPath: string): boolean => {
  if (assetPath.length === 0 || assetPath.includes("\\") || path.posix.isAbsolute(assetPath)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(assetPath)) {
    return false;
  }
  const segments = assetPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  const firstSegment = segments[0] ?? "";
  return PACKAGE_ASSET_TOP_LEVEL_DIRS.has(firstSegment);
};

const addZipFileWithDirectories = (zip: JSZip, filePath: string, content: string | Uint8Array, directories: Set<string>): void => {
  const directoryParts = path.posix.dirname(filePath).split("/");
  if (directoryParts[0] !== ".") {
    let current = "";
    for (const part of directoryParts) {
      current = current ? `${current}/${part}` : part;
      if (!directories.has(current)) {
        addZipDirectory(zip, current);
        directories.add(current);
      }
    }
  }
  addZipFile(zip, filePath, content);
};

const loadCompilerProjectSnapshot = async (
  inputPath: string
): Promise<{ project: CompilerProjectInput; deckFingerprint: ExportFileFingerprint }> => {
  const firstLoad = await loadDeckProject(inputPath);
  const firstDeckSnapshot = await readProjectFileSnapshot(firstLoad.projectRoot, "deck.json");
  const secondLoad = await loadDeckProject(firstLoad.projectRoot);
  const secondDeckSnapshot = await readProjectFileSnapshot(secondLoad.projectRoot, "deck.json");

  if (
    firstDeckSnapshot.fingerprint.sha256 !== secondDeckSnapshot.fingerprint.sha256 ||
    JSON.stringify(firstLoad.deck) !== JSON.stringify(secondLoad.deck)
  ) {
    throw new Error("deck.json changed while the export snapshot was being loaded; retry the export.");
  }

  return {
    project: {
      projectPath: secondLoad.projectRoot,
      title: secondLoad.deck.title,
      language: secondLoad.deck.language,
      viewport: secondLoad.deck.viewport,
      safeArea: secondLoad.deck.safeArea,
      themeCssPath: secondLoad.deck.theme?.css,
      themeTokensPath: secondLoad.deck.theme?.tokens,
      slides: secondLoad.deck.slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        sourcePath: slide.source,
        notesPath: slide.notes,
        durationSec: slide.durationSec
      }))
    },
    deckFingerprint: secondDeckSnapshot.fingerprint
  };
};

const stageExportArtifact = async (input: {
  bytes: Uint8Array | string;
  finalExportsPath: string;
  kind: ExportArtifactKind;
  projectPath: string;
  slideId?: string;
  stagingExportsPath: string;
}): Promise<StagedArtifact> => {
  if (!input.projectPath.startsWith("exports/")) {
    throw new Error(`Staged artifact must be under exports/: ${input.projectPath}`);
  }
  const relativeArtifactPath = input.projectPath.slice("exports/".length);
  const stagingPath = path.join(input.stagingExportsPath, ...relativeArtifactPath.split("/"));
  const finalPath = path.join(input.finalExportsPath, ...relativeArtifactPath.split("/"));
  await mkdir(path.dirname(stagingPath), { recursive: true });
  await writeFile(stagingPath, input.bytes);
  return {
    finalPath,
    fingerprint: {
      ...fingerprintBytes(input.projectPath, input.bytes),
      kind: input.kind,
      ...(input.slideId ? { slideId: input.slideId } : {})
    },
    projectPath: input.projectPath,
    stagingPath
  };
};

const commitStagedExports = async (input: {
  manifestJson: string;
  projectRoot: string;
  sourceFingerprints: ExportFileFingerprint[];
  stagedArtifacts: StagedArtifact[];
  stagingManifestPath: string;
}): Promise<void> => {
  await ensureSafeProjectDirectory(input.projectRoot, "exports");
  const currentManifest = await readExistingExportManifest(input.projectRoot);

  for (const artifact of input.stagedArtifacts) {
    const stagingProjectPath = toFingerprintProjectPath(input.projectRoot, artifact.stagingPath);
    const stagedFingerprint = await fingerprintProjectFile(input.projectRoot, stagingProjectPath);
    if (
      stagedFingerprint.sha256 !== artifact.fingerprint.sha256 ||
      stagedFingerprint.sizeBytes !== artifact.fingerprint.sizeBytes
    ) {
      throw new Error(`Staged export changed before commit: ${artifact.projectPath}`);
    }
  }
  if ((await readFile(input.stagingManifestPath, "utf8")) !== input.manifestJson) {
    throw new Error("Staged export manifest changed before commit.");
  }

  await preflightExportCommit(input.projectRoot, input.stagedArtifacts, currentManifest);
  const backupRoot = path.join(path.dirname(path.dirname(input.stagingManifestPath)), "backup");
  const backups: ExportArtifactBackup[] = [];
  const committedArtifacts: StagedArtifact[] = [];

  try {
    for (const oldArtifact of currentManifest?.artifacts ?? []) {
      await ensureSafeProjectDirectory(input.projectRoot, path.posix.dirname(oldArtifact.path));
      const finalPath = path.join(input.projectRoot, ...oldArtifact.path.split("/"));
      const info = await lstatIfExists(finalPath);
      if (!info) {
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Export artifact changed after preflight: ${oldArtifact.path}`);
      }
      const backupPath = path.join(backupRoot, ...oldArtifact.path.split("/"));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await rename(finalPath, backupPath);
      backups.push({ backupPath, finalPath, projectPath: oldArtifact.path });
    }

    for (const artifact of [...input.stagedArtifacts].sort((left, right) =>
      compareFingerprintPaths(left.projectPath, right.projectPath)
    )) {
      await replaceStagedFile(input.projectRoot, artifact.stagingPath, artifact.projectPath, { requireMissing: true });
      committedArtifacts.push(artifact);
    }
    for (const artifact of input.stagedArtifacts) {
      const committedFingerprint = await fingerprintProjectFile(input.projectRoot, artifact.projectPath);
      if (
        committedFingerprint.sha256 !== artifact.fingerprint.sha256 ||
        committedFingerprint.sizeBytes !== artifact.fingerprint.sizeBytes
      ) {
        throw new Error(`Committed export changed before manifest commit: ${artifact.projectPath}`);
      }
    }
    const committedSourceFingerprints = await fingerprintProjectFiles(
      input.projectRoot,
      input.sourceFingerprints.map((entry) => entry.path)
    );
    const changedSources = changedFingerprintPaths(committedSourceFingerprints, input.sourceFingerprints);
    if (changedSources.length > 0) {
      throw new Error(`Project sources changed before manifest commit: ${changedSources.join(", ")}. Retry the export.`);
    }
    await replaceStagedFile(input.projectRoot, input.stagingManifestPath, EXPORT_MANIFEST_PROJECT_PATH);
  } catch (error) {
    await rollbackExportCommit(input.projectRoot, committedArtifacts, backups, error);
    throw error;
  }
};

const preflightExportCommit = async (
  projectRoot: string,
  stagedArtifacts: readonly StagedArtifact[],
  currentManifest: ExportManifest | undefined
): Promise<void> => {
  const ownedPaths = new Set(currentManifest?.artifacts.map((artifact) => artifact.path) ?? []);
  const stagedPaths = new Set(stagedArtifacts.map((artifact) => artifact.projectPath));
  const pathsToInspect = new Set([
    EXPORT_MANIFEST_PROJECT_PATH,
    ...ownedPaths,
    ...stagedArtifacts.map((artifact) => artifact.projectPath)
  ]);

  for (const projectPath of [...pathsToInspect].sort(compareFingerprintPaths)) {
    await ensureSafeProjectDirectory(projectRoot, path.posix.dirname(projectPath));
    const finalPath = path.join(projectRoot, ...projectPath.split("/"));
    const info = await lstatIfExists(finalPath);
    if (!info) {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Export destination must be a regular file: ${projectPath}`);
    }
    if (
      projectPath !== EXPORT_MANIFEST_PROJECT_PATH &&
      stagedPaths.has(projectPath) &&
      !ownedPaths.has(projectPath)
    ) {
      throw new Error(`Refusing to replace an untracked export file: ${projectPath}`);
    }
  }
};

const rollbackExportCommit = async (
  projectRoot: string,
  committedArtifacts: readonly StagedArtifact[],
  backups: readonly ExportArtifactBackup[],
  originalError: unknown
): Promise<void> => {
  const rollbackErrors: unknown[] = [];
  for (const artifact of [...committedArtifacts].reverse()) {
    try {
      await removeOwnedExportPath(projectRoot, artifact.projectPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const backup of [...backups].reverse()) {
    try {
      await ensureSafeProjectDirectory(projectRoot, path.posix.dirname(backup.projectPath));
      if (await lstatIfExists(backup.finalPath)) {
        throw new Error(`Rollback destination is no longer empty: ${backup.projectPath}`);
      }
      await rename(backup.backupPath, backup.finalPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      "Export commit failed and the previous artifact set could not be fully restored."
    );
  }
};

const readExistingExportManifest = async (projectRoot: string): Promise<ExportManifest | undefined> => {
  try {
    const manifestPath = path.join(projectRoot, ...EXPORT_MANIFEST_PROJECT_PATH.split("/"));
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_EXPORT_MANIFEST_BYTES) {
      return undefined;
    }
    const snapshot = await readProjectFileSnapshot(projectRoot, EXPORT_MANIFEST_PROJECT_PATH);
    const raw = snapshot.bytes.toString("utf8");
    const parsed = ExportManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const replaceStagedFile = async (
  projectRoot: string,
  stagingPath: string,
  projectPath: string,
  options: { requireMissing?: boolean } = {}
): Promise<void> => {
  const finalPath = path.join(projectRoot, ...projectPath.split("/"));
  const parentProjectPath = path.posix.dirname(projectPath);
  await ensureSafeProjectDirectory(projectRoot, parentProjectPath);
  const existing = await lstatIfExists(finalPath);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Export destination must be a regular file: ${projectPath}`);
  }
  if (options.requireMissing && existing) {
    throw new Error(`Export destination changed after preflight: ${projectPath}`);
  }
  await rename(stagingPath, finalPath);
};

const removeOwnedExportPath = async (projectRoot: string, projectPath: string): Promise<void> => {
  if (!projectPath.startsWith("exports/") || projectPath === EXPORT_MANIFEST_PROJECT_PATH) {
    throw new Error(`Refusing to remove non-artifact export path: ${projectPath}`);
  }
  await ensureSafeProjectDirectory(projectRoot, path.posix.dirname(projectPath));
  const absolutePath = path.join(projectRoot, ...projectPath.split("/"));
  const info = await lstatIfExists(absolutePath);
  if (!info) {
    return;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing to remove a non-regular export artifact: ${projectPath}`);
  }
  await rm(absolutePath, { force: true });
};

const writeThumbnailCache = async (projectRoot: string, entries: ThumbnailEntry[]): Promise<void> => {
  if (entries.length === 0) {
    return;
  }
  const cacheProjectPath = ".htmlslide/cache/thumbnails";
  const cachePath = await ensureSafeProjectDirectory(projectRoot, cacheProjectPath);
  const expectedNames = new Set(entries.map((entry) => path.basename(entry.cachePath)));
  for (const existingName of await readdir(cachePath)) {
    if (existingName.endsWith(".png") && !expectedNames.has(existingName)) {
      const existingPath = path.join(cachePath, existingName);
      const info = await lstatIfExists(existingPath);
      if (info && !info.isDirectory()) {
        await rm(existingPath, { force: true });
      }
    }
  }
  for (const entry of entries) {
    const temporaryPath = `${entry.cachePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, entry.bytes);
      const existing = await lstatIfExists(entry.cachePath);
      if (existing?.isDirectory()) {
        throw new Error(`Thumbnail cache destination is a directory: ${entry.cachePath}`);
      }
      if (existing?.isSymbolicLink()) {
        await rm(entry.cachePath, { force: true });
      }
      try {
        await rename(temporaryPath, entry.cachePath);
      } catch (error) {
        if (!existing || !["EEXIST", "EPERM"].includes(errorCode(error) ?? "")) {
          throw error;
        }
        await rm(entry.cachePath, { force: true });
        await rename(temporaryPath, entry.cachePath);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
};

type ExportLockOwner = {
  pid: number;
  token: string;
};

const EXPORT_LOCK_INITIALIZATION_GRACE_MS = 30_000;
const EXPORT_LOCK_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const acquireExportLock = async (projectRoot: string): Promise<() => Promise<void>> => {
  const cachePath = await ensureSafeProjectDirectory(projectRoot, ".htmlslide/cache");
  const lockPath = path.join(cachePath, "export.lock");
  const owner: ExportLockOwner = { pid: process.pid, token: randomUUID() };

  try {
    await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    return releaseExportLock(lockPath, owner);
  } catch (error) {
    if (!["EEXIST", "EISDIR"].includes(errorCode(error) ?? "")) {
      throw error;
    }
  }

  const currentOwner = await readLockOwner(lockPath);
  if (currentOwner?.pid && isProcessAlive(currentOwner.pid)) {
    throw new Error(`Another HTMLslide export is already running for ${projectRoot}.`);
  }
  const lockInfo = await lstatIfExists(lockPath);
  if (!currentOwner) {
    if (lockInfo && Date.now() - Number(lockInfo.mtimeMs) < EXPORT_LOCK_INITIALIZATION_GRACE_MS) {
      throw new Error(`Another HTMLslide export is initializing for ${projectRoot}.`);
    }
    throw new Error(`Invalid stale export lock requires manual removal: ${lockPath}.`);
  }
  if (lockInfo?.isDirectory()) {
    throw new Error(`Legacy stale export lock requires manual removal: ${lockPath}.`);
  }
  return takeOverStaleExportLock(lockPath, currentOwner, owner, projectRoot);
};

const takeOverStaleExportLock = async (
  lockPath: string,
  staleOwner: ExportLockOwner,
  owner: ExportLockOwner,
  projectRoot: string
): Promise<() => Promise<void>> => {
  const recoveryPath = `${lockPath}.recover-${staleOwner.token}`;
  const replacementPath = `${lockPath}.${owner.token}.tmp`;
  try {
    await writeFile(recoveryPath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`Another HTMLslide export is recovering a stale lock for ${projectRoot}.`);
    }
    throw error;
  }

  try {
    const currentOwner = await readLockOwner(lockPath);
    if (
      !currentOwner ||
      currentOwner.pid !== staleOwner.pid ||
      currentOwner.token !== staleOwner.token ||
      isProcessAlive(currentOwner.pid)
    ) {
      throw new Error(`HTMLslide export lock changed while stale recovery was starting for ${projectRoot}.`);
    }
    const lockInfo = await lstat(lockPath);
    if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
      throw new Error(`Stale export lock must be a regular file: ${lockPath}.`);
    }
    await writeFile(replacementPath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    await rename(replacementPath, lockPath);
    return releaseExportLock(lockPath, owner);
  } finally {
    await rm(replacementPath, { force: true });
    await rm(recoveryPath, { force: true });
  }
};

const releaseExportLock = (lockPath: string, owner: ExportLockOwner): (() => Promise<void>) =>
  async () => {
    const currentOwner = await readLockOwner(lockPath);
    if (currentOwner?.token === owner.token) {
      await rm(lockPath, { force: true });
    }
  };

const ensureSafeProjectDirectory = async (projectRoot: string, projectPath: string): Promise<string> => {
  const root = path.resolve(projectRoot);
  const segments = projectPath.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Unsafe project directory path: ${projectPath}`);
    }
    current = path.join(current, segment);
    let info = await lstatIfExists(current);
    if (!info) {
      try {
        await mkdir(current);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Project runtime directory must not be a symlink or file: ${projectPath}`);
    }
  }

  const [rootRealPath, directoryRealPath] = await Promise.all([realpath(root), realpath(current)]);
  const relativePath = path.relative(rootRealPath, directoryRealPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Project runtime directory escapes project root: ${projectPath}`);
  }
  return current;
};

const lstatIfExists = async (filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const readLockOwner = async (lockPath: string): Promise<ExportLockOwner | undefined> => {
  try {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink()) {
      return undefined;
    }
    const ownerPath = info.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    const ownerInfo = await lstat(ownerPath);
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.size > 4_096) {
      return undefined;
    }
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
      return undefined;
    }
    const token = typeof owner.token === "string" ? owner.token : "legacy-lock";
    return EXPORT_LOCK_TOKEN_PATTERN.test(token) ? { pid: owner.pid, token } : undefined;
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const exportDeck = async (
  inputProject: CompilerProjectInput,
  options: ExportOptions = DEFAULT_OPTIONS
): Promise<ExportResult> => {
  const discoveredProject = await loadDeckProject(inputProject.projectPath, { verifyFiles: false });
  const projectRoot = await realpath(discoveredProject.projectRoot);
  const releaseLock = await acquireExportLock(projectRoot);
  try {
    return await exportDeckLocked(discoveredProject.projectRoot, options);
  } finally {
    await releaseLock();
  }
};

const exportDeckLocked = async (
  projectRoot: string,
  options: ExportOptions
): Promise<ExportResult> => {
  const resolvedOptions = {
    pdf: options.pdf ?? DEFAULT_OPTIONS.pdf,
    html: options.html ?? DEFAULT_OPTIONS.html,
    deckpkg: options.deckpkg ?? DEFAULT_OPTIONS.deckpkg,
    thumbnails: options.thumbnails ?? DEFAULT_OPTIONS.thumbnails,
    thumbnailSize: options.thumbnailSize ?? DEFAULT_THUMBNAIL_SIZE
  };
  const { project, deckFingerprint } = await loadCompilerProjectSnapshot(projectRoot);
  const exportsPath = path.join(project.projectPath, "exports");
  const stagingRoot = path.join(
    project.projectPath,
    ".htmlslide",
    "cache",
    "export-staging",
    `${process.pid}-${randomUUID()}`
  );
  const stagingExportsPath = path.join(stagingRoot, "exports");
  const stagingParent = await ensureSafeProjectDirectory(project.projectPath, ".htmlslide/cache/export-staging");
  await mkdir(path.join(stagingParent, path.basename(stagingRoot)));
  await mkdir(stagingExportsPath);

  try {
    const baseName = slugFileName(project.title);
    const prepared = await buildPreparedProject(project, [deckFingerprint]);
    const html = buildStandaloneHtml(prepared.renderable);
    const packageHtml = resolvedOptions.deckpkg ? buildStandaloneHtml(prepared.packageRenderable) : undefined;
    const notesSidecar = buildNotesSidecarFromPrepared(project, prepared);
    const notesJson = `${JSON.stringify(notesSidecar, null, 2)}\n`;
    const artifacts: ExportResult["artifacts"] = {};
    const stagedArtifacts: StagedArtifact[] = [];
    const verification: ExportVerification = {
      expectedPageCount: prepared.slides.length
    };

    const notesArtifact = await stageExportArtifact({
      bytes: notesJson,
      finalExportsPath: exportsPath,
      kind: "notes",
      projectPath: "exports/notes.json",
      stagingExportsPath
    });
    stagedArtifacts.push(notesArtifact);
    artifacts.notes = notesArtifact.finalPath;

    if (resolvedOptions.html) {
      const htmlArtifact = await stageExportArtifact({
        bytes: html,
        finalExportsPath: exportsPath,
        kind: "html",
        projectPath: `exports/${baseName}.html`,
        stagingExportsPath
      });
      stagedArtifacts.push(htmlArtifact);
      artifacts.html = htmlArtifact.finalPath;
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
        const pdfArtifact = await stageExportArtifact({
          bytes: pdfBytes,
          finalExportsPath: exportsPath,
          kind: "pdf",
          projectPath: `exports/${baseName}.pdf`,
          stagingExportsPath
        });
        stagedArtifacts.push(pdfArtifact);
        artifacts.pdf = pdfArtifact.finalPath;
      }
    }

    let thumbnailEntries: ThumbnailEntry[] = [];
    if (resolvedOptions.thumbnails || resolvedOptions.deckpkg) {
      thumbnailEntries = await writeThumbnails(
        project,
        prepared,
        stagingExportsPath,
        exportsPath,
        resolvedOptions.thumbnailSize
      );
      for (const entry of thumbnailEntries) {
        stagedArtifacts.push({
          finalPath: entry.exportPath,
          fingerprint: {
            ...fingerprintBytes(toFingerprintProjectPath(project.projectPath, entry.exportPath), entry.bytes),
            kind: "thumbnail",
            slideId: entry.slideId
          },
          projectPath: toFingerprintProjectPath(project.projectPath, entry.exportPath),
          stagingPath: entry.stagingPath
        });
      }
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
      const packageDirectories = new Set<string>();
      const manifest = buildDeckPackageManifest(project, {
        thumbnailSize: resolvedOptions.thumbnailSize,
        pageCount: verification.pdfPageCount
      });
      addZipFile(zip, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
      addZipFile(zip, PACKAGE_HTML_PATH, packageHtml ?? html);
      addZipFile(zip, PACKAGE_PDF_PATH, pdfBytes);
      addZipFile(zip, PACKAGE_NOTES_PATH, notesJson);
      addZipFile(zip, PACKAGE_PRESENTER_SETTINGS_PATH, `${JSON.stringify(presenterSettings, null, 2)}\n`);
      addZipDirectory(zip, "thumbnails");
      packageDirectories.add("thumbnails");
      for (const thumbnail of thumbnailEntries) {
        addZipFile(zip, thumbnail.packagePath, thumbnail.bytes);
      }
      for (const asset of prepared.packageAssets) {
        addZipFileWithDirectories(zip, asset.packagePath, asset.bytes, packageDirectories);
      }

      const deckpkgBytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: {
          level: 9
        },
        platform: "UNIX"
      });
      const deckpkgArtifact = await stageExportArtifact({
        bytes: deckpkgBytes,
        finalExportsPath: exportsPath,
        kind: "deckpkg",
        projectPath: `exports/${baseName}.deckpkg`,
        stagingExportsPath
      });
      stagedArtifacts.push(deckpkgArtifact);
      artifacts.deckpkg = deckpkgArtifact.finalPath;
    }

    const currentSourceFingerprints = await fingerprintProjectFiles(
      project.projectPath,
      prepared.sourceFingerprints.map((entry) => entry.path)
    );
    const changedSources = changedFingerprintPaths(currentSourceFingerprints, prepared.sourceFingerprints);
    if (changedSources.length > 0) {
      throw new Error(`Project sources changed during export: ${changedSources.join(", ")}. Retry the export.`);
    }

    const exportManifest = createExportManifest({
      sources: prepared.sourceFingerprints,
      artifacts: stagedArtifacts.map((artifact) => artifact.fingerprint)
    });
    const manifestJson = `${JSON.stringify(exportManifest, null, 2)}\n`;
    if (Buffer.byteLength(manifestJson) > MAX_EXPORT_MANIFEST_BYTES) {
      throw new Error(`Export manifest exceeds ${MAX_EXPORT_MANIFEST_BYTES} bytes.`);
    }
    const stagingManifestPath = path.join(stagingExportsPath, EXPORT_MANIFEST_FILE_NAME);
    await writeFile(stagingManifestPath, manifestJson);
    await writeThumbnailCache(project.projectPath, thumbnailEntries);
    await commitStagedExports({
      manifestJson,
      projectRoot: project.projectPath,
      sourceFingerprints: prepared.sourceFingerprints,
      stagedArtifacts,
      stagingManifestPath
    });
    return {
      projectPath: project.projectPath,
      exportsPath,
      artifacts,
      metadata: {
        manifest: path.join(project.projectPath, ...EXPORT_MANIFEST_PROJECT_PATH.split("/"))
      },
      verification
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};
