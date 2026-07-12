import {
  applyPresenterKeyboardAction,
  createPresenterSession,
  createRehearsalPresenterDeck,
  getPresenterKeyboardAction,
  getPresenterSessionView,
  PRESENTER_KEYBOARD_CONTROLS,
  type PresenterDeck,
  type PresenterKeyboardAction,
  type PresenterSlide,
  type PresenterSessionState,
  type PresenterSessionView
} from "@htmlslide/presenter/session";
import {
  Button,
  IconButton,
  PanelHeader,
  SegmentedTabs,
  StatusPill,
  inspectorTabLabels,
  qaSeverityLabels,
  qaSeverityTones,
  toolbarActionLabels
} from "@htmlslide/shared-ui";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CircleX,
  Clock3,
  Download,
  FileText,
  Maximize2,
  MessageSquareText,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Shrink,
  Sparkles,
  Square,
  TimerReset,
  TerminalSquare,
  Text,
  Upload,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
} from "react";
import {
  buildAgentRunStages,
  buildRuntimeStages,
  countIssuesBySeverity,
  filterQaIssues
} from "../model";
import type {
  AgentRunEventLike,
  AgentRunLogLike,
  AgentStage,
  CommandActionStatuses,
  InspectorTab,
  OperationStatus,
  ProjectSummary,
  QaFilter,
  QaIssue,
  SlideSummary
} from "../model";
import type {
  DesktopAgentEngine,
  DesktopAgentRunStatus,
  DesktopAudienceSlidePayload,
  DesktopAudienceWindowRequest,
  DesktopAudienceWindowState,
  DesktopPresenterDisplay,
  DesktopSlidePreviewDocument
} from "../desktop-api";

interface WorkspaceProps {
  activeStageIndex: number;
  agentCanCancel: boolean;
  agentCanPause: boolean;
  agentCanRetry: boolean;
  agentCancelPending: boolean;
  agentEngine: DesktopAgentEngine;
  agentRunId?: string;
  agentRunStatus?: DesktopAgentRunStatus;
  commandValue: string;
  inspectorTab: InspectorTab;
  project: ProjectSummary;
  previewRevision: number;
  qaFilter: QaFilter;
  qaIssues: QaIssue[];
  running: boolean;
  selectedSlideId: string;
  slides: SlideSummary[];
  stages: AgentStage[];
  agentRunEvents: AgentRunEventLike[];
  agentRunLogs: AgentRunLogLike[];
  commandActionStatuses: CommandActionStatuses;
  diffReview?: AgentDiffReview;
  initialPresenterOpen?: InitialPresenterOpen;
  operationStatus: OperationStatus;
  onAcceptDiff?: () => void;
  onCloseDiff?: () => void;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onPresenterDisplaysChanged?: (handler: () => void) => () => void;
  onQaFilterChange: (filter: QaFilter) => void;
  onRevertDiff?: () => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
  onSelectSlide: (slideId: string) => void;
  onSettingsOpen: () => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
  onViewDiff?: () => void;
  loadSlidePreview?: (projectPath: string, slideId: string) => Promise<DesktopSlidePreviewDocument>;
  loadPresenterDeck?: () => Promise<PresenterDeck | null>;
  listPresenterDisplays?: () => Promise<DesktopPresenterDisplay[]>;
  openAudienceWindow?: (request: DesktopAudienceWindowRequest) => Promise<DesktopAudienceWindowState>;
  updateAudienceWindow?: (request: DesktopAudienceWindowRequest) => Promise<DesktopAudienceWindowState>;
  closeAudienceWindow?: () => Promise<DesktopAudienceWindowState>;
}

export interface AgentDiffReview {
  open: boolean;
  runId?: string;
  checkpointId?: string;
  summary?: {
    changed: number;
    added: number;
    deleted: number;
    unchanged: number;
  };
  changedFiles: readonly string[];
  addedFiles: readonly string[];
  deletedFiles: readonly string[];
  unchangedFiles: readonly string[];
  textDiffs: readonly AgentTextDiff[];
  canRevert: boolean;
  statusMessage?: string;
  reverting?: boolean;
}

export interface AgentTextDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  language: "html" | "css" | "json" | "markdown" | "text";
  lines: readonly AgentTextDiffLine[];
  truncated: boolean;
}

export interface AgentTextDiffLine {
  type: "context" | "added" | "removed" | "omitted";
  text: string;
  oldLine?: number;
  newLine?: number;
}

type PresenterSource = "deckpkg" | "deckpkg-file" | "rehearsal";

type ActivePresenterState = {
  deck: PresenterDeck;
  deckpkgPath?: string;
  session: PresenterSessionState;
  source: PresenterSource;
};

type InitialPresenterOpen = {
  id: string;
  source: "deckpkg-file";
  deckpkgPath: string;
  deck: PresenterDeck;
};

type SlidePreviewLoadState =
  | { status: "idle" }
  | { status: "loading"; sourcePath?: string }
  | { status: "ready"; preview: DesktopSlidePreviewDocument }
  | { status: "error"; message: string; sourcePath?: string };

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "outline", label: inspectorTabLabels.outline },
  { id: "design", label: inspectorTabLabels.design },
  { id: "notes", label: inspectorTabLabels.notes },
  { id: "qa", label: inspectorTabLabels.qa },
  { id: "export", label: inspectorTabLabels.export }
];

const filterTabs: Array<{ id: QaFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "error", label: qaSeverityLabels.error },
  { id: "warning", label: qaSeverityLabels.warning },
  { id: "suggestion", label: qaSeverityLabels.suggestion }
];

const qaPanelHeadingId = "qa-panel-heading";
const qaPanelStatusId = "qa-panel-status";
const slidePreviewCacheLimit = 8;

function domIdSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.length > 0 ? normalized : "item";
}

function qaIssueDomId(issue: QaIssue, suffix: string): string {
  return `qa-issue-${domIdSegment(issue.id)}-${suffix}`;
}

function slideStatusTone(status: SlideSummary["status"]): "success" | "warning" | "danger" {
  if (status === "ready") {
    return "success";
  }

  if (status === "blocked") {
    return "danger";
  }

  return "warning";
}

function toolbarIcon(action: keyof typeof toolbarActionLabels): ReactNode {
  const icons = {
    check: <ShieldCheck />,
    export: <Upload />,
    generate: <Sparkles />,
    present: <MonitorPlay />
  };

  return icons[action];
}

export function Workspace({
  activeStageIndex,
  agentCanCancel,
  agentCanPause,
  agentCanRetry,
  agentCancelPending,
  agentEngine,
  agentRunId,
  agentRunStatus,
  agentRunEvents,
  agentRunLogs,
  commandValue,
  commandActionStatuses,
  diffReview,
  initialPresenterOpen,
  inspectorTab,
  onAcceptDiff,
  onCloseDiff,
  onCommandChange,
  onCommandSubmit,
  onInspectorTabChange,
  onPresenterDisplaysChanged,
  closeAudienceWindow,
  loadSlidePreview,
  loadPresenterDeck,
  listPresenterDisplays,
  openAudienceWindow,
  onQaFilterChange,
  onRevertDiff,
  onRunAction,
  onSelectSlide,
  onSettingsOpen,
  onToolbarAction,
  onViewDiff,
  operationStatus,
  project,
  previewRevision,
  qaFilter,
  qaIssues,
  running,
  selectedSlideId,
  slides,
  stages,
  updateAudienceWindow
}: WorkspaceProps): ReactNode {
  const currentSlide =
    slides.find((slide) => slide.id === selectedSlideId) ??
    slides[0] ??
    ({
      accent: "#315fcb",
      bullets: ["Open or create a local project to load deck slides."],
      duration: "0:00",
      id: "empty-workspace",
      number: "00",
      section: "Workspace",
      speakerNotes: "No slide notes are loaded.",
      status: "needs-check",
      title: "No deck loaded"
    } satisfies SlideSummary);
  const selectedSlideIssues = filterQaIssues(qaIssues, "all", selectedSlideId);
  const selectedIssues = filterQaIssues(qaIssues, qaFilter, selectedSlideId);
  const issueCounts = countIssuesBySeverity(qaIssues);
  const selectedIssueCounts = countIssuesBySeverity(selectedSlideIssues);
  const runtimeStages =
    agentRunEvents.length > 0
      ? buildAgentRunStages(agentRunEvents, agentRunLogs, stages)
      : buildRuntimeStages(stages, activeStageIndex, running);
  const previewCacheRef = useRef(new Map<string, DesktopSlidePreviewDocument>());
  const previewRequestIdRef = useRef(0);
  const [previewRetryKey, setPreviewRetryKey] = useState(0);
  const [slidePreviewState, setSlidePreviewState] = useState<SlidePreviewLoadState>({ status: "idle" });
  const previewSnapshot = useMemo(
    () => ({ projectId: project.id, projectPath: project.path, revision: previewRevision }),
    [previewRevision, project.id, project.path, slides]
  );
  const previewSnapshotRef = useRef(previewSnapshot);
  previewSnapshotRef.current = previewSnapshot;
  const canLoadCompilerPreview = Boolean(
    loadSlidePreview &&
    project.path.length > 0 &&
    !project.path.startsWith("~") &&
    !project.path.toLowerCase().endsWith(".deckpkg") &&
    currentSlide.id !== "empty-workspace"
  );

  useEffect(() => {
    previewCacheRef.current.clear();
    previewRequestIdRef.current += 1;
    setSlidePreviewState({ status: "idle" });
  }, [previewSnapshot]);

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current;
    if (!canLoadCompilerPreview || !loadSlidePreview) {
      setSlidePreviewState({ status: "idle" });
      return;
    }

    const cacheKey = `${project.path}:${currentSlide.id}`;
    const cached = previewCacheRef.current.get(cacheKey);
    if (cached) {
      previewCacheRef.current.delete(cacheKey);
      previewCacheRef.current.set(cacheKey, cached);
      setSlidePreviewState({ status: "ready", preview: cached });
      return;
    }

    setSlidePreviewState({ status: "loading", sourcePath: currentSlide.sourcePath });
    loadSlidePreview(project.path, currentSlide.id)
      .then((preview) => {
        if (
          requestId !== previewRequestIdRef.current ||
          previewSnapshotRef.current !== previewSnapshot ||
          preview.slideId !== currentSlide.id
        ) {
          return;
        }
        previewCacheRef.current.set(cacheKey, preview);
        while (previewCacheRef.current.size > slidePreviewCacheLimit) {
          const oldestCacheKey = previewCacheRef.current.keys().next().value;
          if (!oldestCacheKey) {
            break;
          }
          previewCacheRef.current.delete(oldestCacheKey);
        }
        setSlidePreviewState({ status: "ready", preview });
      })
      .catch((error: unknown) => {
        if (requestId !== previewRequestIdRef.current || previewSnapshotRef.current !== previewSnapshot) {
          return;
        }
        setSlidePreviewState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          sourcePath: currentSlide.sourcePath
        });
      });
  }, [
    canLoadCompilerPreview,
    currentSlide.id,
    currentSlide.sourcePath,
    loadSlidePreview,
    previewRetryKey,
    previewSnapshot,
    project.id,
    project.path
  ]);
  const rehearsalPresenterDeck = useMemo(
    () =>
      slides.length > 0
        ? createRehearsalPresenterDeck({
            title: project.title,
            slides: slides.map((slide) => ({
              id: slide.id,
              title: slide.title,
              source: slide.sourcePath,
              notesPath: slide.notesPath,
              notesMarkdown: slide.speakerNotes,
              duration: slide.duration
            }))
          })
        : null,
    [project.title, slides]
  );
  const [presenterState, setPresenterState] = useState<ActivePresenterState | null>(null);
  const openedInitialPresenterIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setPresenterState(null);
  }, [project.id, slides]);

  useEffect(() => {
    if (!initialPresenterOpen || openedInitialPresenterIdRef.current === initialPresenterOpen.id) {
      return;
    }

    openedInitialPresenterIdRef.current = initialPresenterOpen.id;
    const selectedIndex = initialPresenterOpen.deck.slides.findIndex((slide) => slide.id === selectedSlideId);
    setPresenterState({
      deck: initialPresenterOpen.deck,
      deckpkgPath: initialPresenterOpen.deckpkgPath,
      source: initialPresenterOpen.source,
      session: createPresenterSession(initialPresenterOpen.deck, {
        initialSlideIndex: Math.max(0, selectedIndex),
        nowMs: Date.now()
      })
    });
    onToolbarAction("present");
  }, [initialPresenterOpen, onToolbarAction, selectedSlideId]);

  useEffect(() => {
    const presenterSlideId = presenterState?.deck.slides[presenterState.session.slideIndex]?.id;
    if (presenterSlideId) {
      onSelectSlide(presenterSlideId);
    }
  }, [onSelectSlide, presenterState?.deck, presenterState?.session.slideIndex]);

  const handlePresenterSessionChange = useCallback((nextSession: PresenterSessionState): void => {
    setPresenterState((current) => current ? { ...current, session: nextSession } : current);
  }, []);

  const handleOpenPresenter = useCallback(async (): Promise<void> => {
    const loadedPresenterDeck = loadPresenterDeck ? await loadPresenterDeck().catch(() => null) : null;
    const nextPresenterDeck = loadedPresenterDeck ?? rehearsalPresenterDeck;
    const source: PresenterSource = loadedPresenterDeck ? "deckpkg" : "rehearsal";

    if (!nextPresenterDeck) {
      onToolbarAction("present");
      return;
    }

    const selectedIndex = nextPresenterDeck.slides.findIndex((slide) => slide.id === selectedSlideId);
    setPresenterState({
      deck: nextPresenterDeck,
      source,
      session: createPresenterSession(nextPresenterDeck, {
        initialSlideIndex: Math.max(0, selectedIndex),
        nowMs: Date.now()
      })
    });
    onToolbarAction("present");
  }, [loadPresenterDeck, onToolbarAction, rehearsalPresenterDeck, selectedSlideId]);

  const handleWorkspaceToolbarAction = useCallback(
    (action: "generate" | "check" | "export" | "present"): void => {
      if (action === "present") {
        handleOpenPresenter();
        return;
      }
      onToolbarAction(action);
    },
    [handleOpenPresenter, onToolbarAction]
  );

  return (
    <main className={diffReview?.open ? "workspace-shell workspace-shell--with-diff" : "workspace-shell"}>
      <Toolbar
        canRetry={agentCanRetry}
        issueCounts={issueCounts}
        onInspectorTabChange={onInspectorTabChange}
        onRunAction={onRunAction}
        onSettingsOpen={onSettingsOpen}
        onToolbarAction={handleWorkspaceToolbarAction}
        operationStatus={operationStatus}
        project={project}
        running={running}
        statuses={commandActionStatuses}
      />

      <section className="workspace-body">
        <Filmstrip
          issues={qaIssues}
          onSelectSlide={onSelectSlide}
          selectedSlideId={selectedSlideId}
          slides={slides}
        />

        <PreviewCanvas
          issueCount={selectedIssues.length}
          onRetry={() => setPreviewRetryKey((current) => current + 1)}
          previewState={slidePreviewState}
          sample={project.path.startsWith("~")}
          slide={currentSlide}
        />

        <Inspector
          activeTab={inspectorTab}
          currentSlide={currentSlide}
          issueCounts={selectedIssueCounts}
          issues={selectedIssues}
          onQaFilterChange={onQaFilterChange}
          onToolbarAction={handleWorkspaceToolbarAction}
          operationStatus={operationStatus}
          onTabChange={onInspectorTabChange}
          qaFilter={qaFilter}
        />
      </section>

      <AgentRunConsole
        canCancel={agentCanCancel}
        canPause={agentCanPause}
        canRetry={agentCanRetry}
        cancelPending={agentCancelPending}
        commandValue={commandValue}
        diffReview={diffReview}
        onAcceptDiff={onAcceptDiff}
        onCloseDiff={onCloseDiff}
        onCommandChange={onCommandChange}
        onCommandSubmit={onCommandSubmit}
        onRevertDiff={onRevertDiff}
        onRunAction={onRunAction}
        onViewDiff={onViewDiff}
        engine={agentEngine}
        runId={agentRunId}
        runStatus={agentRunStatus}
        running={running}
        statuses={commandActionStatuses}
        stages={runtimeStages}
      />

      {presenterState ? (
        <PresenterMode
          closeAudienceWindow={closeAudienceWindow}
          deck={presenterState.deck}
          onExit={() => setPresenterState(null)}
          onSessionChange={handlePresenterSessionChange}
          openAudienceWindow={openAudienceWindow}
          project={project}
          listPresenterDisplays={listPresenterDisplays}
          onPresenterDisplaysChanged={onPresenterDisplaysChanged}
          session={presenterState.session}
          slides={slides}
          source={presenterState.source}
          updateAudienceWindow={updateAudienceWindow}
        />
      ) : null}
    </main>
  );
}

interface PresenterModeProps {
  closeAudienceWindow?: () => Promise<DesktopAudienceWindowState>;
  deck: PresenterDeck;
  project: ProjectSummary;
  listPresenterDisplays?: () => Promise<DesktopPresenterDisplay[]>;
  onPresenterDisplaysChanged?: (handler: () => void) => () => void;
  openAudienceWindow?: (request: DesktopAudienceWindowRequest) => Promise<DesktopAudienceWindowState>;
  session: PresenterSessionState;
  slides: SlideSummary[];
  source: PresenterSource;
  updateAudienceWindow?: (request: DesktopAudienceWindowRequest) => Promise<DesktopAudienceWindowState>;
  onExit: () => void;
  onSessionChange: (session: PresenterSessionState) => void;
}

function PresenterMode({
  closeAudienceWindow,
  deck,
  listPresenterDisplays,
  onPresenterDisplaysChanged,
  onExit,
  onSessionChange,
  openAudienceWindow,
  project,
  session,
  slides,
  source,
  updateAudienceWindow
}: PresenterModeProps): ReactNode {
  const shellRef = useRef<HTMLElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [presenterDisplays, setPresenterDisplays] = useState<DesktopPresenterDisplay[]>([]);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | undefined>();
  const [displayError, setDisplayError] = useState<string | undefined>();
  const selectedDisplayIdRef = useRef<number | undefined>(undefined);
  const displayRefreshRequestIdRef = useRef(0);
  const [audienceWindowState, setAudienceWindowState] = useState<DesktopAudienceWindowState>({ open: false });
  const [audienceWindowError, setAudienceWindowError] = useState<string | undefined>();

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshPresenterDisplays = useCallback(async (): Promise<void> => {
    const requestId = ++displayRefreshRequestIdRef.current;
    if (!listPresenterDisplays) {
      selectedDisplayIdRef.current = undefined;
      setPresenterDisplays([]);
      setSelectedDisplayId(undefined);
      setDisplayError(undefined);
      return;
    }

    try {
      const displays = await listPresenterDisplays();
      if (requestId !== displayRefreshRequestIdRef.current) {
        return;
      }

      const currentSelectedDisplayId = selectedDisplayIdRef.current;
      const selectedDisplay = displays.find((display) => display.id === currentSelectedDisplayId);
      const preferredDisplay =
        selectedDisplay ??
        displays.find((display) => !display.internal && !display.primary) ??
        displays.find((display) => display.primary) ??
        displays[0];

      selectedDisplayIdRef.current = preferredDisplay?.id;
      setPresenterDisplays(displays);
      setDisplayError(undefined);
      setSelectedDisplayId(preferredDisplay?.id);
    } catch (error: unknown) {
      if (requestId !== displayRefreshRequestIdRef.current) {
        return;
      }

      selectedDisplayIdRef.current = undefined;
      setPresenterDisplays([]);
      setSelectedDisplayId(undefined);
      setDisplayError(error instanceof Error ? error.message : String(error));
    }
  }, [listPresenterDisplays]);

  useEffect(() => {
    void refreshPresenterDisplays();
    if (!onPresenterDisplaysChanged) {
      return () => {
        displayRefreshRequestIdRef.current += 1;
      };
    }

    let active = true;
    const unsubscribe = onPresenterDisplaysChanged(() => {
      if (active) {
        void refreshPresenterDisplays();
      }
    });
    return () => {
      active = false;
      displayRefreshRequestIdRef.current += 1;
      unsubscribe();
    };
  }, [onPresenterDisplaysChanged, refreshPresenterDisplays]);

  const view = useMemo(
    () => getPresenterSessionView(deck, session, nowMs),
    [deck, nowMs, session]
  );
  const currentSlidePreview = findSlidePreview(slides, view.currentSlide.id);
  const nextSlidePreview = view.nextSlide ? findSlidePreview(slides, view.nextSlide.id) : undefined;
  const currentSlideDocumentHtml = view.currentSlide.htmlDocument?.trim() ? view.currentSlide.htmlDocument : undefined;
  const audiencePayload = useMemo<DesktopAudienceSlidePayload>(() => ({
    accent: currentSlidePreview?.accent,
    deckTitle: deck.title,
    imageDataUrl: currentSlideDocumentHtml ? undefined : view.currentSlide.thumbnail.dataUrl,
    screen: view.screen,
    section: currentSlidePreview?.section,
    slideCount: view.slideCount,
    slideId: view.currentSlide.id,
    slideNumber: view.slideNumber,
    slideTitle: view.currentSlide.title,
    sourceDocumentHtml: currentSlideDocumentHtml
  }), [
    currentSlidePreview?.accent,
    currentSlidePreview?.section,
    currentSlideDocumentHtml,
    deck.title,
    view.currentSlide.id,
    view.currentSlide.thumbnail.dataUrl,
    view.currentSlide.title,
    view.screen,
    view.slideCount,
    view.slideNumber
  ]);
  const audienceWindowRequest = useMemo<DesktopAudienceWindowRequest>(() => ({
    displayId: selectedDisplayId,
    payload: audiencePayload
  }), [audiencePayload, selectedDisplayId]);

  const handleSelectedDisplayIdChange = useCallback((displayId: number | undefined): void => {
    selectedDisplayIdRef.current = displayId;
    setSelectedDisplayId(displayId);
  }, []);

  const handleClosePresenter = useCallback((): void => {
    if (audienceWindowState.open) {
      void closeAudienceWindow?.().catch(() => undefined);
    }
    setAudienceWindowState({ open: false });
    onExit();
  }, [audienceWindowState.open, closeAudienceWindow, onExit]);

  useEffect(() => () => {
    void closeAudienceWindow?.().catch(() => undefined);
  }, [closeAudienceWindow]);

  useEffect(() => {
    if (!audienceWindowState.open || !updateAudienceWindow) {
      return;
    }

    updateAudienceWindow(audienceWindowRequest)
      .then((state) => {
        setAudienceWindowState(state);
        setAudienceWindowError(undefined);
      })
      .catch((error: unknown) => {
        setAudienceWindowError(error instanceof Error ? error.message : String(error));
      });
  }, [audienceWindowRequest, audienceWindowState.open, updateAudienceWindow]);

  const handleOpenAudienceWindow = useCallback((): void => {
    if (!openAudienceWindow) {
      setAudienceWindowError("Audience window is unavailable in this runtime.");
      return;
    }

    openAudienceWindow(audienceWindowRequest)
      .then((state) => {
        setAudienceWindowState(state);
        setAudienceWindowError(undefined);
      })
      .catch((error: unknown) => {
        setAudienceWindowError(error instanceof Error ? error.message : String(error));
      });
  }, [audienceWindowRequest, openAudienceWindow]);

  const handleCloseAudienceWindow = useCallback((): void => {
    closeAudienceWindow?.()
      .then((state) => {
        setAudienceWindowState(state);
        setAudienceWindowError(undefined);
      })
      .catch((error: unknown) => {
        setAudienceWindowError(error instanceof Error ? error.message : String(error));
      });
  }, [closeAudienceWindow]);

  const runPresenterAction = useCallback(
    (action: PresenterKeyboardAction, jumpSlideIndex?: number): void => {
      if (action === "exit") {
        handleClosePresenter();
        return;
      }

      if (action === "fullscreen") {
        togglePresenterFullscreen(shellRef.current);
        return;
      }

      if (action === "jump" && jumpSlideIndex === undefined) {
        const answer = window.prompt("Jump to slide number", String(view.slideNumber));
        if (!answer) {
          return;
        }
        const slideNumber = Number(answer);
        onSessionChange(
          applyPresenterKeyboardAction(deck, session, action, {
            jumpSlideNumber: slideNumber
          })
        );
        return;
      }

      onSessionChange(
        applyPresenterKeyboardAction(deck, session, action, {
          jumpSlideIndex,
          nowMs: Date.now()
        })
      );
    },
    [deck, handleClosePresenter, onSessionChange, session, view.slideNumber]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isTextInputTarget(event.target)) {
        return;
      }

      const action = getPresenterKeyboardAction({ key: event.key });
      if (!action) {
        return;
      }

      event.preventDefault();
      runPresenterAction(action);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runPresenterAction]);

  return (
    <section
      aria-label="Presenter rehearsal mode"
      className={`presenter-mode presenter-mode--${view.screen}`}
      ref={shellRef}
    >
      <header className="presenter-mode__topbar">
        <div className="workspace-title">
          <span className="brand-mark">Hs</span>
          <div>
            <strong>{project.title}</strong>
            <span>{source === "rehearsal" ? "Windowed Presenter / Rehearsal Mode" : "Deck Package Presenter / Rehearsal Mode"}</span>
          </div>
        </div>
        <div className="presenter-mode__topbar-actions">
          <StatusPill tone={view.timerStatus === "running" ? "success" : "warning"}>
            {view.timerStatus}
          </StatusPill>
          <StatusPill tone="info">
            {view.slideNumber} / {view.slideCount}
          </StatusPill>
          <IconButton
            icon={<X />}
            label="Exit presenter mode"
            onClick={handleClosePresenter}
          />
        </div>
      </header>

      <div className="presenter-mode__body">
        <section className="presenter-current">
          <PanelHeader
            actions={
              <PresenterTransport
                onAction={runPresenterAction}
                view={view}
              />
            }
            eyebrow="Current slide"
            title={view.currentSlide.title}
          />
          <PresenterSlidePreview
            presenterSlide={view.currentSlide}
            slide={currentSlidePreview}
            variant="current"
          />
          {view.screen !== "normal" ? (
            <div className="presenter-screen-cover">
              <strong>{view.screen === "black" ? "Black screen" : "White screen"}</strong>
            </div>
          ) : null}
        </section>

        <aside className="presenter-console">
          <PresenterTimerPanel view={view} />

          <PresenterDisplayPanel
            audienceError={audienceWindowError}
            audienceOpen={audienceWindowState.open}
            displayError={displayError}
            displays={presenterDisplays}
            canRefreshDisplays={Boolean(listPresenterDisplays)}
            onCloseAudienceWindow={handleCloseAudienceWindow}
            onOpenAudienceWindow={handleOpenAudienceWindow}
            onRefreshDisplays={refreshPresenterDisplays}
            onSelectedDisplayIdChange={handleSelectedDisplayIdChange}
            selectedDisplayId={selectedDisplayId}
          />

          <section className="presenter-panel">
            <PanelHeader
              eyebrow={view.nextSlide ? `Slide ${view.slideNumber + 1}` : "End"}
              title="Next"
            />
            {view.nextSlide ? (
              <PresenterSlidePreview
                presenterSlide={view.nextSlide}
                slide={nextSlidePreview}
                variant="next"
              />
            ) : (
              <div className="presenter-empty-next">
                <CheckCircle2 />
                <strong>Last slide</strong>
                <span>Stay on closing or exit presenter mode.</span>
              </div>
            )}
          </section>

          <section className="presenter-panel presenter-notes-panel">
            <PanelHeader
              actions={
                <div className="presenter-notes-actions">
                  <IconButton
                    icon={<Text />}
                    label="Decrease notes font size"
                    onClick={() => runPresenterAction("decrease-notes-font-size")}
                  />
                  <IconButton
                    icon={<Text />}
                    label="Increase notes font size"
                    onClick={() => runPresenterAction("increase-notes-font-size")}
                  />
                </div>
              }
              eyebrow={formatPresenterDuration(view.currentSlide.durationSec)}
              title="Speaker Notes"
            />
            <div
              className="presenter-notes"
              style={{ fontSize: `${view.notesFontSizePx}px` }}
              tabIndex={0}
            >
              {view.currentSlide.notesMarkdown.length > 0
                ? view.currentSlide.notesMarkdown
                : "No speaker notes for this slide."}
            </div>
          </section>

          <section className="presenter-panel presenter-jump-panel">
            <label className="field-row">
              <span>Jump to slide</span>
              <select
                onChange={(event) => runPresenterAction("jump", Number(event.currentTarget.value))}
                value={view.slideIndex}
              >
                {deck.slides.map((slide, index) => (
                  <option
                    key={slide.id}
                    value={index}
                  >
                    {String(slide.slideNumber).padStart(2, "0")} {slide.title}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <PresenterKeyboardHints />
        </aside>
      </div>
    </section>
  );
}

function PresenterTransport({
  onAction,
  view
}: {
  view: PresenterSessionView;
  onAction: (action: PresenterKeyboardAction) => void;
}): ReactNode {
  return (
    <div className="presenter-transport">
      <IconButton
        disabled={view.slideIndex === 0}
        icon={<ChevronLeft />}
        label="Previous slide"
        onClick={() => onAction("previous")}
      />
      <IconButton
        disabled={view.slideIndex >= view.slideCount - 1}
        icon={<ChevronRight />}
        label="Next slide"
        onClick={() => onAction("next")}
      />
      <IconButton
        icon={view.timerStatus === "running" ? <Pause /> : <Play />}
        label={view.timerStatus === "running" ? "Pause timer" : "Resume timer"}
        onClick={() => onAction("pause-resume-timer")}
        selected={view.timerStatus === "paused"}
      />
      <IconButton
        icon={<Square />}
        label="Toggle black screen"
        onClick={() => onAction("toggle-black-screen")}
        selected={view.screen === "black"}
      />
      <IconButton
        icon={<Shrink />}
        label="Toggle white screen"
        onClick={() => onAction("toggle-white-screen")}
        selected={view.screen === "white"}
      />
      <IconButton
        icon={<Maximize2 />}
        label="Toggle fullscreen"
        onClick={() => onAction("fullscreen")}
      />
    </div>
  );
}

function PresenterTimerPanel({ view }: { view: PresenterSessionView }): ReactNode {
  return (
    <section className="presenter-panel presenter-timer-panel">
      <div>
        <Clock3 />
        <span>Elapsed</span>
        <strong>{formatPresenterClock(view.elapsedMs)}</strong>
      </div>
      <div>
        <TimerReset />
        <span>Remaining</span>
        <strong>{formatPresenterClock(view.remainingMs)}</strong>
      </div>
      <progress
        aria-label="Presenter progress"
        max={1}
        value={view.progress}
      />
    </section>
  );
}

function PresenterDisplayPanel({
  audienceError,
  audienceOpen,
  canRefreshDisplays,
  displayError,
  displays,
  onCloseAudienceWindow,
  onOpenAudienceWindow,
  onRefreshDisplays,
  onSelectedDisplayIdChange,
  selectedDisplayId
}: {
  audienceError?: string;
  audienceOpen: boolean;
  canRefreshDisplays: boolean;
  displayError?: string;
  displays: DesktopPresenterDisplay[];
  onCloseAudienceWindow: () => void;
  onOpenAudienceWindow: () => void;
  onRefreshDisplays: () => void;
  selectedDisplayId?: number;
  onSelectedDisplayIdChange: (displayId: number | undefined) => void;
}): ReactNode {
  const selectedDisplay = displays.find((display) => display.id === selectedDisplayId) ?? displays[0];
  const displayCountLabel =
    displayError
      ? "Unavailable"
      : displays.length === 0
        ? "No displays"
        : displays.length === 1
          ? "Single display"
          : `${displays.length} displays`;

  return (
    <section className="presenter-panel presenter-display-panel">
      <PanelHeader
        actions={
          <IconButton
            disabled={!canRefreshDisplays}
            icon={<RotateCcw />}
            label="Refresh displays"
            onClick={onRefreshDisplays}
          />
        }
        eyebrow={displayCountLabel}
        title="Presenter Display"
      />
      {displays.length > 0 ? (
        <>
          <label className="field-row">
            <span>Target display</span>
            <select
              aria-label="Presenter target display"
              onChange={(event) => onSelectedDisplayIdChange(Number(event.currentTarget.value))}
              value={selectedDisplay?.id ?? ""}
            >
              {displays.map((display) => (
                <option
                  key={display.id}
                  value={display.id}
                >
                  {display.label}{display.primary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          </label>
          {selectedDisplay ? (
            <div className="presenter-display-meta">
              <span>{selectedDisplay.internal ? "Internal" : "External"}</span>
              <span>{formatDisplayBounds(selectedDisplay.bounds)}</span>
              <span>{selectedDisplay.scaleFactor}x</span>
            </div>
          ) : null}
          <div className="presenter-audience-actions">
            <Button
              icon={<MonitorPlay />}
              onClick={onOpenAudienceWindow}
              variant={audienceOpen ? "secondary" : "primary"}
            >
              {audienceOpen ? "Audience live" : "Open audience"}
            </Button>
            {audienceOpen ? (
              <Button
                icon={<X />}
                onClick={onCloseAudienceWindow}
                variant="secondary"
              >
                Close audience
              </Button>
            ) : null}
          </div>
          {audienceError ? (
            <p className="presenter-display-empty">
              {audienceError}
            </p>
          ) : null}
        </>
      ) : (
        <p className="presenter-display-empty">
          {displayError ?? "Display data unavailable."}
        </p>
      )}
    </section>
  );
}

function PresenterSlidePreview({
  presenterSlide,
  slide,
  variant
}: {
  presenterSlide: PresenterSlide;
  slide?: SlideSummary;
  variant: "current" | "next";
}): ReactNode {
  const documentHtml = presenterSlide.htmlDocument?.trim() ? presenterSlide.htmlDocument : undefined;
  const hasDocumentPreview = documentHtml !== undefined;
  const thumbnailDataUrl = presenterSlide.thumbnail.dataUrl;
  const hasImagePreview = !hasDocumentPreview && thumbnailDataUrl !== undefined;
  const accent = slide?.accent ?? "#7da2ff";

  return (
    <article
      aria-label={`${presenterSlide.title} presenter preview`}
      className={[
        "presenter-slide-preview",
        hasDocumentPreview
          ? "presenter-slide-preview--document"
          : hasImagePreview
            ? "presenter-slide-preview--visual"
            : "presenter-slide-preview--fallback",
        variant === "next" ? "presenter-slide-preview--next" : ""
      ].filter(Boolean).join(" ")}
      style={{ "--slide-accent": accent } as CSSProperties}
    >
      {hasDocumentPreview ? (
        <iframe
          className="presenter-slide-preview__frame"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={documentHtml}
          title={`${presenterSlide.title} slide document`}
        />
      ) : hasImagePreview ? (
        <img
          alt={`${presenterSlide.title} visual preview`}
          className="presenter-slide-preview__image"
          src={thumbnailDataUrl}
        />
      ) : (
        <>
          <header>
            <span>{slide?.section ?? `Slide ${presenterSlide.slideNumber}`}</span>
            <strong>{formatPresenterDuration(presenterSlide.durationSec)}</strong>
          </header>
          <section>
            <h1>{presenterSlide.title}</h1>
            <ul>
              {(slide?.bullets ?? [`Review ${presenterSlide.title}`]).slice(0, variant === "next" ? 2 : 4).map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </article>
  );
}

function findSlidePreview(slides: readonly SlideSummary[], slideId: string): SlideSummary | undefined {
  return slides.find((slide) => slide.id === slideId);
}

function PresenterKeyboardHints(): ReactNode {
  return (
    <section className="presenter-panel presenter-keyboard">
      <PanelHeader title="Keyboard" />
      <div>
        {PRESENTER_KEYBOARD_CONTROLS.map((control) => (
          <span key={control.action}>
            <kbd>{control.keys.join(" / ")}</kbd>
            {control.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function formatPresenterDuration(seconds: number): string {
  return formatPresenterClock(seconds * 1000);
}

function formatPresenterClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDisplayBounds(bounds: DesktopPresenterDisplay["bounds"]): string {
  return `${bounds.width} x ${bounds.height}`;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function togglePresenterFullscreen(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }

  void element.requestFullscreen();
}

interface ToolbarProps {
  canRetry: boolean;
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  operationStatus: OperationStatus;
  project: ProjectSummary;
  running: boolean;
  statuses: CommandActionStatuses;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
  onSettingsOpen: () => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
}

function Toolbar({
  canRetry,
  issueCounts,
  onInspectorTabChange,
  onRunAction,
  onSettingsOpen,
  onToolbarAction,
  operationStatus,
  project,
  running,
  statuses
}: ToolbarProps): ReactNode {
  const localPathLoaded = project.path.length > 0 && !project.path.startsWith("~");
  return (
    <header className="workspace-toolbar">
      <div className="workspace-title">
        <span className="brand-mark">Hs</span>
        <div>
          <strong>{project.title}</strong>
          <span>{project.path}</span>
        </div>
      </div>

      <div className="toolbar-actions">
        {(["generate", "check", "export", "present"] as const).map((action) => (
          <Button
            disabled={action === "generate" && running}
            icon={toolbarIcon(action)}
            key={action}
            onClick={() => {
              if (action === "generate") {
                onRunAction("start");
                return;
              }

              if (action === "check") {
                onInspectorTabChange("qa");
              }

              if (action === "export") {
                onInspectorTabChange("export");
              }

              onToolbarAction(action);
            }}
            variant={action === "generate" ? "primary" : "secondary"}
          >
            {toolbarActionLabels[action]}
          </Button>
        ))}
        <Button
          disabled={running || !canRetry}
          icon={<RotateCcw />}
          onClick={() => onRunAction("retry")}
          title={canRetry ? "Retry the failed or cancelled agent run." : "Retry is available after a failed or cancelled run."}
          variant="secondary"
        >
          Retry
        </Button>
      </div>

      <div
        aria-atomic="true"
        aria-label="Workspace status"
        aria-live="polite"
        className="toolbar-status"
        role="status"
      >
        <StatusPill tone={localPathLoaded ? "success" : "warning"}>
          {localPathLoaded ? "Local project" : "Sample project"}
        </StatusPill>
        <StatusPill tone={issueCounts.error > 0 ? "danger" : "success"}>
          {issueCounts.error} blocking
        </StatusPill>
        {(["generate", "check", "repair", "export", "review"] as const).map((action) => (
          <StatusPill
            key={action}
            tone={statusTone(statuses[action].kind)}
          >
            {action}: {statuses[action].message}
          </StatusPill>
        ))}
        <StatusPill tone={operationStatus.kind === "failed" ? "danger" : operationStatus.kind === "success" ? "success" : "info"}>
          {operationStatus.message}
        </StatusPill>
        <IconButton
          icon={<Settings2 />}
          label="Workspace settings"
          onClick={onSettingsOpen}
        />
      </div>
    </header>
  );
}

function statusTone(status: OperationStatus["kind"]): "danger" | "info" | "neutral" | "success" | "warning" {
  if (status === "failed") {
    return "danger";
  }

  if (status === "running") {
    return "info";
  }

  if (status === "success") {
    return "success";
  }

  return "neutral";
}

interface FilmstripProps {
  issues: QaIssue[];
  selectedSlideId: string;
  slides: SlideSummary[];
  onSelectSlide: (slideId: string) => void;
}

function Filmstrip({
  issues,
  onSelectSlide,
  selectedSlideId,
  slides
}: FilmstripProps): ReactNode {
  return (
    <aside className="filmstrip">
      <PanelHeader
        actions={<IconButton disabled icon={<ChevronDown />} label="Sort slides" />}
        title="Slides"
      />
      <div className="filmstrip-list">
        {slides.map((slide) => {
          const slideIssues = issues.filter((issue) => issue.slideId === slide.id);
          const selected = slide.id === selectedSlideId;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={selected ? "filmstrip-item is-selected" : "filmstrip-item"}
              key={slide.id}
              onClick={() => onSelectSlide(slide.id)}
              type="button"
            >
              <span
                className="filmstrip-item__thumb"
                style={{ "--slide-accent": slide.accent } as CSSProperties}
              >
                <strong>{slide.number}</strong>
              </span>
              <span className="filmstrip-item__meta">
                <strong>{slide.title}</strong>
                <small>{slide.section}</small>
              </span>
              {slideIssues.length > 0 ? (
                <span className="filmstrip-item__badge">{slideIssues.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

interface PreviewCanvasProps {
  issueCount: number;
  onRetry: () => void;
  previewState: SlidePreviewLoadState;
  sample: boolean;
  slide: SlideSummary;
}

function PreviewCanvas({ issueCount, onRetry, previewState, sample, slide }: PreviewCanvasProps): ReactNode {
  return (
    <section
      aria-label="Slide preview"
      className="preview-stage"
    >
      <div className="preview-topbar">
        <div>
          <strong>{slide.number} / Review Canvas</strong>
          <span>
            {previewState.status === "ready"
              ? `${previewState.preview.viewport.width} x ${previewState.preview.viewport.height}`
              : slide.sourcePath ?? "Sample preview"}
          </span>
        </div>
        <div className="preview-actions">
          <StatusPill tone={slideStatusTone(slide.status)}>{slide.status.replace("-", " ")}</StatusPill>
          <IconButton
            disabled
            icon={<Maximize2 />}
            label="Fit preview"
          />
        </div>
      </div>

      <div className="slide-canvas-wrap">
        {previewState.status === "ready" ? (
          <ScaledSlidePreview preview={previewState.preview} />
        ) : previewState.status === "loading" ? (
          <div
            aria-label="Slide preview status"
            aria-live="polite"
            className="slide-preview-message"
            role="status"
          >
            <Clock3 />
            <strong>Building slide preview</strong>
            <span>{previewState.sourcePath ?? slide.sourcePath ?? slide.title}</span>
          </div>
        ) : previewState.status === "error" ? (
          <div
            aria-label="Slide preview error"
            className="slide-preview-message slide-preview-message--error"
            role="alert"
          >
            <ShieldCheck />
            <strong>Slide preview could not be built</strong>
            <span>{previewState.sourcePath ?? slide.sourcePath ?? slide.title}</span>
            <p>{previewState.message}</p>
            <p>Check the source file, then retry this preview.</p>
            <Button
              icon={<RotateCcw />}
              onClick={onRetry}
              variant="secondary"
            >
              Retry preview
            </Button>
          </div>
        ) : sample ? (
          <SyntheticSamplePreview
            issueCount={issueCount}
            slide={slide}
          />
        ) : (
          <article
            aria-label={`${slide.title} metadata preview`}
            className="slide-metadata-preview"
            style={{ "--slide-accent": slide.accent } as CSSProperties}
          >
            <span>{slide.section}</span>
            <h1>{slide.title}</h1>
            <p>{slide.sourcePath ?? "No project source document is available for this slide."}</p>
          </article>
        )}
      </div>
    </section>
  );
}

function ScaledSlidePreview({ preview }: { preview: DesktopSlidePreviewDocument }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateScale = (width: number, height: number): void => {
      const nextScale = Math.min(width / preview.viewport.width, height / preview.viewport.height);
      setScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 0);
    };
    updateScale(container.clientWidth, container.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        updateScale(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [preview.viewport.height, preview.viewport.width]);

  return (
    <div
      className="slide-preview-document"
      data-viewport-height={preview.viewport.height}
      data-viewport-width={preview.viewport.width}
      ref={containerRef}
    >
      {scale > 0 ? (
        <div
          className="slide-preview-document__fit"
          style={{
            height: preview.viewport.height * scale,
            width: preview.viewport.width * scale
          }}
        >
          <div
            className="slide-preview-document__surface"
            data-preview-scale={scale.toFixed(6)}
            style={{
              height: preview.viewport.height,
              transform: `scale(${scale})`,
              width: preview.viewport.width
            }}
          >
            <iframe
              className="slide-preview-document__frame"
              referrerPolicy="no-referrer"
              sandbox=""
              srcDoc={preview.htmlDocument}
              tabIndex={-1}
              title={`${preview.title} slide preview`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SyntheticSamplePreview({ issueCount, slide }: { issueCount: number; slide: SlideSummary }): ReactNode {
  return (
        <article
          aria-label={`${slide.title} slide preview`}
          className="slide-canvas"
          style={{ "--slide-accent": slide.accent } as CSSProperties}
        >
          <header>
            <span>{slide.section}</span>
            <strong>{slide.duration}</strong>
          </header>
          <section>
            <h1>{slide.title}</h1>
            <ul>
              {slide.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </section>
          <div className="slide-visual">
            <div className="slide-visual__bars">
              <span />
              <span />
              <span />
            </div>
            <div className="slide-visual__card">
              <Clock3 />
              <strong>{issueCount} QA notes</strong>
              <small>Current slide filter</small>
            </div>
          </div>
        </article>
  );
}

interface InspectorProps {
  activeTab: InspectorTab;
  currentSlide: SlideSummary;
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  issues: QaIssue[];
  operationStatus: OperationStatus;
  qaFilter: QaFilter;
  onQaFilterChange: (filter: QaFilter) => void;
  onTabChange: (tab: InspectorTab) => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
}

function Inspector({
  activeTab,
  currentSlide,
  issueCounts,
  issues,
  onQaFilterChange,
  onToolbarAction,
  operationStatus,
  onTabChange,
  qaFilter
}: InspectorProps): ReactNode {
  return (
    <aside className="inspector">
      <SegmentedTabs
        activeTab={activeTab}
        label="Inspector tabs"
        onChange={onTabChange}
        tabs={inspectorTabs}
      />
      <div className="inspector-body">
        {activeTab === "outline" ? <OutlinePanel slide={currentSlide} /> : null}
        {activeTab === "design" ? <DesignPanel slide={currentSlide} /> : null}
        {activeTab === "notes" ? <NotesPanel slide={currentSlide} /> : null}
        {activeTab === "qa" ? (
          <QaPanel
            issueCounts={issueCounts}
            issues={issues}
            onQaFilterChange={onQaFilterChange}
            qaFilter={qaFilter}
          />
        ) : null}
        {activeTab === "export" ? (
          <ExportPanel
            issueCounts={issueCounts}
            onExport={() => onToolbarAction("export")}
            operationStatus={operationStatus}
          />
        ) : null}
      </div>
    </aside>
  );
}

function OutlinePanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader
        eyebrow={slide.section}
        title="Outline"
      />
      <ol className="outline-list">
        {slide.bullets.map((bullet, index) => (
          <li key={bullet}>
            <span>{index + 1}</span>
            <p>{bullet}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DesignPanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader title="Design Tokens" />
      <div className="token-grid">
        <span>
          <i style={{ background: slide.accent }} />
          Accent
        </span>
        <span>
          <i style={{ background: "#1d2530" }} />
          Text
        </span>
        <span>
          <i style={{ background: "#f5f7fb" }} />
          App bg
        </span>
      </div>
      <label className="field-row">
        <span>Safe area</span>
        <select defaultValue="standard">
          <option value="standard">Standard 72 px</option>
          <option value="tight">Tight 48 px</option>
        </select>
      </label>
      <label className="field-row">
        <span>Typography</span>
        <select defaultValue="system">
          <option value="system">System UI</option>
          <option value="serif">Editorial serif</option>
        </select>
      </label>
    </section>
  );
}

function NotesPanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader title="Presenter Notes" />
      <textarea
        aria-label="Presenter notes"
        defaultValue={slide.speakerNotes}
        rows={9}
      />
      <div className="notes-meta">
        <StatusPill tone="info">{slide.duration}</StatusPill>
        <span>Readable in rehearsal mode</span>
      </div>
    </section>
  );
}

interface QaPanelProps {
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  issues: QaIssue[];
  qaFilter: QaFilter;
  onQaFilterChange: (filter: QaFilter) => void;
}

function QaPanel({
  issueCounts,
  issues,
  onQaFilterChange,
  qaFilter
}: QaPanelProps): ReactNode {
  const totalIssueCount = issueCounts.error + issueCounts.warning + issueCounts.suggestion;
  const issueNoun = issues.length === 1 ? "issue" : "issues";
  const filterLabel = qaFilter === "all" ? "all severities" : qaFilter;
  const statusSummary = issues.length === 0
    ? `QA Panel shows no ${filterLabel} issues.`
    : `QA Panel shows ${issues.length} ${filterLabel} ${issueNoun}: ${issueCounts.error} errors, ${issueCounts.warning} warnings, and ${issueCounts.suggestion} suggestions.`;

  return (
    <section
      aria-describedby={qaPanelStatusId}
      aria-labelledby={qaPanelHeadingId}
      className="inspector-section qa-panel"
      role="region"
    >
      <PanelHeader
        actions={<StatusPill tone={issueCounts.error > 0 ? "danger" : "success"}>{issueCounts.error} errors</StatusPill>}
        titleId={qaPanelHeadingId}
        title="QA Panel"
      />
      <p
        aria-atomic="true"
        aria-label="QA result summary"
        aria-live="polite"
        className="sr-only"
        id={qaPanelStatusId}
        role="status"
      >
        {statusSummary}
      </p>
      <SegmentedTabs
        activeTab={qaFilter}
        label="QA severity filter"
        onChange={onQaFilterChange}
        tabs={filterTabs.map((tab) => ({
          ...tab,
          count: tab.id === "all" ? totalIssueCount : issueCounts[tab.id]
        }))}
      />
      {issues.length === 0 ? (
        <div className="qa-issue-list">
          <div className="empty-state">
            <CheckCircle2 />
            <strong>No issues in this filter</strong>
            <span>Run Check to refresh the report.</span>
          </div>
        </div>
      ) : (
        <div
          aria-label="QA issues"
          className="qa-issue-list"
          role="list"
        >
          {issues.map((issue) => {
            const titleId = qaIssueDomId(issue, "title");
            const messageId = qaIssueDomId(issue, "message");
            const selectorId = qaIssueDomId(issue, "selector");
            const measurementId = qaIssueDomId(issue, "measurement");
            const fixId = qaIssueDomId(issue, "fix");
            return (
              <article
                aria-describedby={`${messageId} ${selectorId} ${measurementId} ${fixId}`}
                aria-labelledby={titleId}
                className="qa-issue"
                key={issue.id}
                role="listitem"
              >
                <div
                  aria-hidden="true"
                  className="qa-issue__thumb"
                >
                  {issue.slideId.replace("slide-", "")}
                </div>
                <div>
                  <StatusPill tone={qaSeverityTones[issue.severity]}>{issue.severity}</StatusPill>
                  <h3 id={titleId}>{issue.type}</h3>
                  <p id={messageId}>{issue.message}</p>
                  <dl>
                    <div>
                      <dt>Location</dt>
                      <dd id={selectorId}>{issue.selector}</dd>
                    </div>
                    <div>
                      <dt>Measurement</dt>
                      <dd id={measurementId}>{issue.measurement}</dd>
                    </div>
                  </dl>
                  <small id={fixId}>{issue.suggestedFix}</small>
                  <div className="qa-issue__actions">
                    <Button
                      aria-label={`Fix ${issue.type} with AI`}
                      size="sm"
                      variant="primary"
                    >
                      Fix with AI
                    </Button>
                    <Button
                      aria-label={`Ignore ${issue.type} once`}
                      size="sm"
                      variant="ghost"
                    >
                      Ignore once
                    </Button>
                    <Button
                      aria-label={`Ignore ${issue.type} rule`}
                      size="sm"
                      variant="ghost"
                    >
                      Ignore rule
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ExportPanel({
  issueCounts,
  onExport,
  operationStatus
}: {
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  operationStatus: OperationStatus;
  onExport: () => void;
}): ReactNode {
  const blocked = issueCounts.error > 0;

  return (
    <section className="inspector-section">
      <PanelHeader title="Export" />
      <div className="export-stack">
        <label className="check-row">
          <input
            defaultChecked
            type="checkbox"
          />
          <span>PDF</span>
        </label>
        <label className="check-row">
          <input
            defaultChecked
            type="checkbox"
          />
          <span>PNG thumbnails</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
          />
          <span>deckpkg</span>
        </label>
        <Button
          disabled={blocked}
          icon={<Download />}
          onClick={onExport}
          variant="primary"
        >
          Export PDF
        </Button>
        <StatusPill tone={blocked ? "danger" : "success"}>
          {blocked ? "Blocked by QA" : "Ready to export"}
        </StatusPill>
        <p
          aria-atomic="true"
          aria-label="Export operation status"
          aria-live="polite"
          className="export-status"
          role="status"
        >
          {operationStatus.message}
        </p>
      </div>
    </section>
  );
}

interface AgentRunConsoleProps {
  canCancel: boolean;
  canPause: boolean;
  canRetry: boolean;
  cancelPending: boolean;
  commandValue: string;
  diffReview?: AgentDiffReview;
  running: boolean;
  engine: DesktopAgentEngine;
  runId?: string;
  runStatus?: DesktopAgentRunStatus;
  stages: ReturnType<typeof buildRuntimeStages>;
  statuses: CommandActionStatuses;
  onAcceptDiff?: () => void;
  onCloseDiff?: () => void;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onRevertDiff?: () => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
  onViewDiff?: () => void;
}

function AgentRunConsole({
  canCancel,
  canPause,
  canRetry,
  cancelPending,
  commandValue,
  diffReview,
  onAcceptDiff,
  onCloseDiff,
  onCommandChange,
  onCommandSubmit,
  onRevertDiff,
  onRunAction,
  onViewDiff,
  engine,
  runId,
  runStatus,
  running,
  statuses,
  stages
}: AgentRunConsoleProps): ReactNode {
  const logDetailsRefs = useRef(new Map<string, HTMLDetailsElement>());
  const hasLogs = stages.some((stage) => Boolean(stage.runId) && stage.logs.length > 0);
  const engineLabel = agentEngineLabels[engine];
  const pauseUnavailableLabel = `${engineLabel} does not support pause.`;
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (running) {
      return;
    }
    onCommandSubmit();
  };

  const handleOpenLogs = (): void => {
    const firstStageWithLogs = stages.find((stage) => Boolean(stage.runId) && stage.logs.length > 0);
    if (!firstStageWithLogs) {
      return;
    }
    const details = logDetailsRefs.current.get(firstStageWithLogs.id);
    if (!details) {
      return;
    }
    details.open = true;
    window.requestAnimationFrame(() => details.querySelector("summary")?.focus());
  };

  return (
    <footer
      className={diffReview?.open ? "agent-console agent-console--with-diff" : "agent-console"}
      data-agent-run-id={runId}
      data-agent-run-status={runStatus}
    >
      <section className="agent-console__timeline">
        {stages.map((stage) => (
          <article
            className={`agent-stage is-${stage.status}`}
            key={stage.id}
            aria-label={`${stage.label}: ${stage.status}`}
          >
            <span className="agent-stage__dot">
              {stage.status === "complete" ? <CheckCircle2 /> : null}
              {stage.status === "running" ? <Activity /> : null}
              {stage.status === "queued" ? <CircleDot /> : null}
              {stage.status === "paused" ? <Pause /> : null}
              {stage.status === "failed" ? <CircleX /> : null}
              {stage.status === "cancelled" ? <Ban /> : null}
            </span>
            <div>
              <strong>{stage.label}</strong>
              <p>{stage.summary}</p>
              <small>
                Files {stage.filesChanged} · Issues {stage.issuesFound} · Next {stage.nextAction}
              </small>
              <details
                ref={(element) => {
                  if (element) {
                    logDetailsRefs.current.set(stage.id, element);
                  } else {
                    logDetailsRefs.current.delete(stage.id);
                  }
                }}
              >
                <summary>Logs</summary>
                {stage.logs.map((log) => (
                  <code key={log}>{log}</code>
                ))}
              </details>
            </div>
          </article>
        ))}
      </section>

      {diffReview?.open ? (
        <DiffReviewPanel
          review={diffReview}
          onAccept={onAcceptDiff}
          onClose={onCloseDiff}
          onRevert={onRevertDiff}
          onView={onViewDiff}
        />
      ) : null}

      <section className="command-bar">
        <div className="command-bar__controls">
          <Button
            disabled={running}
            icon={<Play />}
            onClick={() => onRunAction("start")}
            variant="primary"
          >
            Run
          </Button>
          <Button
            aria-label={pauseUnavailableLabel}
            disabled={!canPause}
            icon={<Pause />}
            onClick={() => onRunAction("pause")}
            title={pauseUnavailableLabel}
            variant="secondary"
          >
            Pause unavailable
          </Button>
          <IconButton
            disabled={!canCancel || cancelPending}
            icon={<Square />}
            label={cancelPending ? "Cancelling agent run" : "Cancel run"}
            onClick={() => onRunAction("cancel")}
          />
          <IconButton
            disabled={running || !canRetry}
            icon={<RotateCcw />}
            label="Retry run"
            onClick={() => onRunAction("retry")}
          />
          <IconButton
            disabled={!onViewDiff}
            icon={<FileText />}
            label="View diff"
            onClick={onViewDiff}
            selected={Boolean(diffReview?.open)}
          />
          <IconButton
            disabled={!hasLogs}
            icon={<TerminalSquare />}
            label="Open logs"
            onClick={handleOpenLogs}
          />
        </div>
        <div
          aria-atomic="true"
          aria-label="Agent command statuses"
          aria-live="polite"
          className="command-bar__status"
          role="status"
        >
          {(["generate", "check", "repair", "export", "review"] as const).map((action) => (
            <span
              className={`command-status is-${statuses[action].kind}`}
              key={action}
            >
              <strong>{action}</strong>
              <span>{statuses[action].message}</span>
            </span>
          ))}
        </div>
        <form onSubmit={handleSubmit}>
          <MessageSquareText />
          <input
            aria-label="Command bar"
            onChange={(event) => onCommandChange(event.currentTarget.value)}
            placeholder="Ask the agent to revise, check, repair, or export this deck"
            value={commandValue}
          />
          <Button
            disabled={running}
            icon={<Send />}
            size="sm"
            type="submit"
            variant="primary"
          >
            Send
          </Button>
        </form>
      </section>
    </footer>
  );
}

const agentEngineLabels: Record<DesktopAgentEngine, string> = {
  "external-agent": "External agent",
  "htmlslide-agent": "HTMLslide Agent",
  "mock-agent": "Local Mock"
};

function DiffReviewPanel({
  onAccept,
  onClose,
  onRevert,
  onView,
  review
}: {
  review: AgentDiffReview;
  onAccept?: () => void;
  onClose?: () => void;
  onRevert?: () => void;
  onView?: () => void;
}): ReactNode {
  const hasChangedFiles = review.changedFiles.length + review.addedFiles.length + review.deletedFiles.length > 0;
  const changedSourceFiles = [...review.changedFiles, ...review.addedFiles, ...review.deletedFiles];
  const changedSlideFiles = changedSourceFiles.filter((file) => file.startsWith("slides/"));
  const summary = {
    added: review.summary?.added ?? review.addedFiles.length,
    changed: review.summary?.changed ?? review.changedFiles.length,
    deleted: review.summary?.deleted ?? review.deletedFiles.length,
    unchanged: review.summary?.unchanged ?? review.unchangedFiles.length
  };
  const checkpointLabel = review.checkpointId ?? "No checkpoint";
  const runLabel = review.runId ?? "No run id";

  return (
    <section
      aria-label="Agent diff review"
      className="agent-diff-review"
    >
      <PanelHeader
        actions={
          <>
            <Button
              disabled={!onView}
              icon={<FileText />}
              onClick={onView}
              size="sm"
              variant="secondary"
            >
              View diff
            </Button>
            <Button
              disabled={!onAccept || review.reverting}
              icon={<CheckCircle2 />}
              onClick={onAccept}
              size="sm"
              variant="primary"
            >
              Accept changes
            </Button>
            <Button
              disabled={!review.canRevert || !onRevert || review.reverting}
              icon={<RotateCcw />}
              onClick={onRevert}
              size="sm"
              variant="danger"
            >
              {review.reverting ? "Reverting" : "Revert changes"}
            </Button>
            <IconButton
              disabled={!onClose}
              icon={<X />}
              label="Close diff review"
              onClick={onClose}
            />
          </>
        }
        eyebrow="Agent checkpoint"
        title="Review changes"
      />
      <div className="agent-diff-review__meta">
        <span>
          Run <code title={runLabel}>{runLabel}</code>
        </span>
        <span>
          Checkpoint <code title={checkpointLabel}>{checkpointLabel}</code>
        </span>
      </div>

      <div className="agent-diff-review__body">
        <div className="agent-diff-review__summary">
          <DiffCount label="Changed" value={summary.changed} />
          <DiffCount label="Added" value={summary.added} />
          <DiffCount label="Deleted" value={summary.deleted} />
          <DiffCount label="Unchanged" value={summary.unchanged} />
        </div>

        <div className="agent-diff-review__lists">
          <DiffFileList
            files={changedSourceFiles}
            label="Files changed"
          />
          <DiffFileList
            files={changedSlideFiles}
            label="Slides changed"
          />
          <DiffFileList
            files={review.addedFiles}
            label="Added"
          />
          <DiffFileList
            files={review.deletedFiles}
            label="Deleted"
          />
        </div>

        <div className="agent-diff-review__qa">
          <strong>{hasChangedFiles ? "QA delta available after check" : "No source changes detected"}</strong>
          <span>{review.statusMessage ?? "Review changed source files, then accept or revert this checkpoint."}</span>
          {review.checkpointId ? <code>{review.checkpointId}</code> : null}
        </div>

        <DiffTextPanel textDiffs={review.textDiffs} />
      </div>
    </section>
  );
}

function DiffCount({
  label,
  value
}: {
  label: string;
  value: number;
}): ReactNode {
  return (
    <span className="agent-diff-count">
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function DiffFileList({
  files,
  label
}: {
  label: string;
  files: readonly string[];
}): ReactNode {
  return (
    <section className="agent-diff-file-list">
      <strong>{label}</strong>
      {files.length > 0 ? (
        <ul>
          {files.map((file) => (
            <li key={file}>
              <code title={file}>{file}</code>
            </li>
          ))}
        </ul>
      ) : (
        <span>No files</span>
      )}
    </section>
  );
}

function DiffTextPanel({
  textDiffs
}: {
  textDiffs: readonly AgentTextDiff[];
}): ReactNode {
  return (
    <section className="agent-text-diff-panel">
      <div className="agent-text-diff-panel__header">
        <strong>Text/CSS diff</strong>
        <span>{textDiffs.length > 0 ? `${textDiffs.length} readable files` : "No readable text changes"}</span>
      </div>
      {textDiffs.length > 0 ? (
        <div className="agent-text-diff-panel__files">
          {textDiffs.map((textDiff) => (
            <article
              className="agent-text-diff"
              key={textDiff.path}
            >
              <div className="agent-text-diff__title">
                <code title={textDiff.path}>{textDiff.path}</code>
                <span>{textDiff.status}</span>
              </div>
              <div className="agent-text-diff__lines">
                {textDiff.lines.map((line, index) => (
                  <div
                    className={`agent-text-diff__line is-${line.type}`}
                    key={`${textDiff.path}-${index}`}
                  >
                    <span>{line.oldLine ?? ""}</span>
                    <span>{line.newLine ?? ""}</span>
                    <code>{line.text}</code>
                  </div>
                ))}
              </div>
              {textDiff.truncated ? <small>Diff output truncated for review.</small> : null}
            </article>
          ))}
        </div>
      ) : (
        <p>No readable text changes.</p>
      )}
    </section>
  );
}
