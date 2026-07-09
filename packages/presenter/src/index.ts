import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import {
  sortIssuesDeterministically,
  statusFromIssueSummary,
  summarizeIssues,
  type HtmlslideIssue,
  type IssueStatus,
  type IssueSummary
} from "@htmlslide/core";
import { DECK_PACKAGE_SCHEMA_VERSION as CORE_DECK_PACKAGE_SCHEMA_VERSION } from "@htmlslide/core/version";

export const DECK_PACKAGE_SCHEMA_VERSION = CORE_DECK_PACKAGE_SCHEMA_VERSION;
export const PRESENTER_SESSION_MODE = "rehearsal" as const;
export const DEFAULT_NOTES_FONT_SIZE_PX = 20;
export const MIN_NOTES_FONT_SIZE_PX = 12;
export const MAX_NOTES_FONT_SIZE_PX = 40;
export const NOTES_FONT_SIZE_STEP_PX = 2;

export type DeckPackageSchemaVersion = typeof DECK_PACKAGE_SCHEMA_VERSION;
export type PresenterSessionMode = typeof PRESENTER_SESSION_MODE;

export type DeckPackageViewport = {
  width: number;
  height: number;
};

export type DeckPackageSafeArea = {
  top: number;
  right: number;
  bottom: number;
  left: number;
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
  schemaVersion: DeckPackageSchemaVersion;
  title: string;
  language: string | null;
  viewport: DeckPackageViewport;
  safeArea: DeckPackageSafeArea;
  pdf: "deck.pdf";
  html: "deck.html";
  notes: "notes.json";
  presenterSettings: "presenter-settings.json";
  thumbnailSize: DeckPackageViewport;
  slideCount: number;
  pageCount: number;
  slides: DeckPackageManifestSlide[];
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
  schemaVersion: DeckPackageSchemaVersion;
  title: string;
  language: string | null;
  slideCount: number;
  slides: NotesSidecarSlide[];
};

export type PresenterSettings = {
  schemaVersion: DeckPackageSchemaVersion;
  mode: PresenterSessionMode;
  timer: boolean;
  notes: {
    visibleByDefault: boolean;
    fontSizePx: number;
  };
};

export type PresenterThumbnail = {
  slideId: string;
  path: string;
  bytes: Uint8Array;
  dataUrl?: string;
  size: DeckPackageViewport;
};

export type PresenterSlide = {
  id: string;
  title: string;
  index: number;
  slideNumber: number;
  pdfPage: number;
  source: string;
  notesPath: string | null;
  durationSec: number;
  notesMarkdown: string;
  hasNotes: boolean;
  thumbnail: PresenterThumbnail;
};

export type PresenterDeckPackage = {
  sourcePath: string | null;
  manifest: DeckPackageManifest;
  notes: NotesSidecar;
  settings: PresenterSettings;
  slides: PresenterSlide[];
  artifacts: {
    html: {
      path: string;
      text: string;
    };
    pdf: {
      path: string;
      bytes: Uint8Array;
    };
    thumbnails: PresenterThumbnail[];
  };
};

export type ReadDeckPackageBytesOptions = {
  sourcePath?: string;
};

export type DeckPackageValidationResult = {
  status: IssueStatus;
  summary: IssueSummary;
  issues: HtmlslideIssue[];
  deckPackage?: PresenterDeckPackage;
};

export class DeckPackageValidationError extends Error {
  readonly issues: HtmlslideIssue[];
  readonly summary: IssueSummary;
  readonly sourcePath: string | null;

  constructor(message: string, issues: readonly HtmlslideIssue[], sourcePath?: string) {
    super(message);
    this.name = "DeckPackageValidationError";
    this.issues = sortIssuesDeterministically(issues);
    this.summary = summarizeIssues(this.issues);
    this.sourcePath = sourcePath ?? null;
  }
}

export async function readDeckPackage(deckpkgPath: string): Promise<PresenterDeckPackage> {
  const issues: HtmlslideIssue[] = [];
  if (!deckpkgPath.endsWith(".deckpkg")) {
    pushIssue(
      issues,
      "invalid-deckpkg-extension",
      "Presenter packages must use the .deckpkg extension.",
      deckpkgPath
    );
    failValidation(issues, deckpkgPath);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(deckpkgPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown file read failure.";
    pushIssue(issues, "deckpkg-read-failed", `Unable to read deck package: ${detail}`, deckpkgPath);
    failValidation(issues, deckpkgPath);
  }

  return readDeckPackageBytes(bytes, { sourcePath: deckpkgPath });
}

export async function validateDeckPackage(deckpkgPath: string): Promise<DeckPackageValidationResult> {
  return validateDeckPackageRead(() => readDeckPackage(deckpkgPath));
}

export async function readDeckPackageBytes(
  bytes: Uint8Array,
  options: ReadDeckPackageBytesOptions = {}
): Promise<PresenterDeckPackage> {
  const issues: HtmlslideIssue[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown ZIP parse failure.";
    pushIssue(issues, "invalid-deckpkg-archive", `Unable to open deck package ZIP archive: ${detail}`, "deckpkg");
    failValidation(issues, options.sourcePath);
  }

  const manifestValue = await readJsonFile(zip, "manifest.json", issues);
  const manifest = manifestValue === undefined ? undefined : parseDeckPackageManifest(manifestValue, issues);
  if (!manifest) {
    failValidation(issues, options.sourcePath);
  }

  validateRequiredPackageFile(zip, manifest.html, issues);
  validateRequiredPackageFile(zip, manifest.pdf, issues);
  for (const slide of manifest.slides) {
    validateRequiredPackageFile(zip, slide.thumbnail, issues, slide.id);
  }

  const notesValue = await readJsonFile(zip, manifest.notes, issues);
  const notes = notesValue === undefined ? undefined : parseNotesSidecar(notesValue, manifest, issues);
  const settingsValue = await readJsonFile(zip, manifest.presenterSettings, issues);
  const settings = settingsValue === undefined ? undefined : parsePresenterSettings(settingsValue, issues);

  if (!notes || !settings || issues.length > 0) {
    failValidation(issues, options.sourcePath);
  }

  const htmlText = await readPackageText(zip, manifest.html);
  const pdfBytes = await readPackageBytes(zip, manifest.pdf);
  const thumbnails: PresenterThumbnail[] = [];
  if (htmlText.trim().length === 0) {
    pushIssue(issues, "empty-package-file", "deck.html must not be empty.", manifest.html);
  }
  if (pdfBytes.byteLength === 0) {
    pushIssue(issues, "empty-package-file", "deck.pdf must not be empty.", manifest.pdf);
  }

  for (const slide of manifest.slides) {
    const thumbnailBytes = await readPackageBytes(zip, slide.thumbnail);
    if (thumbnailBytes.byteLength === 0) {
      pushIssue(issues, "empty-package-file", "Slide thumbnail must not be empty.", slide.thumbnail, slide.id);
    }
    thumbnails.push({
      slideId: slide.id,
      path: slide.thumbnail,
      bytes: thumbnailBytes,
      size: manifest.thumbnailSize
    });
  }

  if (issues.length > 0) {
    failValidation(issues, options.sourcePath);
  }

  const slides = manifest.slides.map<PresenterSlide>((slide, index) => {
    const notesSlide = notes.slides[index];
    const thumbnail = thumbnails[index];
    if (!notesSlide || !thumbnail) {
      throw new Error("Validated deck package has inconsistent slide assets.");
    }

    return {
      id: slide.id,
      title: slide.title,
      index: slide.index,
      slideNumber: slide.index + 1,
      pdfPage: slide.pdfPage,
      source: slide.source,
      notesPath: slide.notes,
      durationSec: slide.durationSec,
      notesMarkdown: notesSlide.markdown,
      hasNotes: notesSlide.hasNotes,
      thumbnail
    };
  });

  return {
    sourcePath: options.sourcePath ?? null,
    manifest,
    notes,
    settings,
    slides,
    artifacts: {
      html: {
        path: manifest.html,
        text: htmlText
      },
      pdf: {
        path: manifest.pdf,
        bytes: pdfBytes
      },
      thumbnails
    }
  };
}

export async function validateDeckPackageBytes(
  bytes: Uint8Array,
  options: ReadDeckPackageBytesOptions = {}
): Promise<DeckPackageValidationResult> {
  return validateDeckPackageRead(() => readDeckPackageBytes(bytes, options));
}

export type PresenterScreenState = "normal" | "black" | "white";
export type PresenterTimerStatus = "running" | "paused";

export type PresenterTimerState = {
  startedAtMs: number;
  accumulatedPausedMs: number;
  pausedAtMs: number | null;
};

export type PresenterSessionState = {
  mode: PresenterSessionMode;
  slideIndex: number;
  slideCount: number;
  totalDurationMs: number;
  timer: PresenterTimerState;
  notesFontSizePx: number;
  screen: PresenterScreenState;
};

export type CreatePresenterSessionOptions = {
  nowMs?: number;
  initialSlideIndex?: number;
  initialSlideId?: string;
  startPaused?: boolean;
  notesFontSizePx?: number;
};

export type PresenterSessionView = {
  mode: PresenterSessionMode;
  currentSlide: PresenterSlide;
  nextSlide: PresenterSlide | null;
  previousSlide: PresenterSlide | null;
  slideIndex: number;
  slideNumber: number;
  slideCount: number;
  progress: number;
  elapsedMs: number;
  remainingMs: number;
  totalDurationMs: number;
  timerStatus: PresenterTimerStatus;
  notesFontSizePx: number;
  screen: PresenterScreenState;
};

export function createPresenterSession(
  deckPackage: PresenterDeckPackage,
  options: CreatePresenterSessionOptions = {}
): PresenterSessionState {
  if (deckPackage.slides.length === 0) {
    throw new RangeError("Presenter sessions require at least one slide.");
  }

  const initialSlideIndex =
    options.initialSlideId !== undefined
      ? deckPackage.slides.findIndex((slide) => slide.id === options.initialSlideId)
      : options.initialSlideIndex ?? 0;
  if (initialSlideIndex < 0 || initialSlideIndex >= deckPackage.slides.length) {
    throw new RangeError("Initial presenter slide is outside the deck range.");
  }

  const nowMs = options.nowMs ?? Date.now();
  const startPaused = options.startPaused ?? !deckPackage.settings.timer;
  return {
    mode: PRESENTER_SESSION_MODE,
    slideIndex: initialSlideIndex,
    slideCount: deckPackage.slides.length,
    totalDurationMs: deckPackage.slides.reduce((total, slide) => total + slide.durationSec * 1000, 0),
    timer: {
      startedAtMs: nowMs,
      accumulatedPausedMs: 0,
      pausedAtMs: startPaused ? nowMs : null
    },
    notesFontSizePx: clampNotesFontSize(options.notesFontSizePx ?? deckPackage.settings.notes.fontSizePx),
    screen: "normal"
  };
}

export function getCurrentSlide(deckPackage: PresenterDeckPackage, state: PresenterSessionState): PresenterSlide {
  const slide = deckPackage.slides[state.slideIndex];
  if (!slide) {
    throw new RangeError("Presenter session slide index is outside the deck range.");
  }
  return slide;
}

export function getNextSlide(deckPackage: PresenterDeckPackage, state: PresenterSessionState): PresenterSlide | null {
  return deckPackage.slides[state.slideIndex + 1] ?? null;
}

export function getPreviousSlide(
  deckPackage: PresenterDeckPackage,
  state: PresenterSessionState
): PresenterSlide | null {
  return deckPackage.slides[state.slideIndex - 1] ?? null;
}

export function nextSlide(state: PresenterSessionState): PresenterSessionState {
  return setSlideIndex(state, Math.min(state.slideIndex + 1, state.slideCount - 1));
}

export function previousSlide(state: PresenterSessionState): PresenterSessionState {
  return setSlideIndex(state, Math.max(state.slideIndex - 1, 0));
}

export function jumpToSlideIndex(state: PresenterSessionState, slideIndex: number): PresenterSessionState {
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= state.slideCount) {
    return state;
  }
  return setSlideIndex(state, slideIndex);
}

export function jumpToSlideNumber(state: PresenterSessionState, slideNumber: number): PresenterSessionState {
  return jumpToSlideIndex(state, slideNumber - 1);
}

export function jumpToSlideId(
  deckPackage: PresenterDeckPackage,
  state: PresenterSessionState,
  slideId: string
): PresenterSessionState {
  const slideIndex = deckPackage.slides.findIndex((slide) => slide.id === slideId);
  return jumpToSlideIndex(state, slideIndex);
}

export function pauseTimer(state: PresenterSessionState, nowMs = Date.now()): PresenterSessionState {
  if (state.timer.pausedAtMs !== null) {
    return state;
  }
  return {
    ...state,
    timer: {
      ...state.timer,
      pausedAtMs: nowMs
    }
  };
}

export function resumeTimer(state: PresenterSessionState, nowMs = Date.now()): PresenterSessionState {
  if (state.timer.pausedAtMs === null) {
    return state;
  }
  return {
    ...state,
    timer: {
      startedAtMs: state.timer.startedAtMs,
      accumulatedPausedMs:
        state.timer.accumulatedPausedMs + Math.max(0, nowMs - state.timer.pausedAtMs),
      pausedAtMs: null
    }
  };
}

export function toggleTimer(state: PresenterSessionState, nowMs = Date.now()): PresenterSessionState {
  return state.timer.pausedAtMs === null ? pauseTimer(state, nowMs) : resumeTimer(state, nowMs);
}

export function getTimerStatus(state: PresenterSessionState): PresenterTimerStatus {
  return state.timer.pausedAtMs === null ? "running" : "paused";
}

export function getElapsedMs(state: PresenterSessionState, nowMs = Date.now()): number {
  const effectiveNowMs = state.timer.pausedAtMs ?? nowMs;
  return Math.max(0, effectiveNowMs - state.timer.startedAtMs - state.timer.accumulatedPausedMs);
}

export function getRemainingMs(state: PresenterSessionState, nowMs = Date.now()): number {
  return Math.max(0, state.totalDurationMs - getElapsedMs(state, nowMs));
}

export function setNotesFontSize(state: PresenterSessionState, fontSizePx: number): PresenterSessionState {
  return {
    ...state,
    notesFontSizePx: clampNotesFontSize(fontSizePx)
  };
}

export function increaseNotesFontSize(state: PresenterSessionState): PresenterSessionState {
  return setNotesFontSize(state, state.notesFontSizePx + NOTES_FONT_SIZE_STEP_PX);
}

export function decreaseNotesFontSize(state: PresenterSessionState): PresenterSessionState {
  return setNotesFontSize(state, state.notesFontSizePx - NOTES_FONT_SIZE_STEP_PX);
}

export function setScreenState(
  state: PresenterSessionState,
  screen: PresenterScreenState
): PresenterSessionState {
  return {
    ...state,
    screen
  };
}

export function clearScreen(state: PresenterSessionState): PresenterSessionState {
  return setScreenState(state, "normal");
}

export function toggleBlackScreen(state: PresenterSessionState): PresenterSessionState {
  return setScreenState(state, state.screen === "black" ? "normal" : "black");
}

export function toggleWhiteScreen(state: PresenterSessionState): PresenterSessionState {
  return setScreenState(state, state.screen === "white" ? "normal" : "white");
}

export function getPresenterSessionView(
  deckPackage: PresenterDeckPackage,
  state: PresenterSessionState,
  nowMs = Date.now()
): PresenterSessionView {
  return {
    mode: state.mode,
    currentSlide: getCurrentSlide(deckPackage, state),
    nextSlide: getNextSlide(deckPackage, state),
    previousSlide: getPreviousSlide(deckPackage, state),
    slideIndex: state.slideIndex,
    slideNumber: state.slideIndex + 1,
    slideCount: state.slideCount,
    progress: state.slideCount === 0 ? 0 : (state.slideIndex + 1) / state.slideCount,
    elapsedMs: getElapsedMs(state, nowMs),
    remainingMs: getRemainingMs(state, nowMs),
    totalDurationMs: state.totalDurationMs,
    timerStatus: getTimerStatus(state),
    notesFontSizePx: state.notesFontSizePx,
    screen: state.screen
  };
}

export type PresenterKeyboardAction =
  | "next"
  | "previous"
  | "toggle-black-screen"
  | "toggle-white-screen"
  | "fullscreen"
  | "jump"
  | "pause-resume-timer"
  | "increase-notes-font-size"
  | "decrease-notes-font-size"
  | "exit";

export type PresenterKeyboardControl = {
  keys: readonly string[];
  action: PresenterKeyboardAction;
  label: string;
};

export const PRESENTER_KEYBOARD_CONTROLS: readonly PresenterKeyboardControl[] = [
  { keys: ["ArrowRight", "Space"], action: "next", label: "Next slide" },
  { keys: ["ArrowLeft"], action: "previous", label: "Previous slide" },
  { keys: ["B"], action: "toggle-black-screen", label: "Toggle black screen" },
  { keys: ["W"], action: "toggle-white-screen", label: "Toggle white screen" },
  { keys: ["F"], action: "fullscreen", label: "Toggle fullscreen" },
  { keys: ["G"], action: "jump", label: "Jump to slide" },
  { keys: ["T"], action: "pause-resume-timer", label: "Pause or resume timer" },
  { keys: ["+"], action: "increase-notes-font-size", label: "Increase notes font size" },
  { keys: ["-"], action: "decrease-notes-font-size", label: "Decrease notes font size" },
  { keys: ["Escape"], action: "exit", label: "Exit presenter mode" }
];

export type PresenterKeyboardInput = string | { key: string };

export type ApplyPresenterKeyboardActionOptions = {
  nowMs?: number;
  jumpSlideIndex?: number;
  jumpSlideNumber?: number;
  jumpSlideId?: string;
};

export function getPresenterKeyboardAction(input: PresenterKeyboardInput): PresenterKeyboardAction | undefined {
  const normalizedKey = normalizeKeyboardKey(typeof input === "string" ? input : input.key);
  return KEYBOARD_ACTION_BY_KEY[normalizedKey];
}

export function applyPresenterKeyboardAction(
  deckPackage: PresenterDeckPackage,
  state: PresenterSessionState,
  action: PresenterKeyboardAction,
  options: ApplyPresenterKeyboardActionOptions = {}
): PresenterSessionState {
  switch (action) {
    case "next":
      return nextSlide(state);
    case "previous":
      return previousSlide(state);
    case "toggle-black-screen":
      return toggleBlackScreen(state);
    case "toggle-white-screen":
      return toggleWhiteScreen(state);
    case "pause-resume-timer":
      return toggleTimer(state, options.nowMs);
    case "increase-notes-font-size":
      return increaseNotesFontSize(state);
    case "decrease-notes-font-size":
      return decreaseNotesFontSize(state);
    case "jump":
      if (options.jumpSlideIndex !== undefined) {
        return jumpToSlideIndex(state, options.jumpSlideIndex);
      }
      if (options.jumpSlideNumber !== undefined) {
        return jumpToSlideNumber(state, options.jumpSlideNumber);
      }
      if (options.jumpSlideId !== undefined) {
        return jumpToSlideId(deckPackage, state, options.jumpSlideId);
      }
      return state;
    case "fullscreen":
    case "exit":
      return state;
  }
}

export function clampNotesFontSize(fontSizePx: number): number {
  if (!Number.isFinite(fontSizePx)) {
    return DEFAULT_NOTES_FONT_SIZE_PX;
  }
  return Math.min(MAX_NOTES_FONT_SIZE_PX, Math.max(MIN_NOTES_FONT_SIZE_PX, Math.round(fontSizePx)));
}

export function isSafeDeckPackagePath(value: string): boolean {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const KEYBOARD_ACTION_BY_KEY: Readonly<Record<string, PresenterKeyboardAction>> = {
  arrowright: "next",
  space: "next",
  spacebar: "next",
  " ": "next",
  arrowleft: "previous",
  b: "toggle-black-screen",
  w: "toggle-white-screen",
  f: "fullscreen",
  g: "jump",
  t: "pause-resume-timer",
  "+": "increase-notes-font-size",
  "=": "increase-notes-font-size",
  "-": "decrease-notes-font-size",
  _: "decrease-notes-font-size",
  escape: "exit",
  esc: "exit"
};

const normalizeKeyboardKey = (key: string): string => (key === " " ? " " : key.trim().toLowerCase());

const setSlideIndex = (state: PresenterSessionState, slideIndex: number): PresenterSessionState => {
  if (state.slideIndex === slideIndex) {
    return state;
  }
  return {
    ...state,
    slideIndex
  };
};

const validateDeckPackageRead = async (
  read: () => Promise<PresenterDeckPackage>
): Promise<DeckPackageValidationResult> => {
  try {
    const deckPackage = await read();
    const issues: HtmlslideIssue[] = [];
    const summary = summarizeIssues(issues);
    return {
      status: statusFromIssueSummary(summary),
      summary,
      issues,
      deckPackage
    };
  } catch (error) {
    if (error instanceof DeckPackageValidationError) {
      return {
        status: statusFromIssueSummary(error.summary),
        summary: error.summary,
        issues: error.issues
      };
    }
    throw error;
  }
};

function failValidation(issues: readonly HtmlslideIssue[], sourcePath?: string): never {
  throw new DeckPackageValidationError("Deck package validation failed.", issues, sourcePath);
}

const pushIssue = (
  issues: HtmlslideIssue[],
  type: string,
  message: string,
  packagePath?: string,
  slideId?: string
): void => {
  const issue: HtmlslideIssue = {
    severity: "error",
    type,
    message
  };
  if (packagePath !== undefined) {
    issue.path = packagePath;
  }
  if (slideId !== undefined) {
    issue.slideId = slideId;
  }
  issues.push(issue);
};

const readJsonFile = async (zip: JSZip, filePath: string, issues: HtmlslideIssue[]): Promise<unknown> => {
  const file = zip.file(filePath);
  if (!file) {
    pushIssue(issues, "missing-package-file", `Required deck package file is missing: ${filePath}.`, filePath);
    return undefined;
  }

  try {
    return JSON.parse(await file.async("string")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid JSON.";
    pushIssue(issues, "invalid-json", `Unable to parse ${filePath}: ${detail}`, filePath);
    return undefined;
  }
};

const readPackageText = async (zip: JSZip, filePath: string): Promise<string> => {
  const file = zip.file(filePath);
  if (!file) {
    throw new Error(`Validated deck package is missing ${filePath}.`);
  }
  return file.async("string");
};

const readPackageBytes = async (zip: JSZip, filePath: string): Promise<Uint8Array> => {
  const file = zip.file(filePath);
  if (!file) {
    throw new Error(`Validated deck package is missing ${filePath}.`);
  }
  return file.async("uint8array");
};

const validateRequiredPackageFile = (
  zip: JSZip,
  filePath: string,
  issues: HtmlslideIssue[],
  slideId?: string
): void => {
  if (!zip.file(filePath)) {
    pushIssue(issues, "missing-package-file", `Required deck package file is missing: ${filePath}.`, filePath, slideId);
  }
};

const parseDeckPackageManifest = (
  value: unknown,
  issues: HtmlslideIssue[]
): DeckPackageManifest | undefined => {
  const record = getRecord(value, issues, "manifest.json", "invalid-manifest");
  if (!record) {
    return undefined;
  }

  const schemaVersion = getLiteralStringField(
    record,
    "schemaVersion",
    issues,
    "manifest.json#/schemaVersion",
    DECK_PACKAGE_SCHEMA_VERSION
  );
  const title = getStringField(record, "title", issues, "manifest.json#/title");
  const language = getNullableStringField(record, "language", issues, "manifest.json#/language");
  const viewport = getSizeField(record, "viewport", issues, "manifest.json#/viewport");
  const safeArea = getSafeAreaField(record, "safeArea", issues, "manifest.json#/safeArea");
  const pdf = getLiteralStringField(record, "pdf", issues, "manifest.json#/pdf", "deck.pdf");
  const html = getLiteralStringField(record, "html", issues, "manifest.json#/html", "deck.html");
  const notes = getLiteralStringField(record, "notes", issues, "manifest.json#/notes", "notes.json");
  const presenterSettings = getLiteralStringField(
    record,
    "presenterSettings",
    issues,
    "manifest.json#/presenterSettings",
    "presenter-settings.json"
  );
  const thumbnailSize = getSizeField(record, "thumbnailSize", issues, "manifest.json#/thumbnailSize");
  const slideCount = getIntegerField(record, "slideCount", issues, "manifest.json#/slideCount", { min: 1 });
  const pageCount = getIntegerField(record, "pageCount", issues, "manifest.json#/pageCount", { min: 1 });
  const slides = getManifestSlides(record.slides, issues);

  if (
    schemaVersion === undefined ||
    title === undefined ||
    language === undefined ||
    viewport === undefined ||
    safeArea === undefined ||
    pdf === undefined ||
    html === undefined ||
    notes === undefined ||
    presenterSettings === undefined ||
    thumbnailSize === undefined ||
    slideCount === undefined ||
    pageCount === undefined ||
    slides === undefined
  ) {
    return undefined;
  }

  const manifest: DeckPackageManifest = {
    schemaVersion,
    title,
    language,
    viewport,
    safeArea,
    pdf,
    html,
    notes,
    presenterSettings,
    thumbnailSize,
    slideCount,
    pageCount,
    slides
  };
  validateManifestInvariants(manifest, issues);
  return manifest;
};

const getManifestSlides = (
  value: unknown,
  issues: HtmlslideIssue[]
): DeckPackageManifestSlide[] | undefined => {
  if (!Array.isArray(value)) {
    pushIssue(issues, "invalid-manifest", "manifest.json#/slides must be an array.", "manifest.json#/slides");
    return undefined;
  }
  if (value.length === 0) {
    pushIssue(issues, "invalid-manifest", "manifest.json#/slides must contain at least one slide.", "manifest.json#/slides");
    return undefined;
  }

  const slides: DeckPackageManifestSlide[] = [];
  value.forEach((slideValue, index) => {
    const slide = parseManifestSlide(slideValue, index, issues);
    if (slide) {
      slides.push(slide);
    }
  });
  return slides.length === value.length ? slides : undefined;
};

const parseManifestSlide = (
  value: unknown,
  arrayIndex: number,
  issues: HtmlslideIssue[]
): DeckPackageManifestSlide | undefined => {
  const pathPrefix = `manifest.json#/slides/${arrayIndex}`;
  const record = getRecord(value, issues, pathPrefix, "invalid-manifest");
  if (!record) {
    return undefined;
  }

  const id = getStringField(record, "id", issues, `${pathPrefix}/id`);
  const title = getStringField(record, "title", issues, `${pathPrefix}/title`);
  const index = getIntegerField(record, "index", issues, `${pathPrefix}/index`, { min: 0 });
  const pdfPage = getIntegerField(record, "pdfPage", issues, `${pathPrefix}/pdfPage`, { min: 1 });
  const source = getStringField(record, "source", issues, `${pathPrefix}/source`);
  const thumbnail = getStringField(record, "thumbnail", issues, `${pathPrefix}/thumbnail`);
  const notes = getNullableStringField(record, "notes", issues, `${pathPrefix}/notes`);
  const durationSec = getIntegerField(record, "durationSec", issues, `${pathPrefix}/durationSec`, { min: 1, max: 24 * 60 });
  let hasPathIssue = false;

  if (source !== undefined && !isSafeDeckReferencePath(source)) {
    pushIssue(issues, "invalid-manifest-path", "Slide source must be a safe project-relative path.", `${pathPrefix}/source`, id);
    hasPathIssue = true;
  }
  if (thumbnail !== undefined && !isSafeDeckPackagePath(thumbnail)) {
    pushIssue(
      issues,
      "invalid-manifest-path",
      "Slide thumbnail must be a safe package-relative path.",
      `${pathPrefix}/thumbnail`,
      id
    );
    hasPathIssue = true;
  }
  if (notes !== undefined && notes !== null && !isSafeDeckReferencePath(notes)) {
    pushIssue(issues, "invalid-manifest-path", "Slide notes must be a safe project-relative path.", `${pathPrefix}/notes`, id);
    hasPathIssue = true;
  }

  if (
    id === undefined ||
    title === undefined ||
    index === undefined ||
    pdfPage === undefined ||
    source === undefined ||
    thumbnail === undefined ||
    notes === undefined ||
    durationSec === undefined ||
    hasPathIssue
  ) {
    return undefined;
  }

  return {
    id,
    title,
    index,
    pdfPage,
    source,
    thumbnail,
    notes,
    durationSec
  };
};

const validateManifestInvariants = (manifest: DeckPackageManifest, issues: HtmlslideIssue[]): void => {
  if (manifest.slideCount !== manifest.slides.length) {
    pushIssue(
      issues,
      "manifest-slide-count-mismatch",
      `manifest.json slideCount is ${manifest.slideCount}, but slides contains ${manifest.slides.length} entries.`,
      "manifest.json#/slideCount"
    );
  }

  const slideIds = new Set<string>();
  const pdfPages = new Set<number>();
  manifest.slides.forEach((slide, arrayIndex) => {
    const slidePath = `manifest.json#/slides/${arrayIndex}`;
    if (slide.index !== arrayIndex) {
      pushIssue(
        issues,
        "manifest-slide-index-mismatch",
        `Slide index must match array position ${arrayIndex}.`,
        `${slidePath}/index`,
        slide.id
      );
    }
    if (slide.pdfPage > manifest.pageCount) {
      pushIssue(
        issues,
        "manifest-pdf-page-out-of-range",
        `Slide PDF page ${slide.pdfPage} exceeds package pageCount ${manifest.pageCount}.`,
        `${slidePath}/pdfPage`,
        slide.id
      );
    }
    if (slideIds.has(slide.id)) {
      pushIssue(issues, "duplicate-slide-id", `Slide id is duplicated: ${slide.id}.`, `${slidePath}/id`, slide.id);
    }
    slideIds.add(slide.id);
    if (pdfPages.has(slide.pdfPage)) {
      pushIssue(
        issues,
        "duplicate-pdf-page",
        `Slide PDF page is duplicated: ${slide.pdfPage}.`,
        `${slidePath}/pdfPage`,
        slide.id
      );
    }
    pdfPages.add(slide.pdfPage);
    if (!slide.thumbnail.startsWith("thumbnails/") || !slide.thumbnail.endsWith(".png")) {
      pushIssue(
        issues,
        "invalid-thumbnail-path",
        "Slide thumbnail must point to thumbnails/<slide-id>.png inside the package.",
        `${slidePath}/thumbnail`,
        slide.id
      );
    }
  });
};

const parseNotesSidecar = (
  value: unknown,
  manifest: DeckPackageManifest,
  issues: HtmlslideIssue[]
): NotesSidecar | undefined => {
  const record = getRecord(value, issues, manifest.notes, "invalid-notes-sidecar");
  if (!record) {
    return undefined;
  }

  const schemaVersion = getLiteralStringField(
    record,
    "schemaVersion",
    issues,
    "notes.json#/schemaVersion",
    DECK_PACKAGE_SCHEMA_VERSION
  );
  const title = getStringField(record, "title", issues, "notes.json#/title");
  const language = getNullableStringField(record, "language", issues, "notes.json#/language");
  const slideCount = getIntegerField(record, "slideCount", issues, "notes.json#/slideCount", { min: 1 });
  const slides = getNotesSlides(record.slides, issues);

  if (
    schemaVersion === undefined ||
    title === undefined ||
    language === undefined ||
    slideCount === undefined ||
    slides === undefined
  ) {
    return undefined;
  }

  const notes: NotesSidecar = {
    schemaVersion,
    title,
    language,
    slideCount,
    slides
  };
  validateNotesAlignment(notes, manifest, issues);
  return notes;
};

const getNotesSlides = (value: unknown, issues: HtmlslideIssue[]): NotesSidecarSlide[] | undefined => {
  if (!Array.isArray(value)) {
    pushIssue(issues, "invalid-notes-sidecar", "notes.json#/slides must be an array.", "notes.json#/slides");
    return undefined;
  }
  if (value.length === 0) {
    pushIssue(issues, "invalid-notes-sidecar", "notes.json#/slides must contain at least one slide.", "notes.json#/slides");
    return undefined;
  }

  const slides: NotesSidecarSlide[] = [];
  value.forEach((slideValue, index) => {
    const slide = parseNotesSlide(slideValue, index, issues);
    if (slide) {
      slides.push(slide);
    }
  });
  return slides.length === value.length ? slides : undefined;
};

const parseNotesSlide = (
  value: unknown,
  arrayIndex: number,
  issues: HtmlslideIssue[]
): NotesSidecarSlide | undefined => {
  const pathPrefix = `notes.json#/slides/${arrayIndex}`;
  const record = getRecord(value, issues, pathPrefix, "invalid-notes-sidecar");
  if (!record) {
    return undefined;
  }

  const id = getStringField(record, "id", issues, `${pathPrefix}/id`);
  const title = getStringField(record, "title", issues, `${pathPrefix}/title`);
  const index = getIntegerField(record, "index", issues, `${pathPrefix}/index`, { min: 0 });
  const pdfPage = getIntegerField(record, "pdfPage", issues, `${pathPrefix}/pdfPage`, { min: 1 });
  const source = getStringField(record, "source", issues, `${pathPrefix}/source`);
  const notesPath = getNullableStringField(record, "notesPath", issues, `${pathPrefix}/notesPath`);
  const durationSec = getIntegerField(record, "durationSec", issues, `${pathPrefix}/durationSec`, { min: 1, max: 24 * 60 });
  const hasNotes = getBooleanField(record, "hasNotes", issues, `${pathPrefix}/hasNotes`);
  const markdown = getStringField(record, "markdown", issues, `${pathPrefix}/markdown`, { allowEmpty: true });
  let hasPathIssue = false;

  if (source !== undefined && !isSafeDeckReferencePath(source)) {
    pushIssue(issues, "invalid-notes-path", "Notes source must be a safe project-relative path.", `${pathPrefix}/source`, id);
    hasPathIssue = true;
  }
  if (notesPath !== undefined && notesPath !== null && !isSafeDeckReferencePath(notesPath)) {
    pushIssue(issues, "invalid-notes-path", "Notes path must be a safe project-relative path.", `${pathPrefix}/notesPath`, id);
    hasPathIssue = true;
  }

  if (
    id === undefined ||
    title === undefined ||
    index === undefined ||
    pdfPage === undefined ||
    source === undefined ||
    notesPath === undefined ||
    durationSec === undefined ||
    hasNotes === undefined ||
    markdown === undefined ||
    hasPathIssue
  ) {
    return undefined;
  }

  return {
    id,
    title,
    index,
    pdfPage,
    source,
    notesPath,
    durationSec,
    hasNotes,
    markdown
  };
};

const validateNotesAlignment = (
  notes: NotesSidecar,
  manifest: DeckPackageManifest,
  issues: HtmlslideIssue[]
): void => {
  if (notes.slideCount !== manifest.slideCount || notes.slides.length !== manifest.slides.length) {
    pushIssue(
      issues,
      "notes-slide-count-mismatch",
      "notes.json slide count must match manifest.json slide count.",
      "notes.json#/slideCount"
    );
  }

  manifest.slides.forEach((manifestSlide, index) => {
    const notesSlide = notes.slides[index];
    if (!notesSlide) {
      return;
    }
    const pathPrefix = `notes.json#/slides/${index}`;
    if (notesSlide.id !== manifestSlide.id) {
      pushIssue(issues, "notes-slide-mismatch", "notes.json slide id must match manifest slide order.", `${pathPrefix}/id`, manifestSlide.id);
    }
    if (notesSlide.index !== manifestSlide.index) {
      pushIssue(issues, "notes-slide-mismatch", "notes.json slide index must match manifest slide index.", `${pathPrefix}/index`, manifestSlide.id);
    }
    if (notesSlide.pdfPage !== manifestSlide.pdfPage) {
      pushIssue(issues, "notes-slide-mismatch", "notes.json PDF page must match manifest PDF page.", `${pathPrefix}/pdfPage`, manifestSlide.id);
    }
    if (notesSlide.notesPath !== manifestSlide.notes) {
      pushIssue(issues, "notes-slide-mismatch", "notes.json notesPath must match manifest notes path.", `${pathPrefix}/notesPath`, manifestSlide.id);
    }
  });
};

const parsePresenterSettings = (value: unknown, issues: HtmlslideIssue[]): PresenterSettings | undefined => {
  const record = getRecord(value, issues, "presenter-settings.json", "invalid-presenter-settings");
  if (!record) {
    return undefined;
  }

  const schemaVersion = getLiteralStringField(
    record,
    "schemaVersion",
    issues,
    "presenter-settings.json#/schemaVersion",
    DECK_PACKAGE_SCHEMA_VERSION
  );
  const mode = getLiteralStringField(record, "mode", issues, "presenter-settings.json#/mode", PRESENTER_SESSION_MODE);
  const timer = getBooleanField(record, "timer", issues, "presenter-settings.json#/timer");
  const notesRecord = getRecord(record.notes, issues, "presenter-settings.json#/notes", "invalid-presenter-settings");
  if (schemaVersion === undefined || mode === undefined || timer === undefined || !notesRecord) {
    return undefined;
  }

  const visibleByDefault = getBooleanField(
    notesRecord,
    "visibleByDefault",
    issues,
    "presenter-settings.json#/notes/visibleByDefault"
  );
  const fontSizePx = getOptionalIntegerField(
    notesRecord,
    "fontSizePx",
    issues,
    "presenter-settings.json#/notes/fontSizePx",
    { min: MIN_NOTES_FONT_SIZE_PX, max: MAX_NOTES_FONT_SIZE_PX }
  );
  if (visibleByDefault === undefined || fontSizePx === undefined) {
    return undefined;
  }

  return {
    schemaVersion,
    mode,
    timer,
    notes: {
      visibleByDefault,
      fontSizePx: fontSizePx ?? DEFAULT_NOTES_FONT_SIZE_PX
    }
  };
};

const getRecord = (
  value: unknown,
  issues: HtmlslideIssue[],
  path: string,
  type: string
): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    pushIssue(issues, type, `${path} must be an object.`, path);
    return undefined;
  }
  return value as Record<string, unknown>;
};

type StringFieldOptions = {
  literal?: string;
  allowEmpty?: boolean;
};

const getStringField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string,
  options: StringFieldOptions = {}
): string | undefined => {
  const value = record[key];
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    pushIssue(issues, "invalid-field", `${path} must be a string.`, path);
    return undefined;
  }
  if (options.literal !== undefined && value !== options.literal) {
    pushIssue(issues, "invalid-field", `${path} must be "${options.literal}".`, path);
    return undefined;
  }
  return value;
};

const getLiteralStringField = <Literal extends string>(
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string,
  literal: Literal
): Literal | undefined => {
  const value = getStringField(record, key, issues, path, { literal });
  return value === undefined ? undefined : literal;
};

const getNullableStringField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string
): string | null | undefined => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    pushIssue(issues, "invalid-field", `${path} must be a string or null.`, path);
    return undefined;
  }
  return value;
};

type IntegerFieldOptions = {
  min?: number;
  max?: number;
};

const getIntegerField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string,
  options: IntegerFieldOptions = {}
): number | undefined => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    pushIssue(issues, "invalid-field", `${path} must be an integer.`, path);
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    pushIssue(issues, "invalid-field", `${path} must be at least ${options.min}.`, path);
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    pushIssue(issues, "invalid-field", `${path} must be at most ${options.max}.`, path);
    return undefined;
  }
  return value;
};

const getOptionalIntegerField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string,
  options: IntegerFieldOptions = {}
): number | null | undefined => {
  if (!(key in record)) {
    return null;
  }
  return getIntegerField(record, key, issues, path, options);
};

const getBooleanField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string
): boolean | undefined => {
  const value = record[key];
  if (typeof value !== "boolean") {
    pushIssue(issues, "invalid-field", `${path} must be a boolean.`, path);
    return undefined;
  }
  return value;
};

const getSizeField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string
): DeckPackageViewport | undefined => {
  const size = getRecord(record[key], issues, path, "invalid-field");
  if (!size) {
    return undefined;
  }
  const width = getIntegerField(size, "width", issues, `${path}/width`, { min: 1, max: 16384 });
  const height = getIntegerField(size, "height", issues, `${path}/height`, { min: 1, max: 16384 });
  if (width === undefined || height === undefined) {
    return undefined;
  }
  return { width, height };
};

const getSafeAreaField = (
  record: Record<string, unknown>,
  key: string,
  issues: HtmlslideIssue[],
  path: string
): DeckPackageSafeArea | undefined => {
  const safeArea = getRecord(record[key], issues, path, "invalid-field");
  if (!safeArea) {
    return undefined;
  }
  const top = getIntegerField(safeArea, "top", issues, `${path}/top`, { min: 0 });
  const right = getIntegerField(safeArea, "right", issues, `${path}/right`, { min: 0 });
  const bottom = getIntegerField(safeArea, "bottom", issues, `${path}/bottom`, { min: 0 });
  const left = getIntegerField(safeArea, "left", issues, `${path}/left`, { min: 0 });
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
    return undefined;
  }
  return { top, right, bottom, left };
};

const isSafeDeckReferencePath = (value: string): boolean => {
  if (!isSafeDeckPackagePath(value)) {
    return false;
  }
  return value !== "exports" && !value.startsWith("exports/");
};
