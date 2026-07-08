export const DECK_PACKAGE_SCHEMA_VERSION = "0.1.0" as const;
export const PRESENTER_SESSION_MODE = "rehearsal" as const;
export const DEFAULT_NOTES_FONT_SIZE_PX = 20;
export const MIN_NOTES_FONT_SIZE_PX = 12;
export const MAX_NOTES_FONT_SIZE_PX = 40;
export const NOTES_FONT_SIZE_STEP_PX = 2;
export const DEFAULT_REHEARSAL_SLIDE_DURATION_SEC = 60;

export type DeckPackageSchemaVersion = typeof DECK_PACKAGE_SCHEMA_VERSION;
export type PresenterSessionMode = typeof PRESENTER_SESSION_MODE;

export type DeckPackageViewport = {
  width: number;
  height: number;
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

export type PresenterDeck = {
  title: string;
  settings: PresenterSettings;
  slides: PresenterSlide[];
};

export type RehearsalPresenterSlideInput = {
  id: string;
  title: string;
  source?: string | null;
  notesPath?: string | null;
  notesMarkdown?: string | null;
  durationSec?: number | null;
  duration?: string | null;
};

export type CreateRehearsalPresenterDeckOptions = {
  title: string;
  slides: readonly RehearsalPresenterSlideInput[];
  timer?: boolean;
  notesFontSizePx?: number;
  thumbnailSize?: DeckPackageViewport;
};

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

export function createRehearsalPresenterDeck(
  options: CreateRehearsalPresenterDeckOptions
): PresenterDeck {
  if (options.slides.length === 0) {
    throw new RangeError("Presenter rehearsal decks require at least one slide.");
  }

  const thumbnailSize = options.thumbnailSize ?? { width: 960, height: 540 };
  const slides = options.slides.map<PresenterSlide>((slide, index) => {
    const durationSec = normalizeDurationSec(slide.durationSec ?? parseDurationLabel(slide.duration));
    const notesMarkdown = slide.notesMarkdown?.trim() ?? "";

    return {
      id: slide.id,
      title: slide.title,
      index,
      slideNumber: index + 1,
      pdfPage: index + 1,
      source: slide.source ?? "",
      notesPath: slide.notesPath ?? null,
      durationSec,
      notesMarkdown,
      hasNotes: notesMarkdown.length > 0,
      thumbnail: {
        slideId: slide.id,
        path: "",
        bytes: new Uint8Array(),
        size: thumbnailSize
      }
    };
  });

  return {
    title: options.title,
    settings: {
      schemaVersion: DECK_PACKAGE_SCHEMA_VERSION,
      mode: PRESENTER_SESSION_MODE,
      timer: options.timer ?? true,
      notes: {
        visibleByDefault: true,
        fontSizePx: clampNotesFontSize(options.notesFontSizePx ?? DEFAULT_NOTES_FONT_SIZE_PX)
      }
    },
    slides
  };
}

export function createPresenterSession(
  deckPackage: PresenterDeck,
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

export function getCurrentSlide(deckPackage: PresenterDeck, state: PresenterSessionState): PresenterSlide {
  const slide = deckPackage.slides[state.slideIndex];
  if (!slide) {
    throw new RangeError("Presenter session slide index is outside the deck range.");
  }
  return slide;
}

export function getNextSlide(deckPackage: PresenterDeck, state: PresenterSessionState): PresenterSlide | null {
  return deckPackage.slides[state.slideIndex + 1] ?? null;
}

export function getPreviousSlide(deckPackage: PresenterDeck, state: PresenterSessionState): PresenterSlide | null {
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
  deckPackage: PresenterDeck,
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

export function setScreenState(state: PresenterSessionState, screen: PresenterScreenState): PresenterSessionState {
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
  deckPackage: PresenterDeck,
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

export function getPresenterKeyboardAction(input: PresenterKeyboardInput): PresenterKeyboardAction | undefined {
  const normalizedKey = normalizeKeyboardKey(typeof input === "string" ? input : input.key);
  return KEYBOARD_ACTION_BY_KEY[normalizedKey];
}

export function applyPresenterKeyboardAction(
  deckPackage: PresenterDeck,
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

export function parseDurationLabel(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return undefined;
  }

  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  if (numbers.length === 2) {
    const [minutes = 0, seconds = 0] = numbers;
    return minutes * 60 + seconds;
  }

  const [hours = 0, minutes = 0, seconds = 0] = numbers;
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeDurationSec(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_REHEARSAL_SLIDE_DURATION_SEC;
  }
  return Math.max(1, Math.round(value));
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
