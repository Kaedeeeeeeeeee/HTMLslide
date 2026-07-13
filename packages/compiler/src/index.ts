import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import postcss from "postcss";
import {
  changedFingerprintPaths,
  compareFingerprintPaths,
  createExportManifest,
  ExportManifestSchema,
  EXPORT_MANIFEST_FILE_NAME,
  EXPORT_MANIFEST_PROJECT_PATH,
  fingerprintBytes,
  fingerprintEntriesDigest,
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
import {
  buildDeckHtml,
  buildSlidePreviewDocument as buildRendererSlidePreviewDocument,
  PREVIEW_CONTENT_SECURITY_POLICY as RENDERER_PREVIEW_CONTENT_SECURITY_POLICY,
  type RenderDeck
} from "@htmlslide/renderer";
import { renderWithChromium, type BrowserRenderResult } from "./browser-renderer.js";

export { BrowserRenderError, inspectChromiumRuntime } from "./browser-renderer.js";
export {
  PdfRasterError,
  rasterizePdfPages,
  readPdfRasterPngDimensions,
  runPdfRasterCommand,
  type PdfRasterCommandResult,
  type PdfRasterCommandRunner,
  type PdfRasterErrorCode,
  type PdfRasterOptions,
  type PdfRasterPage,
  type PdfRasterResult
} from "./pdf-raster.js";

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
  chromiumExecutablePath?: string;
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

export type SlidePreviewDocument = {
  projectRoot: string;
  slideId: string;
  sourcePath: string;
  title: string;
  viewport: CompilerProjectInput["viewport"];
  notes: string;
  htmlDocument: string;
  sourceDigest: string;
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
const ZIP_FILE_PERMISSIONS = 0o100644;
const ZIP_DIR_PERMISSIONS = 0o40755;
const PACKAGE_HTML_PATH = "deck.html";
const PACKAGE_PDF_PATH = "deck.pdf";
const PACKAGE_NOTES_PATH = "notes.json";
const PACKAGE_PRESENTER_SETTINGS_PATH = "presenter-settings.json";
const PROJECT_TOP_LEVEL_DIRS = new Set(["assets", "slides", "notes", "theme", "skills", ".htmlslide"]);
const PACKAGE_ASSET_TOP_LEVEL_DIRS = new Set(["assets", "slides", "theme"]);

type UrlSerializationMode = "export" | "package" | "inline-preview";

type ProjectUrlSerializer = (sourcePath: string, rawValue: string) => string;

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

const fragmentFromUrlSuffix = (suffix: string): string => {
  const fragmentIndex = suffix.indexOf("#");
  return fragmentIndex >= 0 ? suffix.slice(fragmentIndex) : "";
};

const createProjectUrlSerializer = (input: {
  mode: UrlSerializationMode;
  assetPaths?: Set<string>;
  inlineAssetUrls?: ReadonlyMap<string, string>;
}): ProjectUrlSerializer =>
  (sourcePath, rawValue) => {
    const target = resolveProjectRelativeUrl(sourcePath, rawValue);
    if (!target) {
      return rawValue;
    }

    if (input.mode === "export") {
      return `../${target.projectRelativePath}${target.suffix}`;
    }

    const firstSegment = target.projectRelativePath.split("/")[0] ?? "";
    if (input.mode === "package") {
      if (PACKAGE_ASSET_TOP_LEVEL_DIRS.has(firstSegment)) {
        input.assetPaths?.add(target.projectRelativePath);
      }
      return `${target.projectRelativePath}${target.suffix}`;
    }

    if (!PACKAGE_ASSET_TOP_LEVEL_DIRS.has(firstSegment)) {
      return rawValue;
    }
    const inlineAssetUrl = input.inlineAssetUrls?.get(target.projectRelativePath);
    return inlineAssetUrl
      ? `${inlineAssetUrl}${fragmentFromUrlSuffix(target.suffix)}`
      : rawValue;
  };

const createPackageCssUrlSerializer = (assetPaths: Set<string>): ProjectUrlSerializer =>
  (sourcePath, rawValue) => {
    const target = resolveProjectRelativeUrl(sourcePath, rawValue);
    if (!target) {
      return rawValue;
    }
    const firstSegment = target.projectRelativePath.split("/")[0] ?? "";
    if (!PACKAGE_ASSET_TOP_LEVEL_DIRS.has(firstSegment)) {
      return rawValue;
    }
    assetPaths.add(target.projectRelativePath);
    const relativePath = path.posix.relative(path.posix.dirname(normalizeProjectPath(sourcePath)), target.projectRelativePath);
    const browserRelativePath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
    return `${browserRelativePath}${target.suffix}`;
  };

const rewriteSrcsetUrls = (
  sourcePath: string,
  rawValue: string,
  serializeUrl: ProjectUrlSerializer
): string =>
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
      return [serializeUrl(sourcePath, url), ...descriptor].join(" ");
    })
    .join(", ");

const rewriteHtmlUrls = (
  sourcePath: string,
  html: string,
  serializeUrl: ProjectUrlSerializer
): string =>
  html
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attributes: string, css: string) =>
      `<style${attributes}>${rewriteCssUrls(sourcePath, css, serializeUrl)}</style>`
    )
    .replace(/\b(src|href|poster|srcset)\s*=\s*(["'])([^"']+)\2/gi, (match, attr: string, quote: string, value: string) => {
      const rewrittenValue = attr.toLowerCase() === "srcset"
        ? rewriteSrcsetUrls(sourcePath, value, serializeUrl)
        : serializeUrl(sourcePath, value);
      return `${attr}=${quote}${rewrittenValue}${quote}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
      const rewrittenValue = serializeUrl(sourcePath, value);
      return `url(${quote}${rewrittenValue}${quote})`;
    });

const rewriteCssValueUrls = (
  sourcePath: string,
  value: string,
  serializeUrl: ProjectUrlSerializer
): string =>
  value.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, rawUrl: string) => {
    const rewrittenValue = serializeUrl(sourcePath, rawUrl);
    return `url(${quote}${rewrittenValue}${quote})`;
  });

const rewriteCssImportParams = (
  sourcePath: string,
  params: string,
  serializeUrl: ProjectUrlSerializer
): string => {
  const rewrittenUrl = rewriteCssValueUrls(sourcePath, params, serializeUrl);
  return rewrittenUrl.replace(/^(\s*)(["'])([^"']+)\2/, (_match, spacing: string, quote: string, rawUrl: string) =>
    `${spacing}${quote}${serializeUrl(sourcePath, rawUrl)}${quote}`
  );
};

const rewriteCssUrls = (
  sourcePath: string,
  css: string,
  serializeUrl: ProjectUrlSerializer
): string => {
  const root = postcss.parse(css, { from: sourcePath });
  root.walkDecls((declaration) => {
    declaration.value = rewriteCssValueUrls(sourcePath, declaration.value, serializeUrl);
  });
  root.walkAtRules("import", (atRule) => {
    atRule.params = rewriteCssImportParams(sourcePath, atRule.params, serializeUrl);
  });
  return root.toString();
};

const mimeTypeForAssetPath = (assetPath: string): string => {
  const extension = path.posix.extname(assetPath).slice(1).toLowerCase();
  switch (extension) {
    case "avif":
      return "image/avif";
    case "css":
      return "text/css";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "json":
      return "application/json";
    case "m4a":
      return "audio/mp4";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "ogg":
      return "audio/ogg";
    case "otf":
      return "font/otf";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "ttf":
      return "font/ttf";
    case "wav":
      return "audio/wav";
    case "webm":
      return "video/webm";
    case "webp":
      return "image/webp";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
};

const toDataUrl = (assetPath: string, bytes: Uint8Array): string =>
  `data:${mimeTypeForAssetPath(assetPath)};base64,${Buffer.from(bytes).toString("base64")}`;

const PREVIEW_MAX_INLINE_ASSET_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_INLINE_TOTAL_BYTES = 64 * 1024 * 1024;

const createSourceFingerprintCollector = (
  initialFingerprints: readonly ExportFileFingerprint[] = []
): {
  add: (fingerprint: ExportFileFingerprint) => void;
  sorted: () => ExportFileFingerprint[];
} => {
  const sourceFingerprints = new Map<string, ExportFileFingerprint>();
  const add = (fingerprint: ExportFileFingerprint): void => {
    const existing = sourceFingerprints.get(fingerprint.path);
    if (existing && (existing.sha256 !== fingerprint.sha256 || existing.sizeBytes !== fingerprint.sizeBytes)) {
      throw new Error(`Project source changed between snapshot reads: ${fingerprint.path}`);
    }
    sourceFingerprints.set(fingerprint.path, fingerprint);
  };
  initialFingerprints.forEach(add);

  return {
    add,
    sorted: () => [...sourceFingerprints.values()].sort((left, right) =>
      compareFingerprintPaths(left.path, right.path)
    )
  };
};

const buildPreparedProject = async (
  project: CompilerProjectInput,
  initialFingerprints: readonly ExportFileFingerprint[] = []
): Promise<PreparedProject> => {
  const packageAssetPaths = new Set<string>();
  const exportUrlSerializer = createProjectUrlSerializer({ mode: "export" });
  const packageUrlSerializer = createProjectUrlSerializer({
    mode: "package",
    assetPaths: packageAssetPaths
  });
  const packageCssUrlSerializer = createPackageCssUrlSerializer(packageAssetPaths);
  const sourceFingerprints = createSourceFingerprintCollector(initialFingerprints);
  const themeSnapshot = project.themeCssPath
    ? await readProjectFileSnapshot(
        project.projectPath,
        toFingerprintProjectPath(project.projectPath, project.themeCssPath)
      )
    : undefined;
  if (themeSnapshot) {
    sourceFingerprints.add(themeSnapshot.fingerprint);
  }
  if (project.themeTokensPath) {
    const tokensSnapshot = await readProjectFileSnapshot(
      project.projectPath,
      toFingerprintProjectPath(project.projectPath, project.themeTokensPath)
    );
    sourceFingerprints.add(tokensSnapshot.fingerprint);
  }
  const rawThemeCss = themeSnapshot?.bytes.toString("utf8");
  const themeCss = project.themeCssPath
    ? rewriteCssUrls(project.themeCssPath, rawThemeCss ?? "", exportUrlSerializer)
    : undefined;
  const packageThemeCss = project.themeCssPath
    ? rewriteCssUrls(project.themeCssPath, rawThemeCss ?? "", packageUrlSerializer)
    : undefined;

  const slides: PreparedSlide[] = [];
  for (const [index, slide] of project.slides.entries()) {
    const sourceSnapshot = await readProjectFileSnapshot(
      project.projectPath,
      toFingerprintProjectPath(project.projectPath, slide.sourcePath)
    );
    sourceFingerprints.add(sourceSnapshot.fingerprint);
    const notesSnapshot = slide.notesPath
      ? await readProjectFileSnapshot(
          project.projectPath,
          toFingerprintProjectPath(project.projectPath, slide.notesPath)
        )
      : undefined;
    if (notesSnapshot) {
      sourceFingerprints.add(notesSnapshot.fingerprint);
    }
    const sourceHtml = sourceSnapshot.bytes.toString("utf8");
    const notes = notesSnapshot?.bytes.toString("utf8") ?? "";

    slides.push({
      ...slide,
      index,
      pdfPage: index + 1,
      durationSec: slide.durationSec ?? 60,
      sourceHtml,
      exportHtml: rewriteHtmlUrls(slide.sourcePath, sourceHtml, exportUrlSerializer),
      packageHtml: rewriteHtmlUrls(slide.sourcePath, sourceHtml, packageUrlSerializer),
      notes
    });
  }

  const packageAssets: PackageAssetEntry[] = [];
  const processedPackageAssets = new Set<string>();
  const pendingPackageAssets = [...packageAssetPaths].sort();
  while (pendingPackageAssets.length > 0) {
    const assetPath = pendingPackageAssets.shift();
    if (!assetPath || processedPackageAssets.has(assetPath)) {
      continue;
    }
    if (!isSafePackageAssetPath(assetPath)) {
      throw new Error(`Unsafe package asset path: ${assetPath}`);
    }
    const assetSnapshot = await readProjectFileSnapshot(project.projectPath, assetPath);
    sourceFingerprints.add(assetSnapshot.fingerprint);
    const bytes = path.posix.extname(assetPath).toLowerCase() === ".css"
      ? Buffer.from(rewriteCssUrls(assetPath, assetSnapshot.bytes.toString("utf8"), packageCssUrlSerializer))
      : assetSnapshot.bytes;
    packageAssets.push({ packagePath: assetPath, bytes });
    processedPackageAssets.add(assetPath);
    for (const discoveredPath of [...packageAssetPaths].sort()) {
      if (!processedPackageAssets.has(discoveredPath) && !pendingPackageAssets.includes(discoveredPath)) {
        pendingPackageAssets.push(discoveredPath);
      }
    }
    pendingPackageAssets.sort();
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
    sourceFingerprints: sourceFingerprints.sorted(),
    slides
  };
};

const buildStandaloneHtml = (renderable: RenderDeck): string =>
  `${buildDeckHtml(renderable, {
    mode: "print",
    includeRuntimeScript: true,
    includeNotesPanel: true
  })}\n`;

const buildPrintHtml = (renderable: RenderDeck): string =>
  `${buildDeckHtml(renderable, {
    mode: "print",
    includeRuntimeScript: false,
    includeNotesPanel: false
  })}\n`;

export const buildSlidePreviewDocument = async (
  inputPath: string,
  options: { slideId: string }
): Promise<SlidePreviewDocument> => {
  const { project, deckFingerprint } = await loadCompilerProjectSnapshot(inputPath);
  const requestedSlide = project.slides.find((slide) => slide.id === options.slideId);
  if (!requestedSlide) {
    throw new Error(`Unknown slide id "${options.slideId}" in ${project.projectPath}.`);
  }

  const sourceFingerprints = createSourceFingerprintCollector([deckFingerprint]);
  const themeSnapshot = project.themeCssPath
    ? await readProjectFileSnapshot(
        project.projectPath,
        toFingerprintProjectPath(project.projectPath, project.themeCssPath)
      )
    : undefined;
  if (themeSnapshot) {
    sourceFingerprints.add(themeSnapshot.fingerprint);
  }
  if (project.themeTokensPath) {
    const tokensSnapshot = await readProjectFileSnapshot(
      project.projectPath,
      toFingerprintProjectPath(project.projectPath, project.themeTokensPath)
    );
    sourceFingerprints.add(tokensSnapshot.fingerprint);
  }

  const sourceSnapshot = await readProjectFileSnapshot(
    project.projectPath,
    toFingerprintProjectPath(project.projectPath, requestedSlide.sourcePath)
  );
  sourceFingerprints.add(sourceSnapshot.fingerprint);
  const notesSnapshot = requestedSlide.notesPath
    ? await readProjectFileSnapshot(
        project.projectPath,
        toFingerprintProjectPath(project.projectPath, requestedSlide.notesPath)
      )
    : undefined;
  if (notesSnapshot) {
    sourceFingerprints.add(notesSnapshot.fingerprint);
  }

  const sourceHtml = sourceSnapshot.bytes.toString("utf8");
  const notes = notesSnapshot?.bytes.toString("utf8") ?? "";
  const rawThemeCss = themeSnapshot?.bytes.toString("utf8") ?? "";
  const previewAssetPaths = new Set<string>();
  const previewAssetCollector = createProjectUrlSerializer({
    mode: "package",
    assetPaths: previewAssetPaths
  });
  if (project.themeCssPath) {
    rewriteCssUrls(project.themeCssPath, rawThemeCss, previewAssetCollector);
  }
  rewriteHtmlUrls(requestedSlide.sourcePath, sourceHtml, previewAssetCollector);

  const inlineAssetUrls = new Map<string, string>();
  let totalInlineAssetBytes = 0;
  for (const assetPath of [...previewAssetPaths].sort()) {
    if (!isSafePackageAssetPath(assetPath)) {
      throw new Error(`Unsafe preview asset path: ${assetPath}`);
    }
    const remainingInlineAssetBytes = PREVIEW_MAX_INLINE_TOTAL_BYTES - totalInlineAssetBytes;
    const assetSnapshot = await readProjectFileSnapshot(project.projectPath, assetPath, {
      maxBytes: Math.min(PREVIEW_MAX_INLINE_ASSET_BYTES, remainingInlineAssetBytes),
      limitLabel: "Inline preview asset"
    });
    const assetBytes = assetSnapshot.bytes.byteLength;
    if (assetBytes > PREVIEW_MAX_INLINE_ASSET_BYTES) {
      throw new Error(
        `Preview asset ${assetPath} is ${assetBytes} bytes; the inline preview limit is ${PREVIEW_MAX_INLINE_ASSET_BYTES} bytes.`
      );
    }
    totalInlineAssetBytes += assetBytes;
    if (totalInlineAssetBytes > PREVIEW_MAX_INLINE_TOTAL_BYTES) {
      throw new Error(
        `Preview assets total ${totalInlineAssetBytes} bytes; the inline preview limit is ${PREVIEW_MAX_INLINE_TOTAL_BYTES} bytes.`
      );
    }
    sourceFingerprints.add(assetSnapshot.fingerprint);
    inlineAssetUrls.set(assetPath, toDataUrl(assetPath, assetSnapshot.bytes));
  }

  const inlinePreviewUrlSerializer = createProjectUrlSerializer({
    mode: "inline-preview",
    inlineAssetUrls
  });
  const previewThemeCss = project.themeCssPath
    ? rewriteCssUrls(project.themeCssPath, rawThemeCss, inlinePreviewUrlSerializer)
    : undefined;
  const previewSourceHtml = rewriteHtmlUrls(
    requestedSlide.sourcePath,
    sourceHtml,
    inlinePreviewUrlSerializer
  );
  const snapshotFingerprints = sourceFingerprints.sorted();

  const currentSourceFingerprints = await fingerprintProjectFiles(
    project.projectPath,
    snapshotFingerprints.map((entry) => entry.path)
  );
  const changedSources = changedFingerprintPaths(currentSourceFingerprints, snapshotFingerprints);
  if (changedSources.length > 0) {
    throw new Error(`Project sources changed during preview: ${changedSources.join(", ")}. Retry the preview.`);
  }

  const htmlDocument = buildRendererSlidePreviewDocument({
    title: project.title,
    language: project.language,
    viewport: project.viewport,
    safeArea: project.safeArea,
    themeCss: previewThemeCss,
    slide: {
      id: requestedSlide.id,
      title: requestedSlide.title,
      html: previewSourceHtml,
      notes
    }
  });
  if (!htmlDocument.includes(RENDERER_PREVIEW_CONTENT_SECURITY_POLICY)) {
    throw new Error("Renderer preview document is missing the required Content Security Policy.");
  }

  return {
    projectRoot: project.projectPath,
    slideId: requestedSlide.id,
    sourcePath: requestedSlide.sourcePath,
    title: requestedSlide.title,
    viewport: project.viewport,
    notes,
    htmlDocument,
    sourceDigest: fingerprintEntriesDigest(snapshotFingerprints)
  };
};

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

export const readPdfPageCount = async (input: string | Uint8Array): Promise<number> => {
  const bytes = typeof input === "string" ? await readFile(input) : input;
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
};

const renderBrowserArtifacts = async (
  project: CompilerProjectInput,
  prepared: PreparedProject,
  stagingRoot: string,
  thumbnailSize: ThumbnailSize,
  chromiumExecutablePath?: string
): Promise<BrowserRenderResult> => {
  const renderRoot = path.join(stagingRoot, "render-runtime");
  const htmlPath = path.join(renderRoot, PACKAGE_HTML_PATH);
  await mkdir(renderRoot);
  await writeFile(htmlPath, buildPrintHtml(prepared.packageRenderable));

  for (const asset of prepared.packageAssets) {
    const assetPath = path.resolve(renderRoot, ...asset.packagePath.split("/"));
    const relativePath = path.relative(renderRoot, assetPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Render asset path escapes the isolated workspace: ${asset.packagePath}`);
    }
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, asset.bytes);
  }

  return renderWithChromium({
    executablePath: chromiumExecutablePath,
    htmlPath,
    slideIds: prepared.slides.map((slide) => slide.id),
    thumbnailSize,
    title: project.title,
    viewport: project.viewport
  });
};

const writeThumbnails = async (
  project: CompilerProjectInput,
  prepared: PreparedProject,
  rendered: BrowserRenderResult,
  stagingExportsPath: string,
  finalExportsPath: string
): Promise<ThumbnailEntry[]> => {
  const stagingThumbnailsPath = path.join(stagingExportsPath, "thumbnails");
  const finalThumbnailsPath = path.join(finalExportsPath, "thumbnails");
  const cachePath = path.join(project.projectPath, ".htmlslide", "cache", "thumbnails");
  await mkdir(stagingThumbnailsPath, { recursive: true });

  const entries: ThumbnailEntry[] = [];
  for (const slide of prepared.slides) {
    const bytes = rendered.thumbnails.get(slide.id);
    if (!bytes) {
      throw new Error(`Chromium did not return a thumbnail for slide "${slide.id}".`);
    }
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
  thumbnailEntries: ThumbnailEntry[];
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
  const cacheProjectPath = ".htmlslide/cache/thumbnails";
  const cacheBackupPath = path.join(backupRoot, "thumbnail-cache");
  let cacheBackedUp = false;

  try {
    if (input.thumbnailEntries.length > 0) {
      const cachePath = await ensureSafeProjectDirectory(input.projectRoot, cacheProjectPath);
      await mkdir(path.dirname(cacheBackupPath), { recursive: true });
      await rename(cachePath, cacheBackupPath);
      cacheBackedUp = true;
      await writeThumbnailCache(input.projectRoot, input.thumbnailEntries);
    }
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
    const rollbackErrors: unknown[] = [];
    try {
      await rollbackExportCommit(input.projectRoot, committedArtifacts, backups, error);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (cacheBackedUp) {
      try {
        const cachePath = path.join(input.projectRoot, ...cacheProjectPath.split("/"));
        await rm(cachePath, { recursive: true, force: true });
        await rename(cacheBackupPath, cachePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Export commit failed and the previous artifact or thumbnail cache state could not be fully restored."
      );
    }
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
    thumbnailSize: options.thumbnailSize ?? DEFAULT_THUMBNAIL_SIZE,
    chromiumExecutablePath: options.chromiumExecutablePath
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

    const rendered = resolvedOptions.pdf || resolvedOptions.deckpkg || resolvedOptions.thumbnails
      ? await renderBrowserArtifacts(
          project,
          prepared,
          stagingRoot,
          resolvedOptions.thumbnailSize,
          resolvedOptions.chromiumExecutablePath
        )
      : undefined;

    let pdfBytes: Uint8Array | undefined;
    if (resolvedOptions.pdf || resolvedOptions.deckpkg) {
      if (!rendered) {
        throw new Error("Chromium rendering did not return the required PDF artifact.");
      }
      pdfBytes = rendered.pdf;
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
      if (!rendered) {
        throw new Error("Chromium rendering did not return the required thumbnail artifacts.");
      }
      thumbnailEntries = await writeThumbnails(
        project,
        prepared,
        rendered,
        stagingExportsPath,
        exportsPath
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
    await commitStagedExports({
      manifestJson,
      projectRoot: project.projectPath,
      sourceFingerprints: prepared.sourceFingerprints,
      stagedArtifacts,
      stagingManifestPath,
      thumbnailEntries
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
