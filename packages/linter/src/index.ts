import { access, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  changedFingerprintPaths,
  ExportManifestSchema,
  EXPORT_MANIFEST_PROJECT_PATH,
  fingerprintEntriesDigest,
  fingerprintProjectFile,
  fingerprintProjectFiles,
  MAX_EXPORT_MANIFEST_BYTES,
  readProjectFileSnapshot,
  sha256Hex,
  statusFromIssueSummary,
  summarizeIssues,
  tryLoadDeckProject,
  type ExportManifest,
  type HtmlslideIssue as CoreIssue,
  type IssueSeverity as CoreIssueSeverity,
  type IssueStatus,
  type LoadedDeckProject,
  type ResolvedProjectSlide
} from "@htmlslide/core";
import { CHECK_REPORT_SCHEMA_VERSION } from "@htmlslide/core/version";

export type IssueSeverity = CoreIssueSeverity;

export type MeasurementValue = number | string | boolean;

export type HtmlslideIssue = {
  slideId: string;
  severity: IssueSeverity;
  type: string;
  message: string;
  path?: string;
  selector?: string;
  measurement?: Record<string, MeasurementValue>;
  suggestedFix: string;
  agentInstruction: string;
};

export type CheckReportSummary = {
  errors: number;
  warnings: number;
  info: number;
  suggestions: number;
};

export type CheckReport = {
  schemaVersion?: typeof CHECK_REPORT_SCHEMA_VERSION;
  status: IssueStatus;
  projectPath: string;
  summary: CheckReportSummary;
  issues: HtmlslideIssue[];
};

export type LintSlideInput = {
  id: string;
  title: string;
  sourcePath: string;
  notesPath?: string;
  durationSec?: number;
};

export type LintProjectInput = {
  projectPath: string;
  slides?: LintSlideInput[];
  writeReport?: boolean;
  reportFileName?: string;
};

type NormalizedLintInput = LintProjectInput & {
  projectPath: string;
};

type SlideCheckContext = {
  index: number;
  id: string;
  title: string;
  sourcePath: string;
  sourceProjectPath: string;
  notesPath?: string;
  notesProjectPath?: string;
  durationSec?: number;
};

type ResourceReference = {
  url: string;
  selector: string;
  kind: "attribute" | "css-import" | "css-url";
  attribute?: string;
  rel?: string;
  tag?: string;
};

type ResourceCheckResult = {
  issues: HtmlslideIssue[];
  assetPaths: string[];
};

type SlideLayoutContext = {
  viewport: {
    width: number;
    height: number;
  };
  safeArea: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

type ElementBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

type SafeAreaViolationFinding = {
  selector: string;
  bounds: ElementBounds;
  overflowTopPx: number;
  overflowRightPx: number;
  overflowBottomPx: number;
  overflowLeftPx: number;
};

type TextOverflowFinding = {
  selector: string;
  overflowBottomPx: number;
  source: "declared" | "estimated";
  containerHeightPx?: number;
  estimatedContentHeightPx?: number;
};

type RgbColor = {
  red: number;
  green: number;
  blue: number;
  source: string;
};

type ContrastFinding = {
  selector: string;
  foreground: string;
  background: string;
  contrastRatio: number;
  minContrastRatio: number;
};

type ExportExpectation = {
  artifactPath: string;
  artifactProjectPath: string;
  artifactKind: "deckpkg" | "html" | "notes" | "pdf" | "thumbnail";
  slideId: string;
};

type ExportManifestLoadResult =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; manifest: ExportManifest; rawSha256: string };

const REPORT_SCHEMA_VERSION = CHECK_REPORT_SCHEMA_VERSION;
const DEFAULT_REPORT_FILE_NAMES = ["report.json", "check-report.json"] as const;
const TITLE_MAX_CHARACTERS = 72;
const BODY_MAX_WORDS = 120;
const BODY_MAX_CHARACTERS = 850;
const NOTES_MIN_WORDS = 12;
const MIN_TEXT_CONTRAST_RATIO = 4.5;
const DEFAULT_DECLARED_OVERFLOW_BOTTOM_PX = 1;
const DEFAULT_TEXT_CONTAINER_WIDTH_PX = 960;
const DEFAULT_TEXT_FONT_SIZE_PX = 28;
const DEFAULT_LINE_HEIGHT_RATIO = 1.25;
const EXPORT_MTIME_TOLERANCE_MS = 1000;
const DECLARED_TEXT_OVERFLOW_VALUES = new Set(["1", "true", "text", "content"]);
const OVERFLOW_BOTTOM_ATTRIBUTE_NAMES = ["data-htmlslide-overflow-bottom-px", "data-overflow-bottom-px"];
const TEXT_CONTAINER_TAGS = new Set(["article", "blockquote", "div", "figcaption", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "section", "span"]);
const TEXT_OVERFLOW_CLIPPING_VALUES = new Set(["auto", "clip", "hidden", "scroll"]);

const ASSET_EXTENSION_PATTERN =
  /\.(avif|bmp|csv|gif|ico|jpe?g|json|mp3|mp4|ogg|otf|pdf|png|svg|ttf|wav|webm|webp|woff2?)$/i;
const FONT_EXTENSION_PATTERN = /\.(eot|otf|ttf|woff2?)$/i;
const REMOTE_URL_PATTERN = /^https?:\/\//i;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const CJK_CHARACTER_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const LATIN_WORD_PATTERN = /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g;
const CSS_NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255]
};

const normalizeInput = (project: LintProjectInput | string): NormalizedLintInput =>
  typeof project === "string" ? { projectPath: project } : project;

const makeIssue = (issue: HtmlslideIssue): HtmlslideIssue => ({
  ...issue,
  measurement: issue.measurement ?? {}
});

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const statIfExists = async (filePath: string) => {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
};

export const checkProject = async (project: LintProjectInput | string): Promise<CheckReport> => {
  const input = normalizeInput(project);
  const loaded = await tryLoadDeckProject(input.projectPath, { verifyFiles: false });

  if (loaded.ok) {
    return checkLoadedDeckProject(loaded.project, input);
  }

  if (loaded.error.code === "PROJECT_NOT_FOUND" && input.slides && input.slides.length > 0) {
    return checkManualProject(input);
  }

  const issues = normalizeCoreIssues(
    loaded.issues.length > 0
      ? loaded.issues
      : [
          {
            severity: "error",
            type: "project-load-error",
            message: loaded.error.message,
            suggestedFix: "Run the checker from a deck project or pass a path containing deck.json."
          }
        ],
    path.resolve(input.projectPath)
  );
  const report = buildReport(path.resolve(input.projectPath), sortIssues(issues));
  await writeReportIfRequested(report, input);
  return report;
};

const checkLoadedDeckProject = async (
  project: LoadedDeckProject,
  input: NormalizedLintInput
): Promise<CheckReport> => {
  const slideOrder = buildSlideOrder(project.slides);
  const coreFileIssues = await collectCoreProjectFileIssues(project);
  const missingProjectPaths = new Set(coreFileIssues.map((issue) => issue.path).filter(isPresent));
  const issues: HtmlslideIssue[] = normalizeCoreIssues(coreFileIssues, project.projectRoot);
  const localAssetPaths = new Set<string>();
  const layout = {
    viewport: project.deck.viewport,
    safeArea: project.deck.safeArea
  };

  for (const slide of project.slides) {
    const context = slideContextFromCoreSlide(slide);
    const slideResult = await checkSlide(project.projectRoot, context, missingProjectPaths, layout);
    issues.push(...slideResult.issues);
    slideResult.assetPaths.forEach((assetPath) => localAssetPaths.add(assetPath));
  }

  if (project.theme?.cssPath && !missingProjectPaths.has(project.deck.theme?.css ?? "")) {
    const themeCss = await readFileIfExists(project.theme.cssPath);
    if (themeCss !== undefined) {
      const themeResult = await checkResourceReferences({
        content: themeCss,
        projectRoot: project.projectRoot,
        sourcePath: project.theme.cssPath,
        sourceProjectPath: project.deck.theme?.css ?? "theme css",
        slideId: "deck"
      });
      issues.push(...themeResult.issues);
      themeResult.assetPaths.forEach((assetPath) => localAssetPaths.add(assetPath));
    }
  }

  issues.push(...(await checkExports(project, [...localAssetPaths])));

  const report = buildReport(project.projectRoot, sortIssues(issues, slideOrder));
  await writeReportIfRequested(report, input);
  return report;
};

const checkManualProject = async (input: NormalizedLintInput): Promise<CheckReport> => {
  const projectRoot = path.resolve(input.projectPath);
  const slideOrder = buildManualSlideOrder(input.slides ?? []);
  const issues: HtmlslideIssue[] = [];

  for (const slide of input.slides ?? []) {
    const context = slideContextFromManualSlide(projectRoot, slideOrder.get(slide.id) ?? 0, slide);
    const slideResult = await checkSlide(projectRoot, context, new Set());
    issues.push(...slideResult.issues);
  }

  const report = buildReport(projectRoot, sortIssues(issues, slideOrder));
  await writeReportIfRequested(report, input);
  return report;
};

const collectCoreProjectFileIssues = async (project: LoadedDeckProject): Promise<CoreIssue[]> => {
  const verified = await tryLoadDeckProject(project.projectRoot, { verifyFiles: true });
  if (verified.ok) {
    return [];
  }

  if (verified.issues.length > 0) {
    return verified.issues;
  }

  return [
    {
      severity: "error",
      type: "project-load-error",
      message: verified.error.message,
      suggestedFix: "Fix deck.json and referenced project files, then rerun the checker."
    }
  ];
};

const checkSlide = async (
  projectRoot: string,
  slide: SlideCheckContext,
  missingProjectPaths: ReadonlySet<string>,
  layout?: SlideLayoutContext
): Promise<ResourceCheckResult> => {
  const issues: HtmlslideIssue[] = [];
  const assetPaths: string[] = [];

  issues.push(...checkTitleLength(slide));

  if (!(await pathExists(slide.sourcePath))) {
    if (!missingProjectPaths.has(slide.sourceProjectPath)) {
      issues.push(
        makeIssue({
          slideId: slide.id,
          severity: "error",
          type: "missing-file",
          path: slide.sourceProjectPath,
          message: `Missing slide source: ${slide.sourceProjectPath}.`,
          measurement: { path: slide.sourceProjectPath },
          suggestedFix: `Create ${slide.sourceProjectPath} or update deck.json to point at an existing project file.`,
          agentInstruction: `Create the missing slide HTML for ${slide.id}, or update deck.json to use the correct source path.`
        })
      );
    }
    issues.push(...(await checkNotes(projectRoot, slide, missingProjectPaths)));
    return { issues, assetPaths };
  }

  const html = await readFile(slide.sourcePath, "utf8");
  issues.push(...checkSlideId(slide, html));
  if (layout) {
    issues.push(...checkSafeArea(slide, html, layout));
  }
  issues.push(...checkTextOverflow(slide, html));
  issues.push(...checkTextContrast(slide, html));
  issues.push(...checkBodyDensity(slide, html));

  const resourceResult = await checkResourceReferences({
    content: html,
    projectRoot,
    sourcePath: slide.sourcePath,
    sourceProjectPath: slide.sourceProjectPath,
    slideId: slide.id
  });
  issues.push(...resourceResult.issues);
  assetPaths.push(...resourceResult.assetPaths);

  issues.push(...(await checkNotes(projectRoot, slide, missingProjectPaths)));

  return { issues, assetPaths };
};

const checkTitleLength = (slide: SlideCheckContext): HtmlslideIssue[] => {
  if (slide.title.length <= TITLE_MAX_CHARACTERS) {
    return [];
  }

  return [
    makeIssue({
      slideId: slide.id,
      severity: "warning",
      type: "title-too-long",
      path: slide.sourceProjectPath,
      selector: "deck.json slides[].title",
      message: `Slide title has ${slide.title.length} characters; keep titles at or below ${TITLE_MAX_CHARACTERS}.`,
      measurement: {
        titleLength: slide.title.length,
        maxTitleLength: TITLE_MAX_CHARACTERS
      },
      suggestedFix: "Shorten the title or split the claim across title and body text.",
      agentInstruction: `Rewrite the deck.json title for slide ${slide.id} to ${TITLE_MAX_CHARACTERS} characters or fewer while preserving the main claim.`
    })
  ];
};

const checkSlideId = (slide: SlideCheckContext, html: string): HtmlslideIssue[] => {
  const slideIdMatch = html.match(/\bdata-slide-id\s*=\s*["']([^"']+)["']/i);

  if (!slideIdMatch) {
    return [
      makeIssue({
        slideId: slide.id,
        severity: "error",
        type: "slide-id-mismatch",
        path: slide.sourceProjectPath,
        selector: "[data-slide-id]",
        message: "Slide fragment is missing data-slide-id.",
        measurement: {
          expectedSlideId: slide.id,
          actualSlideId: ""
        },
        suggestedFix: "Add data-slide-id to the root slide element.",
        agentInstruction: `Add data-slide-id="${slide.id}" to the root slide element in ${slide.sourceProjectPath}.`
      })
    ];
  }

  const actualSlideId = slideIdMatch[1] ?? "";
  if (actualSlideId === slide.id) {
    return [];
  }

  return [
    makeIssue({
      slideId: slide.id,
      severity: "error",
      type: "slide-id-mismatch",
      path: slide.sourceProjectPath,
      selector: "[data-slide-id]",
      message: `data-slide-id is "${actualSlideId}", expected "${slide.id}".`,
      measurement: {
        expectedSlideId: slide.id,
        actualSlideId
      },
      suggestedFix: "Keep deck.json slide ids and slide source data-slide-id values identical.",
      agentInstruction: `Change the root slide data-slide-id in ${slide.sourceProjectPath} to "${slide.id}" without changing deck.json.`
    })
  ];
};

const checkSafeArea = (slide: SlideCheckContext, html: string, layout: SlideLayoutContext): HtmlslideIssue[] =>
  extractSafeAreaViolations(html, layout).map((violation) => {
    const maxOverflowPx = Math.max(
      violation.overflowTopPx,
      violation.overflowRightPx,
      violation.overflowBottomPx,
      violation.overflowLeftPx
    );

    return makeIssue({
      slideId: slide.id,
      severity: "error",
      type: "safe-area-violation",
      path: slide.sourceProjectPath,
      selector: violation.selector,
      message: `Element exceeds slide safe area by ${maxOverflowPx}px.`,
      measurement: {
        overflowTopPx: violation.overflowTopPx,
        overflowRightPx: violation.overflowRightPx,
        overflowBottomPx: violation.overflowBottomPx,
        overflowLeftPx: violation.overflowLeftPx,
        x: violation.bounds.x,
        y: violation.bounds.y,
        width: violation.bounds.width,
        height: violation.bounds.height,
        safeTop: layout.safeArea.top,
        safeRight: layout.viewport.width - layout.safeArea.right,
        safeBottom: layout.viewport.height - layout.safeArea.bottom,
        safeLeft: layout.safeArea.left
      },
      suggestedFix: "Move or resize the element so it remains inside the slide safe area.",
      agentInstruction: `Fix ${violation.selector} in ${slide.sourceProjectPath} for slide ${slide.id}. Keep content within the safe area bounds before changing the deck safeArea.`
    });
  });

const checkTextOverflow = (slide: SlideCheckContext, html: string): HtmlslideIssue[] =>
  extractTextOverflows(html).map((overflow) =>
    makeIssue({
      slideId: slide.id,
      severity: "error",
      type: "text-overflow",
      path: slide.sourceProjectPath,
      selector: overflow.selector,
      message:
        overflow.source === "declared"
          ? `Text exceeds slide safe area by ${overflow.overflowBottomPx}px at bottom.`
          : `Text is estimated to exceed its fixed container by ${overflow.overflowBottomPx}px.`,
      measurement: {
        overflowBottomPx: overflow.overflowBottomPx,
        source: overflow.source,
        ...(overflow.containerHeightPx !== undefined ? { containerHeightPx: overflow.containerHeightPx } : {}),
        ...(overflow.estimatedContentHeightPx !== undefined
          ? { estimatedContentHeightPx: overflow.estimatedContentHeightPx }
          : {})
      },
      suggestedFix: "Shorten body copy, split the content across slides, or move the text into speaker notes.",
      agentInstruction: `Fix ${overflow.selector} in ${slide.sourceProjectPath} for slide ${slide.id}. Keep the fixed viewport layout and prefer shortening or splitting content before reducing font size.`
    })
  );

const checkTextContrast = (slide: SlideCheckContext, html: string): HtmlslideIssue[] =>
  extractLowContrastText(html).map((contrast) =>
    makeIssue({
      slideId: slide.id,
      severity: "warning",
      type: "low-contrast",
      path: slide.sourceProjectPath,
      selector: contrast.selector,
      message: `Text contrast ratio ${formatContrastRatio(contrast.contrastRatio)} is below ${contrast.minContrastRatio}.`,
      measurement: {
        contrastRatio: roundContrastRatio(contrast.contrastRatio),
        minContrastRatio: contrast.minContrastRatio,
        foreground: contrast.foreground,
        background: contrast.background
      },
      suggestedFix: "Increase the foreground/background contrast until the text meets WCAG AA contrast.",
      agentInstruction: `Adjust ${contrast.selector} in ${slide.sourceProjectPath} for slide ${slide.id} so text contrast is at least ${contrast.minContrastRatio}:1.`
    })
  );

const checkBodyDensity = (slide: SlideCheckContext, html: string): HtmlslideIssue[] => {
  const text = htmlToText(html);
  const wordCount = countWords(text);
  const characterCount = text.length;

  if (wordCount <= BODY_MAX_WORDS && characterCount <= BODY_MAX_CHARACTERS) {
    return [];
  }

  return [
    makeIssue({
      slideId: slide.id,
      severity: "warning",
      type: "body-too-dense",
      path: slide.sourceProjectPath,
      selector: ".slide",
      message: `Slide body is dense: ${wordCount} words and ${characterCount} characters.`,
      measurement: {
        wordCount,
        maxWords: BODY_MAX_WORDS,
        characterCount,
        maxCharacters: BODY_MAX_CHARACTERS
      },
      suggestedFix: "Split the content across multiple slides or reduce body copy.",
      agentInstruction: `Reduce the visible copy in ${slide.sourceProjectPath} below ${BODY_MAX_WORDS} words and ${BODY_MAX_CHARACTERS} characters, or split it into multiple slides.`
    })
  ];
};

const checkNotes = async (
  projectRoot: string,
  slide: SlideCheckContext,
  missingProjectPaths: ReadonlySet<string>
): Promise<HtmlslideIssue[]> => {
  if (!slide.notesPath || !slide.notesProjectPath) {
    return [
      makeIssue({
        slideId: slide.id,
        severity: "warning",
        type: "missing-notes",
        path: "deck.json",
        selector: "slides[].notes",
        message: "Slide has no speaker notes file.",
        measurement: { minWords: NOTES_MIN_WORDS },
        suggestedFix: "Add a project-local Markdown notes file and reference it from deck.json.",
        agentInstruction: `Create speaker notes for slide ${slide.id} under notes/ and add the notes path to deck.json.`
      })
    ];
  }

  if (!(await pathExists(slide.notesPath))) {
    if (missingProjectPaths.has(slide.notesProjectPath)) {
      return [];
    }

    return [
      makeIssue({
        slideId: slide.id,
        severity: "warning",
        type: "missing-notes",
        path: slide.notesProjectPath,
        message: `Speaker notes file is missing: ${slide.notesProjectPath}.`,
        measurement: { path: slide.notesProjectPath, minWords: NOTES_MIN_WORDS },
        suggestedFix: "Create the missing notes Markdown file.",
        agentInstruction: `Create ${slide.notesProjectPath} with concise speaker notes for slide ${slide.id}.`
      })
    ];
  }

  const notes = await readFile(path.resolve(projectRoot, slide.notesPath), "utf8");
  const notesText = markdownToText(notes);
  const wordCount = countWords(notesText);

  if (wordCount >= NOTES_MIN_WORDS) {
    return [];
  }

  return [
    makeIssue({
      slideId: slide.id,
      severity: "warning",
      type: "notes-too-short",
      path: slide.notesProjectPath,
      message: `Speaker notes are short: ${wordCount} words.`,
      measurement: {
        wordCount,
        minWords: NOTES_MIN_WORDS
      },
      suggestedFix: "Expand the notes with the slide's talk track and timing guidance.",
      agentInstruction: `Expand ${slide.notesProjectPath} to at least ${NOTES_MIN_WORDS} useful words for slide ${slide.id}.`
    })
  ];
};

const checkResourceReferences = async (input: {
  content: string;
  projectRoot: string;
  sourcePath: string;
  sourceProjectPath: string;
  slideId: string;
}): Promise<ResourceCheckResult> => {
  const issues: HtmlslideIssue[] = [];
  const assetPaths: string[] = [];
  const seenIssues = new Set<string>();

  for (const reference of extractResourceReferences(input.content)) {
    const url = decodeHtmlEntities(reference.url.trim());
    if (isIgnorableUrl(url)) {
      continue;
    }

    if (REMOTE_URL_PATTERN.test(url)) {
      if (!isRemoteReferenceCheckable(reference, url)) {
        continue;
      }

      const issueType = remoteIssueType(reference, url);
      const issueKey = [input.slideId, input.sourceProjectPath, issueType, url].join("\u0000");
      if (seenIssues.has(issueKey)) {
        continue;
      }
      seenIssues.add(issueKey);

      issues.push(remoteResourceIssue(input.slideId, input.sourceProjectPath, reference, url, issueType));
      continue;
    }

    if (!isLocalAssetReference(reference, url)) {
      continue;
    }

    const cleanUrl = stripUrlFragmentAndQuery(url);
    const resolvedAssetPath = await findExistingLocalAsset(input.projectRoot, input.sourcePath, cleanUrl);
    if (resolvedAssetPath) {
      assetPaths.push(resolvedAssetPath);
      continue;
    }

    const issueKey = [input.slideId, input.sourceProjectPath, "missing-asset", cleanUrl].join("\u0000");
    if (seenIssues.has(issueKey)) {
      continue;
    }
    seenIssues.add(issueKey);

    issues.push(
      makeIssue({
        slideId: input.slideId,
        severity: "error",
        type: "missing-asset",
        path: input.sourceProjectPath,
        selector: reference.selector,
        message: `Referenced asset is missing: ${cleanUrl}.`,
        measurement: {
          url: cleanUrl,
          source: input.sourceProjectPath
        },
        suggestedFix: "Add the asset to the project or update the reference to an existing local file.",
        agentInstruction: `Add ${cleanUrl} to the project or update the reference in ${input.sourceProjectPath} to point at an existing local asset.`
      })
    );
  }

  return { issues, assetPaths };
};

const remoteResourceIssue = (
  slideId: string,
  sourceProjectPath: string,
  reference: ResourceReference,
  url: string,
  issueType: "remote-asset" | "remote-font" | "remote-script"
): HtmlslideIssue => {
  if (issueType === "remote-script") {
    return makeIssue({
      slideId,
      severity: "error",
      type: issueType,
      path: sourceProjectPath,
      selector: reference.selector,
      message: `Remote script is not allowed in local-first decks: ${url}.`,
      measurement: { url },
      suggestedFix: "Bundle required behavior locally or remove the script dependency.",
      agentInstruction: `Remove the remote script reference from ${sourceProjectPath}; if behavior is required, replace it with local project code.`
    });
  }

  if (issueType === "remote-font") {
    return makeIssue({
      slideId,
      severity: "warning",
      type: issueType,
      path: sourceProjectPath,
      selector: reference.selector,
      message: `Remote font reference may fail offline: ${url}.`,
      measurement: { url },
      suggestedFix: "Bundle fonts locally or use system fonts.",
      agentInstruction: `Replace the remote font reference in ${sourceProjectPath} with a local font asset or a system font stack.`
    });
  }

  return makeIssue({
    slideId,
    severity: "warning",
    type: issueType,
    path: sourceProjectPath,
    selector: reference.selector,
    message: `Remote asset may fail offline: ${url}.`,
    measurement: { url },
    suggestedFix: "Move the asset into the project assets folder and reference it locally.",
    agentInstruction: `Download or otherwise provide the asset legally, place it under assets/, and update ${sourceProjectPath} to use the local path.`
  });
};

const checkExports = async (project: LoadedDeckProject, localAssetPaths: string[]): Promise<HtmlslideIssue[]> => {
  const expectations = exportExpectations(project);
  let observedValidManifest = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifestState = await loadExportManifest(project.projectRoot);
    if (manifestState.status === "missing") {
      if (observedValidManifest) {
        return [
          exportManifestIssue(
            "export-integrity-unverified",
            "Compiler export metadata disappeared while artifacts were being verified.",
            "A valid manifest was observed earlier in the same verification attempt.",
            "error"
          )
        ];
      }
      return expectations.length === 0 ? [] : checkLegacyExports(project, localAssetPaths, expectations);
    }
    if (manifestState.status === "invalid") {
      return [
        exportManifestIssue(
          "export-manifest-invalid",
          `Compiler export metadata is invalid: ${manifestState.reason}`,
          manifestState.reason,
          "error"
        ),
        ...(await checkExpectedArtifactPresence(expectations))
      ];
    }

    observedValidManifest = true;
    const issues = await checkManifestExports(project.projectRoot, expectations, manifestState.manifest);
    const finalManifestState = await loadExportManifest(project.projectRoot);
    if (
      finalManifestState.status === "valid" &&
      finalManifestState.rawSha256 === manifestState.rawSha256
    ) {
      return issues;
    }
  }

  return [
    exportManifestIssue(
      "export-integrity-unverified",
      "Compiler export metadata changed while artifacts were being verified.",
      "The manifest did not remain stable across two verification attempts.",
      "error"
    )
  ];
};

const checkManifestExports = async (
  projectRoot: string,
  expectations: readonly ExportExpectation[],
  manifest: ExportManifest
): Promise<HtmlslideIssue[]> => {
  const issues: HtmlslideIssue[] = [];
  let sourceComparison: { changedPaths: string[]; currentDigest: string; outdated: boolean } | undefined;

  try {
    const currentSources = await fingerprintProjectFiles(
      projectRoot,
      manifest.sources.map((entry) => entry.path)
    );
    const currentDigest = fingerprintEntriesDigest(currentSources);
    sourceComparison = {
      changedPaths: changedFingerprintPaths(currentSources, manifest.sources),
      currentDigest,
      outdated: currentDigest !== manifest.sourceDigest
    };
  } catch (error) {
    issues.push(
      exportManifestIssue(
        "export-integrity-unverified",
        "Deck sources could not be verified against compiler export metadata.",
        errorMessage(error),
        "error"
      )
    );
  }

  const manifestArtifacts = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of manifest.artifacts) {
    const inspectedArtifact = await inspectExportPath(path.join(projectRoot, ...artifact.path.split("/")));
    if (inspectedArtifact.error) {
      issues.push(exportIntegrityIssue(artifact.path, artifact.slideId ?? "deck", inspectedArtifact.error));
      continue;
    }
    const artifactInfo = inspectedArtifact.info;
    if (!artifactInfo) {
      issues.push(exportMissingIssue({
        artifactPath: path.join(projectRoot, ...artifact.path.split("/")),
        artifactProjectPath: artifact.path,
        artifactKind: artifact.kind,
        slideId: artifact.slideId ?? "deck"
      }));
      continue;
    }
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile()) {
      issues.push(exportIntegrityIssue(
        artifact.path,
        artifact.slideId ?? "deck",
        `${artifact.kind} export is not a regular project-local file.`
      ));
      continue;
    }

    try {
      const actualArtifact = await fingerprintProjectFile(projectRoot, artifact.path);
      if (actualArtifact.sha256 !== artifact.sha256 || actualArtifact.sizeBytes !== artifact.sizeBytes) {
        issues.push(
          makeIssue({
            slideId: artifact.slideId ?? "deck",
            severity: "warning",
            type: "export-modified",
            path: artifact.path,
            message: `${artifact.kind} export bytes do not match compiler metadata.`,
            measurement: {
              actualSha256: actualArtifact.sha256,
              actualSizeBytes: actualArtifact.sizeBytes,
              artifactKind: artifact.kind,
              recordedSha256: artifact.sha256,
              recordedSizeBytes: artifact.sizeBytes
            },
            suggestedFix: "Regenerate exports instead of editing compiler-owned artifacts.",
            agentInstruction: `Run htmlslide export to replace the modified ${artifact.path}.`
          })
        );
      }
    } catch (error) {
      issues.push(exportIntegrityIssue(artifact.path, artifact.slideId ?? "deck", errorMessage(error)));
    }

    if (sourceComparison?.outdated) {
      issues.push(
        makeIssue({
          slideId: artifact.slideId ?? "deck",
          severity: "warning",
          type: "export-outdated",
          path: artifact.path,
          message: `${artifact.kind} export was generated from different deck source bytes.`,
          measurement: {
            artifactKind: artifact.kind,
            changedSourceCount: sourceComparison.changedPaths.length,
            currentSourceDigest: sourceComparison.currentDigest,
            firstChangedSourcePath: sourceComparison.changedPaths[0] ?? "unknown",
            recordedSourceDigest: manifest.sourceDigest
          },
          suggestedFix: "Regenerate exports after source changes.",
          agentInstruction: `Run htmlslide export to refresh ${artifact.path} after the source edits.`
        })
      );
    }
  }

  for (const expectation of expectations) {
    const inspectedArtifact = await inspectExportPath(expectation.artifactPath);
    if (inspectedArtifact.error) {
      if (!manifestArtifacts.has(expectation.artifactProjectPath)) {
        issues.push(exportIntegrityIssue(
          expectation.artifactProjectPath,
          expectation.slideId,
          inspectedArtifact.error
        ));
      }
      continue;
    }
    const artifactInfo = inspectedArtifact.info;
    if (!artifactInfo) {
      if (!manifestArtifacts.has(expectation.artifactProjectPath)) {
        issues.push(exportMissingIssue(expectation));
      }
      continue;
    }
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile()) {
      if (!manifestArtifacts.has(expectation.artifactProjectPath)) {
        issues.push(exportIntegrityIssue(
          expectation.artifactProjectPath,
          expectation.slideId,
          `${expectation.artifactKind} export is not a regular project-local file.`
        ));
      }
      continue;
    }

    const manifestArtifact = manifestArtifacts.get(expectation.artifactProjectPath);
    const expectedSlideId = expectation.artifactKind === "thumbnail" ? expectation.slideId : undefined;

    if (!manifestArtifact) {
      issues.push(
        makeIssue({
          slideId: expectation.slideId,
          severity: "warning",
          type: "export-untracked",
          path: expectation.artifactProjectPath,
          message: `${expectation.artifactKind} export is not recorded in ${EXPORT_MANIFEST_PROJECT_PATH}.`,
          measurement: {
            artifactKind: expectation.artifactKind,
            artifactPath: expectation.artifactProjectPath,
            manifestPath: EXPORT_MANIFEST_PROJECT_PATH
          },
          suggestedFix: "Regenerate the requested exports so the compiler records their fingerprints.",
          agentInstruction: `Run htmlslide export to regenerate ${expectation.artifactProjectPath} and ${EXPORT_MANIFEST_PROJECT_PATH}.`
        })
      );
    } else if (manifestArtifact.kind !== expectation.artifactKind || manifestArtifact.slideId !== expectedSlideId) {
      issues.push(
        makeIssue({
          slideId: expectation.slideId,
          severity: "warning",
          type: "export-manifest-mismatch",
          path: expectation.artifactProjectPath,
          message: `${expectation.artifactKind} export metadata does not match the expected artifact contract.`,
          measurement: {
            actualArtifactKind: manifestArtifact.kind,
            actualSlideId: manifestArtifact.slideId ?? "deck",
            expectedArtifactKind: expectation.artifactKind,
            expectedSlideId: expectedSlideId ?? "deck"
          },
          suggestedFix: "Regenerate exports with the current HTMLslide compiler.",
          agentInstruction: `Run htmlslide export to rebuild ${expectation.artifactProjectPath} with matching metadata.`
        })
      );
    }

  }

  return issues;
};

const checkLegacyExports = async (
  project: LoadedDeckProject,
  localAssetPaths: string[],
  expectations: readonly ExportExpectation[]
): Promise<HtmlslideIssue[]> => {
  const issues = [exportManifestIssue("export-manifest-missing", "Compiler export metadata is missing.")];
  const sourceMtimeMs = await newestSourceMtime(project, localAssetPaths);
  for (const expectation of expectations) {
    const inspectedArtifact = await inspectExportPath(expectation.artifactPath);
    if (inspectedArtifact.error) {
      issues.push(exportIntegrityIssue(
        expectation.artifactProjectPath,
        expectation.slideId,
        inspectedArtifact.error
      ));
      continue;
    }
    const artifactInfo = inspectedArtifact.info;
    if (!artifactInfo) {
      issues.push(exportMissingIssue(expectation));
      continue;
    }
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile()) {
      issues.push(exportIntegrityIssue(
        expectation.artifactProjectPath,
        expectation.slideId,
        `${expectation.artifactKind} export is not a regular project-local file.`
      ));
      continue;
    }
    if (sourceMtimeMs > Number(artifactInfo.mtimeMs) + EXPORT_MTIME_TOLERANCE_MS) {
      issues.push(
        makeIssue({
          slideId: expectation.slideId,
          severity: "warning",
          type: "export-outdated",
          path: expectation.artifactProjectPath,
          message: `${expectation.artifactKind} export is older than deck sources: ${expectation.artifactProjectPath}.`,
          measurement: {
            artifactKind: expectation.artifactKind,
            artifactMtimeMs: Math.floor(Number(artifactInfo.mtimeMs)),
            newestSourceMtimeMs: Math.floor(sourceMtimeMs)
          },
          suggestedFix: "Regenerate exports after source changes.",
          agentInstruction: `Run htmlslide export to refresh ${expectation.artifactProjectPath} after the source edits.`
        })
      );
    }
  }
  return issues;
};

const checkExpectedArtifactPresence = async (
  expectations: readonly ExportExpectation[]
): Promise<HtmlslideIssue[]> => {
  const issues: HtmlslideIssue[] = [];
  for (const expectation of expectations) {
    const inspectedArtifact = await inspectExportPath(expectation.artifactPath);
    if (inspectedArtifact.error) {
      issues.push(exportIntegrityIssue(
        expectation.artifactProjectPath,
        expectation.slideId,
        inspectedArtifact.error
      ));
      continue;
    }
    const info = inspectedArtifact.info;
    if (!info) {
      issues.push(exportMissingIssue(expectation));
    } else if (info.isSymbolicLink() || !info.isFile()) {
      issues.push(exportIntegrityIssue(
        expectation.artifactProjectPath,
        expectation.slideId,
        `${expectation.artifactKind} export is not a regular project-local file.`
      ));
    }
  }
  return issues;
};

const exportMissingIssue = (expectation: ExportExpectation): HtmlslideIssue =>
  makeIssue({
    slideId: expectation.slideId,
    severity: "warning",
    type: "export-missing",
    path: expectation.artifactProjectPath,
    message: `Expected ${expectation.artifactKind} export is missing: ${expectation.artifactProjectPath}.`,
    measurement: {
      artifactKind: expectation.artifactKind,
      artifactPath: expectation.artifactProjectPath
    },
    suggestedFix: "Run htmlslide export for the requested artifact type.",
    agentInstruction: `Run htmlslide export for this project so ${expectation.artifactProjectPath} is regenerated.`
  });

const exportIntegrityIssue = (artifactPath: string, slideId: string, reason: string): HtmlslideIssue =>
  makeIssue({
    slideId,
    severity: "error",
    type: "export-integrity-unverified",
    path: artifactPath,
    message: `Export integrity could not be verified: ${reason}`,
    measurement: { artifactPath, reason },
    suggestedFix: "Remove unsafe export paths and regenerate exports with the current compiler.",
    agentInstruction: `Inspect ${artifactPath}, remove any symlink or non-file destination, then run htmlslide export again.`
  });

const loadExportManifest = async (projectRoot: string): Promise<ExportManifestLoadResult> => {
  const manifestPath = path.join(projectRoot, ...EXPORT_MANIFEST_PROJECT_PATH.split("/"));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(manifestPath);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: errorMessage(error) };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { status: "invalid", reason: "Export manifest must be a regular project-local file." };
  }
  if (Number(info.size) > MAX_EXPORT_MANIFEST_BYTES) {
    return { status: "invalid", reason: `Export manifest exceeds ${MAX_EXPORT_MANIFEST_BYTES} bytes.` };
  }

  let rawManifest: string;
  try {
    rawManifest = (await readProjectFileSnapshot(projectRoot, EXPORT_MANIFEST_PROJECT_PATH)).bytes.toString("utf8");
  } catch (error) {
    return { status: "invalid", reason: errorMessage(error) };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawManifest);
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : "Unable to parse export manifest JSON."
    };
  }

  const parsed = ExportManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: parsed.error.issues[0]?.message ?? "Export manifest schema validation failed."
    };
  }
  return { status: "valid", manifest: parsed.data, rawSha256: sha256Hex(rawManifest) };
};

const exportManifestIssue = (
  type: string,
  message: string,
  reason?: string,
  severity: IssueSeverity = "warning"
): HtmlslideIssue =>
  makeIssue({
    slideId: "deck",
    severity,
    type,
    path: EXPORT_MANIFEST_PROJECT_PATH,
    message,
    measurement: {
      manifestPath: EXPORT_MANIFEST_PROJECT_PATH,
      ...(reason ? { reason } : {})
    },
    suggestedFix: "Run htmlslide export to create fresh compiler-owned artifact metadata.",
    agentInstruction: `Run htmlslide export to regenerate ${EXPORT_MANIFEST_PROJECT_PATH}.`
  });

const normalizeCoreIssues = (issues: readonly CoreIssue[], projectPath: string): HtmlslideIssue[] =>
  issues.map((issue) =>
    makeIssue({
      slideId: issue.slideId ?? "deck",
      severity: issue.severity,
      type: issue.type,
      path: issue.path,
      selector: issue.selector,
      message: issue.message,
      measurement: coreIssueMeasurement(issue),
      suggestedFix: issue.suggestedFix ?? suggestedFixForCoreIssue(issue),
      agentInstruction: agentInstructionForCoreIssue(issue, projectPath)
    })
  );

const coreIssueMeasurement = (issue: CoreIssue): Record<string, MeasurementValue> => {
  const measurement: Record<string, MeasurementValue> = {};
  if (issue.path) {
    measurement.path = issue.path;
  }
  if (issue.slideId) {
    measurement.slideId = issue.slideId;
  }
  return measurement;
};

const suggestedFixForCoreIssue = (issue: CoreIssue): string => {
  if (issue.type === "schema-validation") {
    return "Update deck.json so it conforms to the HTMLslide deck schema.";
  }
  if (issue.type === "missing-file" && issue.path) {
    return `Create ${issue.path} or update deck.json to point at an existing project file.`;
  }
  return "Fix the reported project issue and rerun htmlslide check.";
};

const agentInstructionForCoreIssue = (issue: CoreIssue, projectPath: string): string => {
  if (issue.type === "schema-validation") {
    return `Open ${path.join(projectPath, "deck.json")} and fix ${issue.path ?? "the schema error"}: ${issue.message}`;
  }
  if (issue.type === "missing-file" && issue.path) {
    return `Create ${issue.path} or update deck.json so it references the correct project-local file.`;
  }
  return issue.suggestedFix ?? "Inspect deck.json and the referenced project files, then fix the reported issue.";
};

const buildReport = (projectPath: string, issues: HtmlslideIssue[]): CheckReport => {
  const summary = summarizeIssues(issues);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: statusFromIssueSummary(summary),
    projectPath,
    summary: {
      ...summary,
      suggestions: 0
    },
    issues
  };
};

const writeReportIfRequested = async (report: CheckReport, input: NormalizedLintInput): Promise<void> => {
  if (!input.writeReport) {
    return;
  }

  const reportsPath = path.join(report.projectPath, ".htmlslide", "reports");
  await mkdir(reportsPath, { recursive: true });
  const reportFileNames = input.reportFileName ? [input.reportFileName] : [...DEFAULT_REPORT_FILE_NAMES];
  const uniqueReportFileNames = [...new Set(reportFileNames)];
  await Promise.all(
    uniqueReportFileNames.map((reportFileName) =>
      writeFile(path.join(reportsPath, reportFileName), `${JSON.stringify(report, null, 2)}\n`)
    )
  );
};

const buildSlideOrder = (slides: readonly ResolvedProjectSlide[]): Map<string, number> => {
  const order = new Map<string, number>([["deck", -1]]);
  slides.forEach((slide) => order.set(slide.id, slide.index));
  return order;
};

const buildManualSlideOrder = (slides: readonly LintSlideInput[]): Map<string, number> => {
  const order = new Map<string, number>([["deck", -1]]);
  slides.forEach((slide, index) => order.set(slide.id, index));
  return order;
};

const sortIssues = (
  issues: readonly HtmlslideIssue[],
  slideOrder: ReadonlyMap<string, number> = new Map([["deck", -1]])
): HtmlslideIssue[] =>
  [...issues].sort((left, right) => {
    const severityDelta = severityRank(left.severity) - severityRank(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const slideDelta = issueSlideRank(left, slideOrder) - issueSlideRank(right, slideOrder);
    if (slideDelta !== 0) {
      return slideDelta;
    }

    return [
      compareStrings(left.path, right.path),
      compareStrings(left.type, right.type),
      compareStrings(left.selector, right.selector),
      compareStrings(left.message, right.message)
    ].find((result) => result !== 0) ?? 0;
  });

const severityRank = (severity: IssueSeverity): number => {
  if (severity === "error") {
    return 0;
  }
  if (severity === "warning") {
    return 1;
  }
  return 2;
};

const issueSlideRank = (issue: HtmlslideIssue, slideOrder: ReadonlyMap<string, number>): number =>
  slideOrder.get(issue.slideId) ?? Number.MAX_SAFE_INTEGER;

const compareStrings = (left: string | undefined, right: string | undefined): number =>
  Buffer.compare(Buffer.from(left ?? "", "utf8"), Buffer.from(right ?? "", "utf8"));

const slideContextFromCoreSlide = (slide: ResolvedProjectSlide): SlideCheckContext => ({
  index: slide.index,
  id: slide.id,
  title: slide.slide.title,
  sourcePath: slide.sourcePath,
  sourceProjectPath: slide.slide.source,
  notesPath: slide.notesPath,
  notesProjectPath: slide.slide.notes,
  durationSec: slide.slide.durationSec
});

const slideContextFromManualSlide = (projectRoot: string, index: number, slide: LintSlideInput): SlideCheckContext => ({
  index,
  id: slide.id,
  title: slide.title,
  sourcePath: path.resolve(projectRoot, slide.sourcePath),
  sourceProjectPath: slide.sourcePath,
  notesPath: slide.notesPath ? path.resolve(projectRoot, slide.notesPath) : undefined,
  notesProjectPath: slide.notesPath,
  durationSec: slide.durationSec
});

const readFileIfExists = async (filePath: string): Promise<string | undefined> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
};

const extractResourceReferences = (content: string): ResourceReference[] => {
  const references: ResourceReference[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(content)) !== null) {
    const tag = tagMatch[1]?.toLowerCase();
    if (!tag) {
      continue;
    }
    const attributes = tagMatch[2] ?? "";
    const rel = getAttributeValue(attributes, "rel")?.toLowerCase();

    for (const attribute of ["src", "href", "poster"]) {
      const url = getAttributeValue(attributes, attribute);
      if (url) {
        references.push({
          url,
          selector: `${tag}[${attribute}]`,
          kind: "attribute",
          attribute,
          rel,
          tag
        });
      }
    }
  }

  references.push(...extractCssResourceReferences(content));
  return references;
};

const extractCssResourceReferences = (content: string): ResourceReference[] => {
  const references: ResourceReference[] = [];
  const cssUrlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s][^)]*?))\s*\)/gi;
  let cssUrlMatch: RegExpExecArray | null;
  while ((cssUrlMatch = cssUrlPattern.exec(content)) !== null) {
    const url = (cssUrlMatch[1] ?? cssUrlMatch[2] ?? cssUrlMatch[3])?.trim();
    if (url) {
      references.push({
        url,
        selector: "css url()",
        kind: "css-url"
      });
    }
  }

  const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))/gi;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(content)) !== null) {
    const url = (importMatch[1] ?? importMatch[2] ?? importMatch[3])?.trim();
    if (url) {
      references.push({
        url,
        selector: "@import",
        kind: "css-import"
      });
    }
  }

  return references;
};

const extractSafeAreaViolations = (html: string, layout: SlideLayoutContext): SafeAreaViolationFinding[] => {
  const violations: SafeAreaViolationFinding[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tag = tagMatch[1]?.toLowerCase();
    if (!tag) {
      continue;
    }

    const attributes = tagMatch[2] ?? "";
    const style = getAttributeValue(attributes, "style");
    if (!style) {
      continue;
    }

    const declarations = parseStyleDeclarations(style);
    const bounds = extractPositionedElementBounds(declarations, layout.viewport);
    if (!bounds) {
      continue;
    }

    const overflow = calculateSafeAreaOverflow(bounds, layout);
    if (
      overflow.overflowTopPx <= 0 &&
      overflow.overflowRightPx <= 0 &&
      overflow.overflowBottomPx <= 0 &&
      overflow.overflowLeftPx <= 0
    ) {
      continue;
    }

    violations.push({
      selector: selectorForTaggedElement(tag, attributes),
      bounds,
      ...overflow
    });
  }

  return violations;
};

const extractPositionedElementBounds = (
  declarations: ReadonlyMap<string, string>,
  viewport: SlideLayoutContext["viewport"]
): ElementBounds | undefined => {
  const position = declarations.get("position")?.trim().toLowerCase();
  if (position !== "absolute" && position !== "fixed") {
    return undefined;
  }

  const left = parseCssPx(declarations.get("left"));
  const right = parseCssPx(declarations.get("right"));
  const top = parseCssPx(declarations.get("top"));
  const bottom = parseCssPx(declarations.get("bottom"));
  const width = parseCssPx(declarations.get("width"));
  const height = parseCssPx(declarations.get("height"));
  const horizontal = resolveAxisBounds(left, right, width, viewport.width);
  const vertical = resolveAxisBounds(top, bottom, height, viewport.height);

  if (!horizontal || !vertical) {
    return undefined;
  }

  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.end - horizontal.start,
    height: vertical.end - vertical.start,
    right: horizontal.end,
    bottom: vertical.end
  };
};

const resolveAxisBounds = (
  startInset: number | undefined,
  endInset: number | undefined,
  size: number | undefined,
  viewportSize: number
): { start: number; end: number } | undefined => {
  if (startInset !== undefined && size !== undefined) {
    return {
      start: startInset,
      end: startInset + size
    };
  }

  if (endInset !== undefined && size !== undefined) {
    const end = viewportSize - endInset;
    return {
      start: end - size,
      end
    };
  }

  if (startInset !== undefined && endInset !== undefined) {
    return {
      start: startInset,
      end: viewportSize - endInset
    };
  }

  return undefined;
};

const calculateSafeAreaOverflow = (
  bounds: ElementBounds,
  layout: SlideLayoutContext
): Omit<SafeAreaViolationFinding, "bounds" | "selector"> => {
  const safeLeft = layout.safeArea.left;
  const safeTop = layout.safeArea.top;
  const safeRight = layout.viewport.width - layout.safeArea.right;
  const safeBottom = layout.viewport.height - layout.safeArea.bottom;

  return {
    overflowTopPx: Math.ceil(Math.max(0, safeTop - bounds.y)),
    overflowRightPx: Math.ceil(Math.max(0, bounds.right - safeRight)),
    overflowBottomPx: Math.ceil(Math.max(0, bounds.bottom - safeBottom)),
    overflowLeftPx: Math.ceil(Math.max(0, safeLeft - bounds.x))
  };
};

const extractTextOverflows = (html: string): TextOverflowFinding[] => {
  const overflows: TextOverflowFinding[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tag = tagMatch[1]?.toLowerCase();
    if (!tag) {
      continue;
    }

    const attributes = tagMatch[2] ?? "";
    if (!declaresTextOverflow(attributes)) {
      const estimatedOverflow = estimateTextOverflow(html, tag, attributes, tagPattern.lastIndex);
      if (estimatedOverflow) {
        overflows.push(estimatedOverflow);
      }
      continue;
    }

    overflows.push({
      selector: selectorForTaggedElement(tag, attributes),
      overflowBottomPx: declaredOverflowBottomPx(attributes),
      source: "declared"
    });
  }

  return overflows;
};

const extractLowContrastText = (html: string): ContrastFinding[] => {
  const findings: ContrastFinding[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tag = tagMatch[1]?.toLowerCase();
    if (!tag || !TEXT_CONTAINER_TAGS.has(tag)) {
      continue;
    }

    const attributes = tagMatch[2] ?? "";
    const style = getAttributeValue(attributes, "style");
    if (!style) {
      continue;
    }

    const contentStartIndex = tagPattern.lastIndex;
    const closeIndex = findClosingTagIndex(html, tag, contentStartIndex);
    if (closeIndex === -1) {
      continue;
    }

    const text = htmlToText(html.slice(contentStartIndex, closeIndex));
    if (!text) {
      continue;
    }

    const declarations = parseStyleDeclarations(style);
    const foreground = parseCssColor(declarations.get("color"));
    const background =
      parseCssColor(declarations.get("background-color")) ?? parseCssColor(declarations.get("background"));
    if (!foreground || !background) {
      continue;
    }

    const contrastRatio = calculateContrastRatio(foreground, background);
    if (contrastRatio >= MIN_TEXT_CONTRAST_RATIO) {
      continue;
    }

    findings.push({
      selector: selectorForTaggedElement(tag, attributes),
      foreground: foreground.source,
      background: background.source,
      contrastRatio,
      minContrastRatio: MIN_TEXT_CONTRAST_RATIO
    });
  }

  return findings;
};

const declaresTextOverflow = (attributes: string): boolean => {
  const value = getAttributeValue(attributes, "data-htmlslide-overflow")?.trim().toLowerCase();
  if (value && DECLARED_TEXT_OVERFLOW_VALUES.has(value)) {
    return true;
  }

  return OVERFLOW_BOTTOM_ATTRIBUTE_NAMES.some((name) => getAttributeValue(attributes, name) !== undefined);
};

const declaredOverflowBottomPx = (attributes: string): number => {
  for (const name of OVERFLOW_BOTTOM_ATTRIBUTE_NAMES) {
    const value = getAttributeValue(attributes, name);
    if (!value) {
      continue;
    }

    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_DECLARED_OVERFLOW_BOTTOM_PX;
};

const estimateTextOverflow = (
  html: string,
  tag: string,
  attributes: string,
  contentStartIndex: number
): TextOverflowFinding | undefined => {
  if (!TEXT_CONTAINER_TAGS.has(tag)) {
    return undefined;
  }

  const style = getAttributeValue(attributes, "style");
  if (!style) {
    return undefined;
  }

  const declarations = parseStyleDeclarations(style);
  const overflowValue = (declarations.get("overflow-y") ?? declarations.get("overflow"))?.toLowerCase();
  if (!overflowValue || !TEXT_OVERFLOW_CLIPPING_VALUES.has(overflowValue)) {
    return undefined;
  }

  const containerHeightPx = parseCssPx(declarations.get("max-height")) ?? parseCssPx(declarations.get("height"));
  if (containerHeightPx === undefined || containerHeightPx <= 0) {
    return undefined;
  }

  const closeIndex = findClosingTagIndex(html, tag, contentStartIndex);
  if (closeIndex === -1) {
    return undefined;
  }

  const innerHtml = html.slice(contentStartIndex, closeIndex);
  const text = htmlToText(innerHtml);
  if (!text) {
    return undefined;
  }

  const fontSizePx = parseCssPx(declarations.get("font-size")) ?? DEFAULT_TEXT_FONT_SIZE_PX;
  const lineHeightPx = parseLineHeightPx(declarations.get("line-height"), fontSizePx);
  const widthPx = parseCssPx(declarations.get("width")) ?? parseCssPx(declarations.get("max-width")) ?? DEFAULT_TEXT_CONTAINER_WIDTH_PX;
  const charactersPerLine = Math.max(8, Math.floor(widthPx / (fontSizePx * 0.56)));
  const estimatedLineCount = Math.max(1, Math.ceil(text.length / charactersPerLine));
  const estimatedContentHeightPx = Math.ceil(estimatedLineCount * lineHeightPx);
  const overflowBottomPx = Math.ceil(estimatedContentHeightPx - containerHeightPx);

  if (overflowBottomPx <= 0) {
    return undefined;
  }

  return {
    selector: selectorForTaggedElement(tag, attributes),
    overflowBottomPx,
    source: "estimated",
    containerHeightPx,
    estimatedContentHeightPx
  };
};

const parseStyleDeclarations = (style: string): Map<string, string> => {
  const declarations = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
    const value = declaration.slice(separatorIndex + 1).trim();
    if (property && value) {
      declarations.set(property, value);
    }
  }

  return declarations;
};

const parseCssPx = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)px$/);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseLineHeightPx = (value: string | undefined, fontSizePx: number): number => {
  if (!value || value.trim().toLowerCase() === "normal") {
    return Math.ceil(fontSizePx * DEFAULT_LINE_HEIGHT_RATIO);
  }

  const pxValue = parseCssPx(value);
  if (pxValue) {
    return pxValue;
  }

  const numericValue = Number.parseFloat(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.ceil(fontSizePx * numericValue);
  }

  return Math.ceil(fontSizePx * DEFAULT_LINE_HEIGHT_RATIO);
};

const parseCssColor = (value: string | undefined): RgbColor | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "transparent" || trimmed.includes("var(")) {
    return undefined;
  }

  const hexMatch = trimmed.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hexMatch) {
    const hex = hexMatch[1] ?? "";
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((character) => `${character}${character}`)
            .join("")
        : hex;
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      source: `#${hex}`
    };
  }

  const rgbMatch = trimmed.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)/i);
  if (rgbMatch) {
    const red = parseCssColorChannel(rgbMatch[1]);
    const green = parseCssColorChannel(rgbMatch[2]);
    const blue = parseCssColorChannel(rgbMatch[3]);
    if (red !== undefined && green !== undefined && blue !== undefined) {
      return {
        red,
        green,
        blue,
        source: rgbMatch[0].replace(/\s+/g, " ")
      };
    }
  }

  for (const [name, [red, green, blue]] of Object.entries(CSS_NAMED_COLORS)) {
    const pattern = new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i");
    if (pattern.test(trimmed)) {
      return { red, green, blue, source: name };
    }
  }

  return undefined;
};

const parseCssColorChannel = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) {
    return undefined;
  }

  return Math.round(parsed);
};

const calculateContrastRatio = (foreground: RgbColor, background: RgbColor): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

const relativeLuminance = (color: RgbColor): number => {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
};

const roundContrastRatio = (ratio: number): number => Math.round(ratio * 100) / 100;

const formatContrastRatio = (ratio: number): string => `${roundContrastRatio(ratio)}:1`;

const findClosingTagIndex = (html: string, tag: string, contentStartIndex: number): number =>
  html.toLowerCase().indexOf(`</${tag}`, contentStartIndex);

const selectorForTaggedElement = (tag: string, attributes: string): string => {
  const explicitSelector = getAttributeValue(attributes, "data-htmlslide-selector")?.trim();
  if (explicitSelector) {
    return explicitSelector;
  }

  const id = getAttributeValue(attributes, "id")?.trim();
  if (id) {
    return `#${id}`;
  }

  const className = getAttributeValue(attributes, "class")?.trim();
  if (className) {
    const classes = className.split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      return `${tag}.${classes.join(".")}`;
    }
  }

  return `${tag}[data-htmlslide-overflow]`;
};

const getAttributeValue = (attributes: string, name: string): string | undefined => {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = attributes.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const isRemoteReferenceCheckable = (reference: ResourceReference, url: string): boolean => {
  if (reference.tag === "a" && reference.attribute === "href") {
    return false;
  }

  if (reference.attribute === "href" && reference.tag !== "link" && !ASSET_EXTENSION_PATTERN.test(stripUrlFragmentAndQuery(url))) {
    return false;
  }

  return true;
};

const remoteIssueType = (
  reference: ResourceReference,
  url: string
): "remote-asset" | "remote-font" | "remote-script" => {
  if (reference.tag === "script" || reference.selector === "script[src]") {
    return "remote-script";
  }

  if (isFontReference(reference, url)) {
    return "remote-font";
  }

  return "remote-asset";
};

const isFontReference = (reference: ResourceReference, url: string): boolean => {
  const cleanUrl = stripUrlFragmentAndQuery(url);
  return (
    FONT_EXTENSION_PATTERN.test(cleanUrl) ||
    /fonts\.(googleapis|gstatic)\.com/i.test(url) ||
    reference.kind === "css-import" ||
    (reference.tag === "link" && reference.rel?.split(/\s+/).includes("stylesheet") === true)
  );
};

const isLocalAssetReference = (reference: ResourceReference, url: string): boolean => {
  if (URL_SCHEME_PATTERN.test(url)) {
    return false;
  }

  const cleanUrl = stripUrlFragmentAndQuery(url);
  if (!cleanUrl || cleanUrl.startsWith("#")) {
    return false;
  }

  if (reference.kind === "css-url" || reference.kind === "css-import") {
    return true;
  }

  if (reference.attribute === "src" || reference.attribute === "poster") {
    return true;
  }

  return reference.tag === "link" || ASSET_EXTENSION_PATTERN.test(cleanUrl);
};

const isIgnorableUrl = (url: string): boolean => {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("javascript:")
  );
};

const findExistingLocalAsset = async (
  projectRoot: string,
  sourcePath: string,
  url: string
): Promise<string | undefined> => {
  const candidatePaths = localAssetCandidatePaths(projectRoot, sourcePath, url);

  for (const candidatePath of candidatePaths) {
    if (isPathInside(projectRoot, candidatePath) && (await pathExists(candidatePath))) {
      return candidatePath;
    }
  }

  return undefined;
};

const localAssetCandidatePaths = (projectRoot: string, sourcePath: string, url: string): string[] => {
  const decodedPath = decodeUrlPath(url);
  const candidates =
    decodedPath.startsWith("/")
      ? [path.join(projectRoot, decodedPath.slice(1))]
      : [path.resolve(path.dirname(sourcePath), decodedPath), path.resolve(projectRoot, decodedPath)];
  return [...new Set(candidates)];
};

const decodeUrlPath = (url: string): string => {
  try {
    return decodeURIComponent(stripUrlFragmentAndQuery(url));
  } catch {
    return stripUrlFragmentAndQuery(url);
  }
};

const stripUrlFragmentAndQuery = (url: string): string => {
  const queryIndex = url.search(/[?#]/);
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

const isPathInside = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const exportExpectations = (project: LoadedDeckProject): ExportExpectation[] => {
  const baseName = slugFileName(project.deck.title);
  const exportsPath = path.join(project.projectRoot, "exports");
  const expectations: ExportExpectation[] = [];

  if (project.deck.export.pdf) {
    expectations.push(exportExpectation(exportsPath, `${baseName}.pdf`, "pdf", "deck"));
  }
  if (project.deck.export.html) {
    expectations.push(exportExpectation(exportsPath, `${baseName}.html`, "html", "deck"));
  }
  if (project.deck.export.deckpkg) {
    expectations.push(exportExpectation(exportsPath, `${baseName}.deckpkg`, "deckpkg", "deck"));
  }
  if (project.deck.export.speakerNotes) {
    expectations.push(exportExpectation(exportsPath, "notes.json", "notes", "deck"));
  }
  if (project.deck.export.thumbnails) {
    expectations.push(
      ...project.slides.map((slide) =>
        exportExpectation(exportsPath, path.join("thumbnails", `${slide.id}.png`), "thumbnail", slide.id)
      )
    );
  }

  return expectations;
};

const exportExpectation = (
  exportsPath: string,
  artifactRelativePath: string,
  artifactKind: ExportExpectation["artifactKind"],
  slideId: string
): ExportExpectation => ({
  artifactPath: path.join(exportsPath, artifactRelativePath),
  artifactProjectPath: path.posix.join("exports", artifactRelativePath.split(path.sep).join("/")),
  artifactKind,
  slideId
});

const newestSourceMtime = async (project: LoadedDeckProject, localAssetPaths: string[]): Promise<number> => {
  const sourcePaths = new Set<string>([
    project.deckPath,
    ...project.slides.map((slide) => slide.sourcePath),
    ...project.slides.map((slide) => slide.notesPath).filter(isPresent),
    ...[project.theme?.cssPath, project.theme?.tokensPath].filter(isPresent),
    ...localAssetPaths
  ]);

  let newest = 0;
  for (const sourcePath of sourcePaths) {
    const sourceStat = await statIfExists(sourcePath);
    if (sourceStat && sourceStat.mtimeMs > newest) {
      newest = sourceStat.mtimeMs;
    }
  }
  return newest;
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

const inspectExportPath = async (
  filePath: string
): Promise<{ info?: Awaited<ReturnType<typeof lstat>>; error?: string }> => {
  try {
    return { info: await lstatIfExists(filePath) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const slugFileName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "deck";

const htmlToText = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

const markdownToText = (markdown: string): string =>
  decodeHtmlEntities(
    markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[#>*_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

const countWords = (text: string): number => {
  const latinWords = text.match(LATIN_WORD_PATTERN)?.length ?? 0;
  const cjkCharacters = text.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  return latinWords + Math.ceil(cjkCharacters / 2);
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
