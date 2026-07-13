import "@htmlslide/shared-ui/styles.css";
import "./app.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PresenterDeck } from "@htmlslide/presenter/session";
import { Onboarding } from "./components/Onboarding";
import { ProjectLibrary } from "./components/ProjectLibrary";
import { Workspace, type AgentDiffReview } from "./components/Workspace";
import {
  getDesktopApi,
  type DesktopAgentEngine,
  type DesktopAgentRunResult,
  type DesktopAgentRunSnapshot,
  type DesktopAgentRunStatus,
  type DesktopCheckReport,
  type DesktopAudienceWindowRequest,
  type DesktopAudienceWindowState,
  type DesktopCliIntegrationState,
  type DesktopExternalAgentConnectionState,
  type DesktopExportOptions,
  type DesktopOfficialSkillsState,
  type DesktopProjectAgentSkillsState,
  type DesktopPresenterPreferences,
  type DesktopPresenterDeckResult,
  type DesktopProjectPreview,
  type DesktopProjectRecord,
  type DesktopSourceFileSelection,
  type DesktopSmokeReadyMarker
} from "./desktop-api";
import {
  buildAgentRepairPrompt,
  buildNewDeckAgentBrief,
  defaultNewDeckExportSelection,
  defaultCommandActionStatuses,
  formatProjectOpenedAt,
  getNextStageIndex,
  newDeckExportSelectionFromOutputs,
  newDeckManifestExportOptionsFromOutputs,
  newDeckTargetSlideCount,
  type AgentRunEventLike,
  type AgentRunLogLike,
  type AppView,
  type CommandAction,
  type CommandActionStatuses,
  type InspectorTab,
  type LibrarySection,
  type NewDeckDraft,
  type NewDeckExportSelection,
  type OperationStatus,
  type ProjectSummary,
  type QaCheckStatus,
  type QaFilter,
  type QaIssue,
  type SlideSummary
} from "./model";
import type { ExternalAgentId } from "./settings-model";
import {
  buildAiEngineSettingsUpdate,
  createDefaultAiEngineSettings,
  createDefaultExternalAgentStatuses,
  formatRedactedKeyStatus,
  normalizeAiEngineSettings,
  type AiEngineMode,
  type AiEngineSettings,
  type AiEngineSettingsDraft,
  type ExternalAgentStatus
} from "./settings-model";
import type { FileCopyCheckpointDiff } from "@htmlslide/agent";
import {
  agentStages,
  onboardingSteps,
  projects as sampleProjects,
  slides as sampleSlides
} from "./sampleData";

const idleStatus: OperationStatus = {
  kind: "idle",
  message: "Ready"
};

const nowIso = (): string => new Date().toISOString();

type DirectPresenterOpen = {
  id: string;
  source: "deckpkg-file";
  deckpkgPath: string;
  deck: PresenterDeck;
};

const presenterDeckAccents = ["#315fcb", "#267a4f", "#9a6410", "#286a8d", "#7b4ab8", "#bc3a3a"];
const activeAgentRunStatuses = new Set<string>(["queued", "running", "awaiting-user-choice", "cancelling"]);

type AgentCancelE2EWindow = Window & {
  __HTMLSLIDE_E2E_BEFORE_AGENT_CANCEL__?: (runId: string) => void | Promise<void>;
};

function agentEngineLabel(engine: DesktopAgentEngine): string {
  if (engine === "external-agent") {
    return "External agent";
  }
  if (engine === "htmlslide-agent") {
    return "HTMLslide Agent";
  }
  return "Mock generation";
}

function selectedAgentEngine(settings: AiEngineSettings): DesktopAgentEngine {
  return settings.mode === "no-ai" ? "mock-agent" : settings.mode;
}

function agentResultChangedFiles(result: DesktopAgentRunResult | undefined): readonly string[] {
  if (!result) {
    return [];
  }
  if (result.providerId === "external-agent") {
    return result.summary.filesChanged;
  }
  if (result.providerId === "htmlslide-byok") {
    return result.applied?.filesChanged ?? result.agent?.outputs.build?.filesChanged ?? [];
  }
  return result.applied?.filesChanged ?? result.agent.outputs.build?.filesChanged ?? [];
}

function formatPresenterDurationLabel(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 60;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function titleCaseLabel(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function bulletsFromSpeakerNotes(notes: string, fallbackTitle: string): string[] {
  const bullets = notes
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^#+\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);

  return bullets.length > 0 ? bullets : [`Review ${fallbackTitle}`];
}

function presenterDeckToWorkspaceState(
  deck: PresenterDeck,
  deckpkgPath: string
): {
  project: ProjectSummary;
  slides: SlideSummary[];
} {
  const project: ProjectSummary = {
    id: `deckpkg:${deckpkgPath}`,
    title: deck.title,
    path: deckpkgPath,
    lastOpened: "Opened deck package",
    status: "Ready",
    slideCount: deck.slides.length
  };

  return {
    project,
    slides: deck.slides.map((slide, index) => {
      const durationSec = typeof slide.durationSec === "number" && Number.isFinite(slide.durationSec)
        ? slide.durationSec
        : 60;
      const section = typeof slide.source === "string" && slide.source.trim().length > 0
        ? titleCaseLabel(slide.source.split("/").at(-1)?.replace(/\.[^.]+$/u, "") ?? "Deck package")
        : "Deck Package";

      return {
        id: slide.id,
        number: String(slide.slideNumber ?? index + 1).padStart(2, "0"),
        title: slide.title,
        section,
        status: "ready",
        duration: formatPresenterDurationLabel(durationSec),
        accent: presenterDeckAccents[index % presenterDeckAccents.length] ?? "#315fcb",
        speakerNotes: slide.notesMarkdown,
        bullets: bulletsFromSpeakerNotes(slide.notesMarkdown, slide.title),
        sourcePath: slide.source,
        notesPath: slide.notesPath ?? undefined
      };
    })
  };
}

function projectRecordToSummary(project: DesktopProjectRecord): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    path: project.path,
    lastOpened: formatProjectOpenedAt(project.lastOpenedAt),
    status: project.status,
    slideCount: project.slideCount,
    exportOptions: project.exportOptions,
    speakerNotesMode: project.speakerNotesMode
  };
}

function projectRecordsToSummaries(projects: DesktopProjectRecord[]): ProjectSummary[] {
  return projects.map(projectRecordToSummary);
}

function defaultPresenterPreferences(project: ProjectSummary): DesktopPresenterPreferences {
  return {
    notesFontSizePx: 20,
    projectId: project.id,
    projectPath: project.path
  };
}

function reportToIssues(report: DesktopCheckReport | undefined): QaIssue[] {
  return (report?.issues ?? []).map((issue, index) => ({
    id: `${issue.slideId ?? "deck"}-${issue.type ?? "issue"}-${index}`,
    measurement:
      typeof issue.measurement === "string"
        ? issue.measurement
        : issue.measurement
          ? JSON.stringify(issue.measurement)
          : "n/a",
    message: issue.message ?? "HTMLslide check reported an issue.",
    selector: issue.selector ?? issue.path ?? "deck",
    severity: issue.severity === "error" || issue.severity === "warning" ? issue.severity : "suggestion",
    slideId: issue.slideId ?? "deck",
    suggestedFix: issue.suggestedFix ?? issue.agentInstruction ?? "Inspect the source file and rerun check.",
    type: issue.type ?? "check-issue"
  }));
}

function projectPreviewToState(preview: DesktopProjectPreview): {
  project: ProjectSummary;
  slides: SlideSummary[];
} {
  return {
    project: {
      ...projectRecordToSummary(preview.project),
      exportOptions: preview.exportOptions
    },
    slides: preview.slides
  };
}

function checkpointDiffToReview(
  diff: FileCopyCheckpointDiff,
  options: {
    open: boolean;
    reverting?: boolean;
    statusMessage?: string;
  }
): AgentDiffReview {
  return {
    open: options.open,
    runId: diff.checkpoint.runId,
    checkpointId: diff.checkpoint.id,
    summary: diff.summary,
    changedFiles: diff.changed.map((file) => file.path),
    addedFiles: diff.added.map((file) => file.path),
    deletedFiles: diff.deleted.map((file) => file.path),
    unchangedFiles: diff.unchanged.map((file) => file.path),
    textDiffs: diff.textDiffs,
    canRevert: diff.checkpoint.restore.canRevert,
    reverting: options.reverting,
    statusMessage: options.statusMessage
  };
}

function App(): React.ReactNode {
  const [view, setView] = useState<AppView>("onboarding");
  const [librarySection, setLibrarySection] = useState<LibrarySection>("recent");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [workspacePath, setWorkspacePath] = useState<string | undefined>();
  const [projects, setProjects] = useState<ProjectSummary[]>(sampleProjects);
  const [projectPreviews, setProjectPreviews] = useState<Record<string, DesktopProjectPreview>>({});
  const [selectedProjectId, setSelectedProjectId] = useState(sampleProjects[0]?.id ?? "demo-alpha");
  const [activeSlides, setActiveSlides] = useState<SlideSummary[]>(sampleSlides);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [selectedSlideId, setSelectedSlideId] = useState(sampleSlides[0]?.id ?? "");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("qa");
  const [qaFilter, setQaFilter] = useState<QaFilter>("all");
  const [qaIssues, setQaIssues] = useState<QaIssue[]>([]);
  const [qaCheckStatus, setQaCheckStatus] = useState<QaCheckStatus>("not-checked");
  const [commandValue, setCommandValue] = useState("");
  const [running, setRunning] = useState(false);
  const [activeStageIndex, setActiveStageIndex] = useState(4);
  const [operationStatus, setOperationStatus] = useState<OperationStatus>(idleStatus);
  const [notesSaveStatus, setNotesSaveStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "No note edits"
  });
  const [commandActionStatuses, setCommandActionStatuses] = useState<CommandActionStatuses>(() =>
    defaultCommandActionStatuses()
  );
  const [diffReview, setDiffReview] = useState<AgentDiffReview | undefined>();
  const [agentRunEvents, setAgentRunEvents] = useState<AgentRunEventLike[]>([]);
  const [agentRunLogs, setAgentRunLogs] = useState<AgentRunLogLike[]>([]);
  const [agentRunSnapshot, setAgentRunSnapshot] = useState<DesktopAgentRunSnapshot | undefined>();
  const [agentCancelPendingRunId, setAgentCancelPendingRunId] = useState<string | undefined>();
  const agentRunSnapshotRef = useRef<DesktopAgentRunSnapshot | undefined>(undefined);
  const agentStartPendingRef = useRef(false);
  const appliedTerminalResultRunIdsRef = useRef(new Set<string>());
  const handledTerminalSnapshotRunIdsRef = useRef(new Set<string>());
  const [aiEngineSettings, setAiEngineSettings] = useState<AiEngineSettings>(() => createDefaultAiEngineSettings());
  const aiEngineSettingsTouchedRef = useRef(false);
  const [cliIntegration, setCliIntegration] = useState<DesktopCliIntegrationState | undefined>();
  const [cliIntegrationStatus, setCliIntegrationStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "CLI integration not checked"
  });
  const [officialSkills, setOfficialSkills] = useState<DesktopOfficialSkillsState | undefined>();
  const [officialSkillsStatus, setOfficialSkillsStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "Official skills not checked"
  });
  const [externalAgentStatuses, setExternalAgentStatuses] = useState<ExternalAgentStatus[]>(() =>
    createDefaultExternalAgentStatuses()
  );
  const [externalAgentConnection, setExternalAgentConnection] = useState<DesktopExternalAgentConnectionState>();
  const [projectAgentSkillsStatus, setProjectAgentSkillsStatus] = useState<DesktopProjectAgentSkillsState>();
  const [aiEngineStatus, setAiEngineStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "No AI mode"
  });
  const [directPresenterOpen, setDirectPresenterOpen] = useState<DirectPresenterOpen | undefined>();
  const latestOpenRequestIdRef = useRef(Number.NEGATIVE_INFINITY);
  const latestOpenRequestPathRef = useRef<string | undefined>(undefined);
  const openRequestEpochRef = useRef(0);
  const latestDeckPackageOpenResultRef = useRef<DesktopPresenterDeckResult | undefined>(undefined);
  const smokeExpectedDeckPackagePathRef = useRef<string | undefined>(undefined);
  const smokeDeckPackageReportedRef = useRef(false);
  const desktopApi = getDesktopApi();

  const resetWorkspaceRuntime = useCallback((): void => {
    agentRunSnapshotRef.current = undefined;
    appliedTerminalResultRunIdsRef.current.clear();
    handledTerminalSnapshotRunIdsRef.current.clear();
    setAgentRunSnapshot(undefined);
    setAgentRunEvents([]);
    setAgentRunLogs([]);
    setAgentCancelPendingRunId(undefined);
    setActiveStageIndex(0);
    setRunning(false);
    setQaCheckStatus("not-checked");
    setQaIssues([]);
    setDiffReview(undefined);
    setCommandActionStatuses(defaultCommandActionStatuses());
  }, []);

  const beginOpenRequest = useCallback((path: string, requestId: number | undefined): boolean => {
    if (requestId !== undefined && requestId <= latestOpenRequestIdRef.current) {
      return false;
    }
    if (requestId !== undefined) {
      latestOpenRequestIdRef.current = requestId;
    }
    latestOpenRequestPathRef.current = path;
    openRequestEpochRef.current += 1;
    return true;
  }, []);

  const isCurrentOpenRequest = useCallback(
    (requestId: number | undefined): boolean => requestId === undefined || requestId === latestOpenRequestIdRef.current,
    []
  );

  const applyDeckPackageOpenResult = useCallback((
    result: DesktopPresenterDeckResult,
    baseProjects?: ProjectSummary[]
  ): void => {
    if (result.ok) {
      const next = presenterDeckToWorkspaceState(result.deck, result.deckpkgPath);
      setProjects((current) => [
        next.project,
        ...(baseProjects ?? current).filter((project) => project.id !== next.project.id)
      ]);
      setSelectedProjectId(next.project.id);
      setActiveSlides(next.slides);
      setSelectedSlideId(next.slides[0]?.id ?? "");
      resetWorkspaceRuntime();
      setDirectPresenterOpen({
        id: `${result.deckpkgPath}:${result.deck.slides.length}:${Date.now()}`,
        source: "deckpkg-file",
        deckpkgPath: result.deckpkgPath,
        deck: result.deck
      });
      setView("workspace");
      setOperationStatus({ kind: "success", message: "Deck package opened" });
      setCommandActionStatuses((current) => ({
        ...current,
        export: { kind: "success", message: "Deck package file" },
        review: { kind: "success", message: "Deck package ready" }
      }));
      return;
    }

    setOperationStatus({ kind: "failed", message: result.error });
    setView("library");
    setCommandActionStatuses((current) => ({
      ...current,
      review: { kind: "failed", message: result.source === "missing" ? "Deck package missing" : "Deck package invalid" }
    }));
  }, [resetWorkspaceRuntime]);

  const reportSmokeReady = useCallback(
    async (marker: DesktopSmokeReadyMarker): Promise<void> => {
      await desktopApi?.reportSmokeReady(marker);
    },
    [desktopApi]
  );

  const reportDeckPackageSmokeResult = useCallback(
    async (result: DesktopPresenterDeckResult): Promise<void> => {
      const expectedDeckpkgPath = smokeExpectedDeckPackagePathRef.current;
      if (!expectedDeckpkgPath || smokeDeckPackageReportedRef.current) {
        return;
      }

      smokeDeckPackageReportedRef.current = true;
      await reportSmokeReady(
        result.ok
          ? {
              status: "passed",
              kind: "deckpkg-open",
              deckpkgPath: result.deckpkgPath,
              expectedDeckpkgPath,
              title: result.deck.title,
              slideCount: result.deck.slides.length
            }
          : {
              status: "failed",
              kind: "deckpkg-open",
              expectedDeckpkgPath,
              error: result.error
            }
      );
    },
    [reportSmokeReady]
  );

  const openDeckPackagePath = useCallback(
    async (
      deckpkgPath: string,
      baseProjects?: ProjectSummary[],
      requestId?: number
    ): Promise<DesktopPresenterDeckResult | undefined> => {
      if (!beginOpenRequest(deckpkgPath, requestId)) {
        return undefined;
      }
      if (!desktopApi) {
        if (isCurrentOpenRequest(requestId)) {
          setOperationStatus({ kind: "failed", message: "Desktop API unavailable" });
        }
        return undefined;
      }

      setOperationStatus({ kind: "running", message: "Opening deck package" });
      const result = await desktopApi.loadPresenterDeckPackage(deckpkgPath);
      latestDeckPackageOpenResultRef.current = result;
      if (isCurrentOpenRequest(requestId)) {
        applyDeckPackageOpenResult(result, baseProjects);
      }
      await reportDeckPackageSmokeResult(result);
      return result;
    },
    [applyDeckPackageOpenResult, beginOpenRequest, desktopApi, isCurrentOpenRequest, reportDeckPackageSmokeResult]
  );

  const openPreview = useCallback((preview: DesktopProjectPreview): void => {
    const next = projectPreviewToState(preview);
    setDirectPresenterOpen(undefined);
    setProjectPreviews((current) => ({
      ...current,
      [next.project.id]: preview
    }));
    setProjects((current) => {
      const existing = current.filter((project) => project.id !== next.project.id);
      return [next.project, ...existing];
    });
    setSelectedProjectId(next.project.id);
    setActiveSlides(next.slides);
    setSelectedSlideId(next.slides[0]?.id ?? "");
    resetWorkspaceRuntime();
    setOperationStatus({
      kind: "success",
      message: "Project loaded"
    });
    setView("workspace");
  }, [resetWorkspaceRuntime]);

  const openProjectPath = useCallback(
    async (projectPath: string, requestId?: number): Promise<DesktopProjectPreview | undefined> => {
      if (!beginOpenRequest(projectPath, requestId)) {
        return undefined;
      }
      if (!desktopApi) {
        if (isCurrentOpenRequest(requestId)) {
          setOperationStatus({ kind: "failed", message: "Desktop API unavailable" });
        }
        return undefined;
      }

      setOperationStatus({ kind: "running", message: "Loading project" });
      try {
        const preview = await desktopApi.loadProject(projectPath);
        if (isCurrentOpenRequest(requestId)) {
          openPreview(preview);
        }
        return preview;
      } catch (error) {
        if (!isCurrentOpenRequest(requestId)) {
          return undefined;
        }
        await desktopApi.markRecentProjectMissing({ path: projectPath })
          .then((records) => setProjects(projectRecordsToSummaries(records)))
          .catch(() => undefined);
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        setView("library");
        return undefined;
      }
    },
    [beginOpenRequest, desktopApi, isCurrentOpenRequest, openPreview]
  );

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    let cancelled = false;
    let smokeFailureTimer: number | undefined;
    const startingOpenRequestEpoch = openRequestEpochRef.current;
    Promise.all([desktopApi.getSetup(), desktopApi.listProjects(), desktopApi.getAiEngineSettings()])
      .then(async ([setup, records, settings]) => {
        if (cancelled) {
          return;
        }
        const projectSummaries = projectRecordsToSummaries(records);
        setWorkspacePath(setup.workspacePath);
        if (setup.onboardingCompleted && !setup.initialOpen) {
          setView("library");
        }
        setProjects((current) => {
          if (openRequestEpochRef.current === startingOpenRequestEpoch) {
            return projectSummaries;
          }

          const openedProject = current.find((project) => project.path === latestOpenRequestPathRef.current);
          return openedProject
            ? [openedProject, ...projectSummaries.filter((project) => project.id !== openedProject.id)]
            : projectSummaries;
        });
        if (!aiEngineSettingsTouchedRef.current) {
          setAiEngineSettings(normalizeAiEngineSettings(settings));
        }
        setCliIntegration(setup.cliIntegration);
        setOfficialSkills(setup.officialSkills);
        setCliIntegrationStatus({
          kind: setup.cliIntegration.status === "failed" ? "failed" : setup.cliIntegration.installed ? "success" : "idle",
          message: setup.cliIntegration.message
        });
        setOfficialSkillsStatus({
          kind: setup.officialSkills.status === "failed" ? "failed" : setup.officialSkills.installed ? "success" : "idle",
          message: setup.officialSkills.message
        });
        setOperationStatus({
          kind: setup.cli.available ? "success" : "failed",
          message: setup.cli.available ? "CLI available" : "CLI unavailable"
        });
        setAiEngineStatus({
          kind: "success",
          message: "AI engine settings loaded"
        });

        const expectedDeckpkgPath = setup.smoke?.expectOpenDeckpkgPath;
        if (expectedDeckpkgPath) {
          smokeExpectedDeckPackagePathRef.current = expectedDeckpkgPath;
          const latestOpenResult = latestDeckPackageOpenResultRef.current;
          if (latestOpenResult) {
            await reportDeckPackageSmokeResult(latestOpenResult);
          }
        }

        if (setup.initialOpen?.kind === "project") {
          await openProjectPath(setup.initialOpen.path, setup.initialOpen.requestId);
          if (cancelled) {
            return;
          }
        } else if (setup.initialOpen?.kind === "deckpkg") {
          await openDeckPackagePath(
            setup.initialOpen.path,
            projectSummaries,
            setup.initialOpen.requestId
          );
          if (cancelled) {
            return;
          }
        }

        if (expectedDeckpkgPath && !smokeDeckPackageReportedRef.current) {
          smokeFailureTimer = window.setTimeout(() => {
            if (smokeDeckPackageReportedRef.current) {
              return;
            }
            smokeDeckPackageReportedRef.current = true;
            void reportSmokeReady({
              status: "failed",
              kind: "deckpkg-open",
              expectedDeckpkgPath,
              error: "Packaged smoke did not receive a deckpkg open result."
            });
          }, 10_000);
        }

        return desktopApi.detectExternalAgents();
      })
      .then((statuses) => {
        if (cancelled || !statuses) {
          return;
        }
        setExternalAgentStatuses(statuses);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        setAiEngineStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        setCliIntegrationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        setOfficialSkillsStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });

    return () => {
      cancelled = true;
      if (smokeFailureTimer !== undefined) {
        window.clearTimeout(smokeFailureTimer);
      }
    };
  }, [desktopApi, openDeckPackagePath, openProjectPath, reportDeckPackageSmokeResult, reportSmokeReady]);

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    return desktopApi.onOpenRequest((request) => {
      if (request.kind === "deckpkg") {
        void openDeckPackagePath(request.path, undefined, request.requestId);
      } else {
        void openProjectPath(request.path, request.requestId);
      }
    });
  }, [desktopApi, openDeckPackagePath, openProjectPath]);

  useEffect(() => {
    if (!running || agentRunEvents.length > 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveStageIndex((current) => getNextStageIndex(current, agentStages.length));
    }, 2800);

    return () => window.clearInterval(timer);
  }, [agentRunEvents.length, running]);

  const updateCommandActionStatus = useCallback((action: CommandAction, status: OperationStatus): void => {
    setCommandActionStatuses((current) => ({
      ...current,
      [action]: status
    }));
  }, []);

  const seedMockAgentRun = useCallback((summary: string): void => {
    const runId = `mock-${Date.now()}`;
    const createdAt = nowIso();
    setAgentRunEvents([
      {
        createdAt,
        nextAction: "Build slide source",
        runId,
        sequence: 1,
        stage: "brief",
        status: "succeeded",
        summary: "Command accepted for local mock generation.",
        type: "run-created"
      },
      {
        createdAt,
        filesChanged: ["slides/outline.json"],
        nextAction: "Run check",
        runId,
        sequence: 2,
        stage: "build",
        status: "running",
        summary,
        type: "stage-started"
      }
    ]);
    setAgentRunLogs([
      {
        createdAt,
        level: "info",
        message: "Desktop agent service is not connected; showing mock run state.",
        runId,
        stage: "brief"
      },
      {
        createdAt,
        level: "info",
        message: summary,
        runId,
        stage: "build"
      }
    ]);
  }, []);

  const applyAgentRunResult = useCallback(
    (
      result: DesktopAgentRunResult,
      terminalStatus: Extract<DesktopAgentRunStatus, "succeeded" | "failed" | "cancelled">
    ): void => {
      const checkReport = result.check?.json as DesktopCheckReport | undefined;
      const repairs = result.providerId === "external-agent" ? [] : result.agent?.outputs.repairs ?? [];
      const checkErrors = result.summary.checkErrors ?? 0;
      const checkWarnings = result.summary.checkWarnings ?? 0;
      const agentLabel =
        result.providerId === "external-agent"
          ? "External agent"
          : result.providerId === "htmlslide-byok"
            ? "HTMLslide Agent"
            : "Mock agent";
      const generationOk = result.providerId === "external-agent" ? result.adapter?.ok === true : result.agent?.ok === true;
      const cancelled = terminalStatus === "cancelled";

      if (result.project) {
        const generatedPreview = result.project;
        const next = projectPreviewToState(generatedPreview);
        setProjectPreviews((current) => ({
          ...current,
          [next.project.id]: generatedPreview
        }));
        setProjects((current) => {
          const existing = current.filter((project) => project.id !== next.project.id);
          return [next.project, ...existing];
        });
        setSelectedProjectId(next.project.id);
        setActiveSlides(next.slides);
        setSelectedSlideId((current) =>
          next.slides.some((slide) => slide.id === current) ? current : next.slides[0]?.id ?? ""
        );
      }

      setAgentRunEvents(result.events);
      setAgentRunLogs(result.logs);
      setQaIssues(reportToIssues(checkReport));
      setDiffReview(
        result.checkpointDiff
          ? checkpointDiffToReview(result.checkpointDiff, {
              open: result.ok,
              statusMessage: result.ok
                ? "Generated source changes are ready for review or checkpoint revert."
                : "Generated source changes need review before export."
            })
          : undefined
      );
      setRunning(false);
      setQaCheckStatus(
        result.check
          ? result.check.ok
            ? "passed"
            : "failed"
          : "not-checked"
      );
      setOperationStatus({
        kind: result.ok && !cancelled ? "success" : "failed",
        message: cancelled
          ? `${agentLabel} cancelled`
          : result.ok
          ? `${agentLabel} completed check and export`
          : result.check?.ok === false
            ? `${agentLabel} completed, but check found issues`
            : result.export?.ok === false
              ? `${agentLabel} completed, but export failed`
              : `${agentLabel} run failed`
      });
      updateCommandActionStatus("generate", {
        kind: generationOk && !cancelled ? "success" : "failed",
        message: cancelled
          ? "Generation cancelled"
          : generationOk
          ? result.providerId === "external-agent"
            ? "External agent complete"
            : result.providerId === "htmlslide-byok"
              ? "HTMLslide Agent complete"
              : "Mock generation complete"
          : result.providerId === "external-agent"
            ? "External agent failed"
            : result.providerId === "htmlslide-byok"
              ? "HTMLslide Agent failed"
              : "Mock generation failed"
      });
      updateCommandActionStatus("check", {
        kind: result.check?.ok ? "success" : result.check ? "failed" : "idle",
        message: result.check
          ? result.check.ok
            ? `Check passed (${checkWarnings} warnings)`
            : `Check failed (${checkErrors} errors)`
          : "Check skipped"
      });
      updateCommandActionStatus("repair", {
        kind: repairs.length > 0 ? "success" : "idle",
        message: repairs.length > 0 ? `${repairs.length} repair pass` : "No repair needed"
      });
      updateCommandActionStatus("export", {
        kind: result.export?.ok ? "success" : result.export ? "failed" : "idle",
        message: result.export
          ? result.export.ok
            ? `${result.summary.exportArtifacts.length} artifacts`
            : "Export failed"
          : "Export skipped"
      });
      updateCommandActionStatus("review", {
        kind: result.ok && !cancelled ? "success" : "failed",
        message: cancelled ? "Run cancelled" : result.ok ? "Ready for review" : "Review required"
      });
    },
    [updateCommandActionStatus]
  );

  const applyAgentRunSnapshot = useCallback(
    (snapshot: DesktopAgentRunSnapshot, options: { replaceRun?: boolean } = {}): void => {
      const current = agentRunSnapshotRef.current;
      const sameRun = current?.runId === snapshot.runId;
      if (!current && !options.replaceRun) {
        return;
      }
      if (current && !sameRun && !options.replaceRun) {
        return;
      }
      if (sameRun && !activeAgentRunStatuses.has(current.status) && activeAgentRunStatuses.has(snapshot.status)) {
        return;
      }
      if (sameRun && snapshot.sequence <= current.sequence) {
        return;
      }

      agentRunSnapshotRef.current = snapshot;
      setAgentRunSnapshot(snapshot);
      setAgentRunEvents(snapshot.events);
      setAgentRunLogs(snapshot.logs);

      const isActive = activeAgentRunStatuses.has(snapshot.status);
      setRunning(isActive);
      const agentLabel = agentEngineLabel(snapshot.engine);

      if (isActive) {
        const cancelling = snapshot.status === "cancelling";
        setOperationStatus({
          kind: "running",
          message: cancelling ? `Cancelling ${agentLabel}` : `Running ${agentLabel}`
        });
        updateCommandActionStatus("generate", {
          kind: "running",
          message: cancelling ? "Cancelling generation" : `${agentLabel} running`
        });
        return;
      }

      if (snapshot.result && !appliedTerminalResultRunIdsRef.current.has(snapshot.runId)) {
        appliedTerminalResultRunIdsRef.current.add(snapshot.runId);
        applyAgentRunResult(
          snapshot.result,
          snapshot.status as Extract<DesktopAgentRunStatus, "succeeded" | "failed" | "cancelled">
        );
        return;
      }

      if (handledTerminalSnapshotRunIdsRef.current.has(snapshot.runId)) {
        return;
      }
      handledTerminalSnapshotRunIdsRef.current.add(snapshot.runId);

      if (snapshot.status === "cancelled") {
        setOperationStatus({ kind: "failed", message: `${agentLabel} cancelled` });
        updateCommandActionStatus("generate", { kind: "failed", message: "Generation cancelled" });
        return;
      }

      if (snapshot.status === "failed") {
        const message = snapshot.error ?? `${agentLabel} run failed`;
        setOperationStatus({ kind: "failed", message });
        updateCommandActionStatus("generate", { kind: "failed", message });
        return;
      }

      setOperationStatus({ kind: "success", message: `${agentLabel} completed` });
      updateCommandActionStatus("generate", { kind: "success", message: `${agentLabel} complete` });
    },
    [applyAgentRunResult, updateCommandActionStatus]
  );

  const agentRunUpdateHandlerRef = useRef(applyAgentRunSnapshot);
  agentRunUpdateHandlerRef.current = applyAgentRunSnapshot;

  useEffect(() => {
    if (!desktopApi) {
      return;
    }
    return desktopApi.onAgentRunUpdate((snapshot) => agentRunUpdateHandlerRef.current(snapshot));
  }, [desktopApi]);

  const startAgentGeneration = useCallback(
    (brief: string, options: {
      engine?: DesktopAgentEngine;
      exportSelection?: NewDeckExportSelection;
      forceMock?: boolean;
      projectPath?: string;
      speakerNotesMode?: NewDeckDraft["speakerNotes"];
      targetSlideCount?: number;
    } = {}): void => {
      const currentSnapshot = agentRunSnapshotRef.current;
      if (agentStartPendingRef.current || (currentSnapshot && activeAgentRunStatuses.has(currentSnapshot.status))) {
        return;
      }
      const trimmedBrief = brief.trim();
      const prompt = trimmedBrief.length > 0 ? trimmedBrief : "Create or revise this HTMLslide deck.";
      const selectedEngine: DesktopAgentEngine = options.forceMock
        ? "mock-agent"
        : options.engine ?? selectedAgentEngine(aiEngineSettings);
      const agentLabel = agentEngineLabel(selectedEngine);

      if (selectedEngine === "mock-agent" && !options.forceMock && aiEngineSettings.mode === "no-ai") {
        const message = "AI generation is disabled in No AI mode. Choose an AI engine in Settings or start a Local Mock deck from New Deck.";
        setOperationStatus({ kind: "failed", message });
        updateCommandActionStatus("generate", { kind: "failed", message: "No AI mode" });
        return;
      }

      agentStartPendingRef.current = true;
      setRunning(true);
      setActiveStageIndex(0);
      setInspectorTab("qa");
      setQaCheckStatus("not-checked");
      setQaIssues([]);
      setAgentRunEvents([]);
      setAgentRunLogs([]);
      setDiffReview(undefined);
      setCommandActionStatuses({
        ...defaultCommandActionStatuses(),
        generate: {
          kind: "running",
          message: `${agentLabel} running`
        },
        review: {
          kind: "idle",
          message: "Waiting for generated result"
        }
      });

      if (!desktopApi || !options.projectPath) {
        seedMockAgentRun(
          !desktopApi
            ? `${agentLabel} running for: ${prompt}`
            : `Open a local deck project before running the ${agentLabel}.`
        );
        if (desktopApi && !options.projectPath) {
          updateCommandActionStatus("generate", { kind: "failed", message: "Local project required" });
          setOperationStatus({ kind: "failed", message: "Open a local deck project before Generate" });
          setRunning(false);
        }
        agentStartPendingRef.current = false;
        return;
      }

      setOperationStatus({ kind: "running", message: `Running ${agentLabel}` });
      desktopApi.startAgentRun({
        brief: prompt,
        engine: selectedEngine,
        exportOptions: options.exportSelection,
        projectPath: options.projectPath,
        speakerNotesMode: options.speakerNotesMode,
        targetSlideCount: options.targetSlideCount,
        runExport: true
      })
        .then(async (snapshot) => {
          applyAgentRunSnapshot(snapshot, { replaceRun: true });
          const latest = await desktopApi.getAgentRun(snapshot.runId);
          if (latest) {
            applyAgentRunSnapshot(latest);
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setRunning(false);
          setOperationStatus({ kind: "failed", message });
          updateCommandActionStatus("generate", { kind: "failed", message });
        })
        .finally(() => {
          agentStartPendingRef.current = false;
        });
    },
    [aiEngineSettings, applyAgentRunSnapshot, desktopApi, seedMockAgentRun, updateCommandActionStatus]
  );

  const cancelAgentGeneration = useCallback((): void => {
    const snapshot = agentRunSnapshotRef.current;
    if (!desktopApi || !snapshot?.canCancel || agentCancelPendingRunId === snapshot.runId) {
      return;
    }

    const { runId } = snapshot;
    setAgentCancelPendingRunId(runId);
    setOperationStatus({ kind: "running", message: `Cancelling ${agentEngineLabel(snapshot.engine)}` });
    updateCommandActionStatus("generate", { kind: "running", message: "Cancelling generation" });

    const beforeCancel = (window as AgentCancelE2EWindow).__HTMLSLIDE_E2E_BEFORE_AGENT_CANCEL__;
    Promise.resolve(beforeCancel?.(runId))
      .then(() => desktopApi.cancelAgentRun(runId))
      .then((nextSnapshot) => applyAgentRunSnapshot(nextSnapshot))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setOperationStatus({ kind: "failed", message });
        updateCommandActionStatus("generate", { kind: "failed", message });
        void desktopApi.getAgentRun(runId)
          .then((latest) => {
            if (latest) {
              applyAgentRunSnapshot(latest);
            }
          })
          .catch(() => undefined);
      })
      .finally(() => {
        setAgentCancelPendingRunId((current) => current === runId ? undefined : current);
      });
  }, [agentCancelPendingRunId, applyAgentRunSnapshot, desktopApi, updateCommandActionStatus]);

  const chooseVisualDirection = useCallback((directionId: string): void => {
    const snapshot = agentRunSnapshotRef.current;
    if (!desktopApi || !snapshot || String(snapshot.status) !== "awaiting-user-choice") {
      return;
    }

    setOperationStatus({ kind: "running", message: "Selecting visual direction" });
    desktopApi.chooseVisualDirection(snapshot.runId, directionId)
      .then((nextSnapshot) => applyAgentRunSnapshot(nextSnapshot))
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [applyAgentRunSnapshot, desktopApi]);

  const retryAgentGeneration = useCallback((): void => {
    const snapshot = agentRunSnapshotRef.current;
    if (
      !desktopApi ||
      !snapshot?.canRetry ||
      (snapshot.status !== "failed" && snapshot.status !== "cancelled") ||
      agentStartPendingRef.current
    ) {
      return;
    }

    agentStartPendingRef.current = true;
    setRunning(true);
    setAgentCancelPendingRunId(undefined);
    setDiffReview(undefined);
    setOperationStatus({ kind: "running", message: `Retrying ${agentEngineLabel(snapshot.engine)}` });
    setCommandActionStatuses({
      ...defaultCommandActionStatuses(),
      generate: { kind: "running", message: `Retrying ${agentEngineLabel(snapshot.engine)}` },
      review: { kind: "idle", message: "Waiting for retried result" }
    });

    desktopApi.retryAgentRun(snapshot.runId)
      .then(async (nextSnapshot) => {
        applyAgentRunSnapshot(nextSnapshot, { replaceRun: true });
        const latest = await desktopApi.getAgentRun(nextSnapshot.runId);
        if (latest) {
          applyAgentRunSnapshot(latest);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setRunning(false);
        setOperationStatus({ kind: "failed", message });
        updateCommandActionStatus("generate", { kind: "failed", message });
      })
      .finally(() => {
        agentStartPendingRef.current = false;
      });
  }, [applyAgentRunSnapshot, desktopApi, updateCommandActionStatus]);

  const copyAgentRepairPrompt = useCallback((): void => {
    const snapshot = agentRunSnapshotRef.current;
    if (!desktopApi || !snapshot) {
      return;
    }
    const result = snapshot.result;
    const checkReport = result?.check?.json as DesktopCheckReport | undefined;
    const checkSummary = checkReport?.summary;
    const checkStatus = checkReport?.status ?? (result?.check ? (result.check.ok ? "passed" : "failed") : undefined);
    const prompt = buildAgentRepairPrompt({
      checkErrors: checkSummary?.errors ?? result?.summary.checkErrors,
      checkStatus,
      checkWarnings: checkSummary?.warnings ?? result?.summary.checkWarnings,
      engine: agentEngineLabel(snapshot.engine),
      error: snapshot.error ?? (result && "error" in result ? result.error : undefined),
      filesChanged: agentResultChangedFiles(result),
      runId: snapshot.runId,
      status: snapshot.status
    });
    desktopApi.copyAgentRepairPrompt(prompt)
      .then(() => setOperationStatus({ kind: "success", message: "Repair prompt copied" }))
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : "Could not copy repair prompt"
        });
      });
  }, [desktopApi]);

  const activeProject = useMemo(() => {
    const selectedPreview = projectPreviews[selectedProjectId];
    return selectedPreview
      ? projectRecordToSummary(selectedPreview.project)
      : projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? sampleProjects[0];
  }, [projectPreviews, projects, selectedProjectId]);
  const activeProjectIsDeckPackage = Boolean(
    directPresenterOpen && activeProject?.path === directPresenterOpen.deckpkgPath
  );
  const activeProjectPath = activeProject && !activeProject.path.startsWith("~") && !activeProjectIsDeckPackage
    ? activeProject.path
    : undefined;

  const handleTestExternalAgent = useCallback((agentId: ExternalAgentId): void => {
    if (!desktopApi || !activeProjectPath) {
      setAiEngineStatus({ kind: "failed", message: "Project connection requires a local deck project" });
      return;
    }

    setAiEngineStatus({ kind: "running", message: "Testing project connection" });
    desktopApi.testExternalAgent({ projectPath: activeProjectPath, agentId })
      .then((result) => {
        setExternalAgentConnection(result);
        setProjectAgentSkillsStatus(result.projectSkills);
        setExternalAgentStatuses((current) => current.map((status) => status.id === result.agentId ? result.agent : status));
        setAiEngineStatus({
          kind: result.status === "failed" ? "failed" : result.status === "ready" ? "success" : "idle",
          message: result.status === "ready" ? "Project connection ready" : result.agent.summary
        });
      })
      .catch((error: unknown) => {
        setAiEngineStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [activeProjectPath, desktopApi]);

  const handleInstallProjectAgentSkills = useCallback((agentId: ExternalAgentId): void => {
    if (!desktopApi || !activeProjectPath) {
      setAiEngineStatus({ kind: "failed", message: "Project skills require a local deck project" });
      return;
    }
    if (agentId !== "claude-code" && agentId !== "codex-cli") {
      setAiEngineStatus({ kind: "failed", message: "Project skills are supported for Claude Code and Codex CLI" });
      return;
    }

    setAiEngineStatus({ kind: "running", message: "Installing project skills" });
    desktopApi.installProjectAgentSkills({ projectPath: activeProjectPath, agentId })
      .then((result) => {
        setProjectAgentSkillsStatus(result);
        setExternalAgentConnection((current) => current?.projectPath === activeProjectPath && current.agentId === agentId
          ? { ...current, projectSkills: result, status: current.agent.status === "ready" ? "ready" : "warning" }
          : current);
        setAiEngineStatus({ kind: result.status === "passed" ? "success" : "idle", message: result.message });
      })
      .catch((error: unknown) => {
        setAiEngineStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [activeProjectPath, desktopApi]);

  const handleSaveSlideNotes = useCallback(
    async (slideId: string, content: string): Promise<boolean> => {
      if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
        setNotesSaveStatus({ kind: "failed", message: "Speaker notes require a local project." });
        return false;
      }

      setNotesSaveStatus({ kind: "running", message: "Saving speaker notes" });
      try {
        await desktopApi.saveSlideNotes(activeProject.path, slideId, content);
        const updateSlide = (slide: SlideSummary): SlideSummary =>
          slide.id === slideId ? { ...slide, speakerNotes: content } : slide;
        setActiveSlides((current) => current.map(updateSlide));
        setProjectPreviews((current) => {
          const preview = current[activeProject.id];
          if (!preview) {
            return current;
          }
          return {
            ...current,
            [activeProject.id]: {
              ...preview,
              project: { ...preview.project, status: "Needs check" },
              slides: preview.slides.map(updateSlide)
            }
          };
        });
        setProjects((current) => current.map((project) =>
          project.id === activeProject.id ? { ...project, status: "Needs check" } : project
        ));
        setPreviewRevision((current) => current + 1);
        setNotesSaveStatus({ kind: "success", message: "Speaker notes saved" });
        return true;
      } catch (error: unknown) {
        setNotesSaveStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [activeProject, activeProjectIsDeckPackage, desktopApi]
  );

  const handleFixQaIssue = useCallback(
    (issue: QaIssue): void => {
      if (running) {
        setOperationStatus({ kind: "failed", message: "Finish the active agent run before starting a QA repair." });
        return;
      }
      setSelectedSlideId(issue.slideId);
      startAgentGeneration([
        "Fix one HTMLslide QA issue in the existing project.",
        `Scope: slide ${issue.slideId}`,
        `Issue type: ${issue.type}`,
        `Location: ${issue.selector}`,
        `Report: ${issue.message}`,
        `Suggested fix: ${issue.suggestedFix}`,
        "Constraints:",
        "- Keep the slide id unchanged.",
        "- Keep the fixed 1920x1080 viewport and project source boundary.",
        "- Do not edit exports/ or .htmlslide/.",
        "- Run htmlslide check after the repair."
      ].join("\n"), {
        projectPath: activeProject?.path
      });
    },
    [activeProject?.path, running, startAgentGeneration]
  );

  useEffect(() => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      return;
    }
    let disposed = false;
    void desktopApi.getActiveAgentRun(activeProject.path)
      .then((snapshot) => {
        if (!disposed && snapshot) {
          applyAgentRunSnapshot(snapshot, { replaceRun: true });
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [activeProject, activeProjectIsDeckPackage, applyAgentRunSnapshot, desktopApi]);

  const handleOpenProject = useCallback(
    (projectId: string): void => {
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        return;
      }

      setDirectPresenterOpen(undefined);
      setSelectedProjectId(projectId);
      const cachedPreview = projectPreviews[projectId];
      if (!desktopApi || project.path.startsWith("~")) {
        const next = cachedPreview ? projectPreviewToState(cachedPreview) : undefined;
        const fallbackSlides = next?.slides ?? sampleSlides;
        setActiveSlides(fallbackSlides);
        setSelectedSlideId(fallbackSlides[0]?.id ?? "");
        setView("workspace");
        return;
      }

      setOperationStatus({ kind: "running", message: "Loading project" });
      desktopApi.loadProject(project.path)
        .then(openPreview)
        .catch(async (error: unknown) => {
          await desktopApi.markRecentProjectMissing({
            id: project.id,
            path: project.path
          })
            .then((records) => setProjects(projectRecordsToSummaries(records)))
            .catch(() => {
              setProjects((current) => current.map((item) =>
                item.id === project.id
                  ? {
                      ...item,
                      status: "Missing files"
                    }
                  : item
              ));
            });
          setOperationStatus({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
          setView("library");
        });
    },
    [desktopApi, openPreview, projectPreviews, projects]
  );

  const handleBackToLibrary = useCallback((): void => {
    setDirectPresenterOpen(undefined);
    setLibrarySection("recent");
    setView("library");
  }, []);

  const handleRemoveProject = useCallback((projectId: string): void => {
    const removedProject = projects.find((project) => project.id === projectId);
    setProjectPreviews((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });

    if (!desktopApi) {
      setProjects((current) => current.filter((project) => project.id !== projectId));
      return;
    }

    desktopApi.removeRecentProject({
      id: removedProject?.id ?? projectId,
      path: removedProject?.path
    })
      .then((records) => {
        setProjects(projectRecordsToSummaries(records));
        setOperationStatus({
          kind: "success",
          message: removedProject ? `Removed ${removedProject.title} from recent projects` : "Recent project removed"
        });
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi, projects]);

  const handleOpenFolder = useCallback((): void => {
    if (!desktopApi) {
      setOperationStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }
    setOperationStatus({ kind: "running", message: "Opening folder" });
    desktopApi.openProjectDialog()
      .then((preview) => {
        if (preview) {
          openPreview(preview);
          return;
        }
        setOperationStatus({ kind: "idle", message: "Open cancelled" });
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi, openPreview]);

  const handleChooseSourceFiles = useCallback(async (): Promise<DesktopSourceFileSelection[]> => {
    if (!desktopApi) {
      return [];
    }
    return desktopApi.chooseSourceFiles();
  }, [desktopApi]);

  const handleNewDeck = useCallback((draft: NewDeckDraft): void => {
    if (!desktopApi) {
      handleOpenProject(sampleProjects[0]?.id ?? "demo-alpha");
      return;
    }

    setOperationStatus({ kind: "running", message: "Creating deck" });
    desktopApi.createProject({
      ...draft,
      exportOptions: newDeckManifestExportOptionsFromOutputs(draft.outputs),
      speakerNotesMode: draft.speakerNotes,
      workspacePath
    })
      .then((result) => {
        if (!result.ok || !result.project) {
          setOperationStatus({
            kind: "failed",
            message: result.error ?? `htmlslide new exited with ${result.exitCode}`
          });
          return;
        }
        openPreview(result.project);
        if (draft.generationMode !== "no-ai") {
          startAgentGeneration(buildNewDeckAgentBrief(draft), {
            engine: draft.generationMode,
            exportSelection: newDeckExportSelectionFromOutputs(draft.outputs),
            forceMock: draft.generationMode === "mock-agent",
            projectPath: result.project.project.path,
            speakerNotesMode: draft.speakerNotes,
            targetSlideCount: newDeckTargetSlideCount(draft)
          });
        }
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi, handleOpenProject, openPreview, startAgentGeneration, workspacePath]);

  const handleChooseWorkspace = useCallback(async (): Promise<boolean> => {
    if (!desktopApi) {
      return false;
    }
    try {
      const nextWorkspace = await desktopApi.chooseWorkspace();
      if (!nextWorkspace) {
        return false;
      }
      setWorkspacePath(nextWorkspace);
      setOperationStatus({ kind: "success", message: "Workspace updated" });
      return true;
    } catch (error) {
      setOperationStatus({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }, [desktopApi]);

  const handleSaveAiEngineSettings = useCallback(
    async (draft: AiEngineSettingsDraft): Promise<boolean> => {
      const nextSettings = buildAiEngineSettingsUpdate(aiEngineSettings, draft);
      aiEngineSettingsTouchedRef.current = true;
      setAiEngineSettings(nextSettings);
      setAiEngineStatus({ kind: "running", message: "Saving AI engine settings" });

      if (!desktopApi) {
        setAiEngineStatus({ kind: "success", message: "AI engine metadata updated locally" });
        return true;
      }

      try {
        const savedSettings = await desktopApi.saveAiEngineSettings({
          settings: nextSettings,
          apiKeyInput: draft.apiKeyInput,
          clearKey: draft.clearKey
        });
        const normalizedSettings = normalizeAiEngineSettings(savedSettings);
        setAiEngineSettings(normalizedSettings);
        setAiEngineStatus({
          kind: "success",
          message: draft.apiKeyInput?.trim() ? formatRedactedKeyStatus(normalizedSettings) : "AI engine settings saved"
        });
        return true;
      } catch (error) {
        setAiEngineSettings(aiEngineSettings);
        setAiEngineStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [aiEngineSettings, desktopApi]
  );

  const handleSelectOnboardingAiMode = useCallback((mode: AiEngineMode): Promise<boolean> => {
    return handleSaveAiEngineSettings({
      mode,
      provider: aiEngineSettings.apiKey.provider,
      model: aiEngineSettings.apiKey.model,
      baseUrl: aiEngineSettings.apiKey.baseUrl,
      externalAgentId: aiEngineSettings.externalAgent.selectedId,
      customCommand: aiEngineSettings.externalAgent.customCommand
    });
  }, [aiEngineSettings, handleSaveAiEngineSettings]);

  const handleCompleteOnboarding = useCallback((): void => {
    if (!desktopApi) {
      setView("library");
      return;
    }
    setOperationStatus({ kind: "running", message: "Saving setup" });
    desktopApi.completeOnboarding()
      .then(() => {
        setOperationStatus({ kind: "success", message: "Setup complete" });
        setView("library");
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleRefreshExternalAgents = useCallback((): void => {
    if (!desktopApi) {
      setExternalAgentStatuses(createDefaultExternalAgentStatuses());
      setAiEngineStatus({ kind: "idle", message: "Desktop detection unavailable" });
      return;
    }

    setAiEngineStatus({ kind: "running", message: "Checking external agents" });
    desktopApi.detectExternalAgents()
      .then((statuses) => {
        setExternalAgentStatuses(statuses);
        setAiEngineStatus({ kind: "success", message: "External agent status refreshed" });
      })
      .catch((error: unknown) => {
        setAiEngineStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleRefreshCliIntegration = useCallback((): void => {
    if (!desktopApi) {
      setCliIntegrationStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }

    setCliIntegrationStatus({ kind: "running", message: "Checking CLI integration" });
    desktopApi.getCliIntegration()
      .then((status) => {
        setCliIntegration(status);
        setCliIntegrationStatus({
          kind: status.status === "failed" ? "failed" : status.installed ? "success" : "idle",
          message: status.message
        });
      })
      .catch((error: unknown) => {
        setCliIntegrationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleInstallCliIntegration = useCallback((): void => {
    if (!desktopApi) {
      setCliIntegrationStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }

    setCliIntegrationStatus({ kind: "running", message: "Installing CLI integration" });
    desktopApi.installCliIntegration()
      .then((status) => {
        setCliIntegration(status);
        setCliIntegrationStatus({
          kind: status.status === "failed" ? "failed" : "success",
          message: status.message
        });
      })
      .catch((error: unknown) => {
        setCliIntegrationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleInstallOfficialSkills = useCallback((): void => {
    if (!desktopApi) {
      setOfficialSkillsStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }

    setOfficialSkillsStatus({ kind: "running", message: "Installing official skills" });
    desktopApi.installOfficialSkills()
      .then((status) => {
        setOfficialSkills(status);
        setOfficialSkillsStatus({
          kind: status.status === "failed" ? "failed" : "success",
          message: status.message
        });
      })
      .catch((error: unknown) => {
        setOfficialSkillsStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleRemoveOfficialSkill = useCallback((skillName: string): void => {
    if (!desktopApi) {
      setOfficialSkillsStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }
    const skill = officialSkills?.skills.find((candidate) => candidate.name === skillName);
    if (!skill?.removeEnabled) {
      setOfficialSkillsStatus({
        kind: "failed",
        message: skill?.removeDisabledReason ?? `Skill ${skillName} cannot be removed`
      });
      return;
    }
    if (!window.confirm(`Remove the HTMLslide-managed skill ${skillName}?`)) {
      return;
    }

    setOfficialSkillsStatus({ kind: "running", message: `Removing ${skillName}` });
    desktopApi.removeOfficialSkill({ name: skillName, confirmed: true })
      .then((status) => {
        setOfficialSkills(status);
        setOfficialSkillsStatus({
          kind: status.status === "failed" ? "failed" : "success",
          message: status.message
        });
      })
      .catch((error: unknown) => {
        setOfficialSkillsStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi, officialSkills]);

  const handleUninstallCliIntegration = useCallback((): void => {
    if (!desktopApi) {
      setCliIntegrationStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }

    setCliIntegrationStatus({ kind: "running", message: "Uninstalling CLI integration" });
    desktopApi.uninstallCliIntegration()
      .then((status) => {
        setCliIntegration(status);
        setCliIntegrationStatus({
          kind: status.status === "failed" ? "failed" : "success",
          message: status.message
        });
      })
      .catch((error: unknown) => {
        setCliIntegrationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleCopyCliManualCommand = useCallback((): void => {
    if (!desktopApi) {
      setCliIntegrationStatus({ kind: "failed", message: "Desktop API unavailable" });
      return;
    }

    desktopApi.copyCliManualInstallCommand()
      .then(() => {
        setCliIntegrationStatus({ kind: "success", message: "Manual install command copied" });
      })
      .catch((error: unknown) => {
        setCliIntegrationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const runProjectCheck = useCallback(async (): Promise<boolean> => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setInspectorTab("qa");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before running check" });
      updateCommandActionStatus("check", { kind: "failed", message: "Local project required" });
      return false;
    }

    setInspectorTab("qa");
    setOperationStatus({ kind: "running", message: "Running check" });
    updateCommandActionStatus("check", { kind: "running", message: "Checking project" });
    try {
      const result = await desktopApi.checkProject(activeProject.path);
      const report = result.json as DesktopCheckReport | undefined;
      setQaIssues(reportToIssues(report));
      setQaCheckStatus(result.ok ? "passed" : "failed");
      const nextStatus: OperationStatus = {
        kind: result.ok ? "success" : "failed",
        message: result.ok ? "Check passed" : report?.status === "failed" ? "Check found issues" : result.error ?? "Check failed"
      };
      setOperationStatus(nextStatus);
      updateCommandActionStatus("check", nextStatus);
      updateCommandActionStatus("repair", {
        kind: result.ok ? "idle" : "running",
        message: result.ok ? "No repair needed" : "Repair recommended"
      });
      return result.ok;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setOperationStatus({ kind: "failed", message });
      setQaCheckStatus("failed");
      updateCommandActionStatus("check", { kind: "failed", message });
      return false;
    } finally {
      setPreviewRevision((current) => current + 1);
    }
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, updateCommandActionStatus]);

  const runCheck = useCallback((): void => {
    void runProjectCheck();
  }, [runProjectCheck]);

  const handleIgnoreQaIssue = useCallback(
    async (issue: QaIssue, scope: "once" | "rule"): Promise<boolean> => {
      if (scope === "once") {
        setQaIssues((current) => current.filter((candidate) => candidate.id !== issue.id));
        setOperationStatus({ kind: "success", message: `Ignored ${issue.type} for this review` });
        return true;
      }

      if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
        setOperationStatus({ kind: "failed", message: "Issue rules require a local deck project." });
        return false;
      }

      try {
        await desktopApi.addQaIgnoreRule(activeProject.path, issue.type);
        setOperationStatus({ kind: "running", message: `Ignoring ${issue.type} and refreshing QA` });
        runCheck();
        return true;
      } catch (error: unknown) {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [activeProject, activeProjectIsDeckPackage, desktopApi, runCheck]
  );

  const runExport = useCallback(async (exportOptions: DesktopExportOptions = defaultNewDeckExportSelection()): Promise<void> => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setInspectorTab("export");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before export" });
      updateCommandActionStatus("export", { kind: "failed", message: "Local project required" });
      return;
    }

    const checkPassed = await runProjectCheck();
    if (!checkPassed) {
      const message = "Fix Check issues before export";
      setInspectorTab("qa");
      setOperationStatus({ kind: "failed", message });
      updateCommandActionStatus("export", { kind: "failed", message });
      updateCommandActionStatus("review", { kind: "idle", message: "Waiting for clean Check" });
      return;
    }

    setInspectorTab("export");
    setOperationStatus({ kind: "running", message: "Exporting artifacts" });
    updateCommandActionStatus("export", { kind: "running", message: "Exporting artifacts" });
    try {
      const result = await desktopApi.exportProject(activeProject.path, exportOptions);
      const report = result.json as DesktopCheckReport | undefined;
      if (!result.ok && report?.status === "failed") {
        setQaIssues(reportToIssues(report));
        setInspectorTab("qa");
      }
      const nextStatus: OperationStatus = {
        kind: result.ok ? "success" : "failed",
        message: result.ok ? "Export complete" : result.error ?? `Export exited with ${result.exitCode}`
      };
      setOperationStatus(nextStatus);
      updateCommandActionStatus("export", nextStatus);
      updateCommandActionStatus("review", {
        kind: result.ok ? "running" : "idle",
        message: result.ok ? "Ready for review" : "Waiting for clean export"
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setOperationStatus({ kind: "failed", message });
      updateCommandActionStatus("export", { kind: "failed", message });
    } finally {
      setPreviewRevision((current) => current + 1);
    }
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, runProjectCheck, updateCommandActionStatus]);

  const loadPresenterDeck = useCallback(async (): Promise<PresenterDeck | null> => {
    if (directPresenterOpen && activeProject?.path === directPresenterOpen.deckpkgPath) {
      setOperationStatus({ kind: "success", message: "Deck package loaded" });
      updateCommandActionStatus("export", { kind: "success", message: "Deck package file" });
      updateCommandActionStatus("review", { kind: "success", message: "Deck package ready" });
      return directPresenterOpen.deck;
    }

    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
      setOperationStatus({ kind: "failed", message: "Open a local deck project before presenter mode" });
      updateCommandActionStatus("review", { kind: "failed", message: "Local project required" });
      return null;
    }

    setOperationStatus({ kind: "running", message: "Loading deck package" });
    updateCommandActionStatus("review", { kind: "running", message: "Loading deckpkg" });

    const result = await desktopApi.loadPresenterDeck(activeProject.path);
    if (result.ok) {
      setOperationStatus({ kind: "success", message: "Deck package loaded" });
      updateCommandActionStatus("export", { kind: "success", message: "Deckpkg ready" });
      updateCommandActionStatus("review", { kind: "success", message: "Deck package ready" });
      return result.deck;
    }

    setOperationStatus({ kind: "failed", message: result.error });
    updateCommandActionStatus("export", { kind: "failed", message: "Deckpkg unavailable" });
    updateCommandActionStatus("review", { kind: "idle", message: "Using rehearsal fallback" });
    return null;
  }, [activeProject, desktopApi, directPresenterOpen, updateCommandActionStatus]);

  const loadPresenterPreferences = useCallback(async (): Promise<DesktopPresenterPreferences> => {
    if (!activeProject) {
      return defaultPresenterPreferences({
        id: "unknown-project",
        lastOpened: "",
        path: "",
        slideCount: 0,
        status: "Needs check",
        title: ""
      });
    }
    if (!desktopApi || activeProject.path.startsWith("~")) {
      return defaultPresenterPreferences(activeProject);
    }
    return desktopApi.getPresenterPreferences({ id: activeProject.id, path: activeProject.path });
  }, [activeProject, desktopApi]);

  const savePresenterPreferences = useCallback(
    (
      preferences: Pick<DesktopPresenterPreferences, "recentSlideId" | "notesFontSizePx" | "selectedDisplay">
    ): Promise<DesktopPresenterPreferences> => {
      if (!activeProject || !desktopApi || activeProject.path.startsWith("~")) {
        return Promise.resolve({
          ...defaultPresenterPreferences(activeProject ?? {
            id: "unknown-project",
            lastOpened: "",
            path: "",
            slideCount: 0,
            status: "Needs check",
            title: ""
          }),
          ...preferences
        });
      }
      return desktopApi.savePresenterPreferences(
        { id: activeProject.id, path: activeProject.path },
        preferences
      );
    },
    [activeProject, desktopApi]
  );

  const listPresenterDisplays = useCallback(
    () => desktopApi?.listPresenterDisplays() ?? Promise.resolve([]),
    [desktopApi]
  );

  const onAudienceWindowStateChanged = useCallback(
    (handler: (state: DesktopAudienceWindowState) => void): (() => void) =>
      desktopApi?.onAudienceWindowStateChanged(handler) ?? (() => undefined),
    [desktopApi]
  );

  const openAudienceWindow = useCallback(
    (request: DesktopAudienceWindowRequest): Promise<DesktopAudienceWindowState> =>
      desktopApi?.openAudienceWindow(request) ?? Promise.resolve({ open: false }),
    [desktopApi]
  );

  const updateAudienceWindow = useCallback(
    (request: DesktopAudienceWindowRequest): Promise<DesktopAudienceWindowState> =>
      desktopApi?.updateAudienceWindow(request) ?? Promise.resolve({ open: false }),
    [desktopApi]
  );

  const closeAudienceWindow = useCallback(
    (): Promise<DesktopAudienceWindowState> =>
      desktopApi?.closeAudienceWindow() ?? Promise.resolve({ open: false }),
    [desktopApi]
  );

  const handleViewDiff = useCallback((): void => {
    if (!diffReview?.runId && !diffReview?.checkpointId) {
      setOperationStatus({ kind: "failed", message: "No agent checkpoint is available" });
      return;
    }

    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setDiffReview((current) => current ? { ...current, open: true } : current);
      return;
    }

    setOperationStatus({ kind: "running", message: "Loading checkpoint diff" });
    desktopApi.diffCheckpoint({
      projectPath: activeProject.path,
      runId: diffReview.runId,
      checkpointId: diffReview.checkpointId
    })
      .then((diff) => {
        setDiffReview(checkpointDiffToReview(diff, {
          open: true,
          statusMessage: "Checkpoint diff refreshed from project files."
        }));
        setOperationStatus({ kind: "success", message: "Checkpoint diff loaded" });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setDiffReview((current) =>
          current
            ? {
                ...current,
                open: true,
                statusMessage: message
              }
            : current
        );
        setOperationStatus({ kind: "failed", message });
      });
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, diffReview]);

  const handleCloseDiff = useCallback((): void => {
    setDiffReview((current) => current ? { ...current, open: false } : current);
  }, []);

  const handleAcceptDiff = useCallback((): void => {
    setDiffReview((current) =>
      current
        ? {
            ...current,
            open: false,
            statusMessage: "Changes accepted for this workspace session."
          }
        : current
    );
    setOperationStatus({ kind: "success", message: "Agent changes accepted" });
    updateCommandActionStatus("review", { kind: "success", message: "Changes accepted" });
  }, [updateCommandActionStatus]);

  const handleRevertDiff = useCallback((): void => {
    if (!diffReview?.runId && !diffReview?.checkpointId) {
      setOperationStatus({ kind: "failed", message: "No checkpoint to revert" });
      return;
    }

    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setOperationStatus({ kind: "failed", message: "Open a local deck project before reverting" });
      return;
    }

    const confirmed = window.confirm("Revert this agent run to its checkpoint? Agent-added files may be removed.");
    if (!confirmed) {
      return;
    }

    setDiffReview((current) => current ? { ...current, reverting: true, statusMessage: "Reverting checkpoint..." } : current);
    setOperationStatus({ kind: "running", message: "Reverting checkpoint" });
    desktopApi.revertCheckpoint({
      projectPath: activeProject.path,
      runId: diffReview.runId,
      checkpointId: diffReview.checkpointId,
      confirmed: true
    })
      .then((result) => {
        if (result.project) {
          const revertedPreview = result.project;
          const next = projectPreviewToState(revertedPreview);
          setProjectPreviews((current) => ({
            ...current,
            [next.project.id]: revertedPreview
          }));
          setProjects((current) => {
            const existing = current.filter((project) => project.id !== next.project.id);
            return [next.project, ...existing];
          });
          setSelectedProjectId(next.project.id);
          setActiveSlides(next.slides);
          setSelectedSlideId(next.slides[0]?.id ?? "");
        }
        setQaCheckStatus("not-checked");
        setQaIssues([]);
        setDiffReview((current) =>
          current
            ? {
                ...current,
                open: false,
                reverting: false,
                canRevert: false,
                statusMessage: `Reverted ${result.restored.length} files and deleted ${result.deleted.length} agent-added files.`
              }
            : current
        );
        setOperationStatus({ kind: "success", message: "Checkpoint reverted" });
        updateCommandActionStatus("generate", { kind: "idle", message: "Reverted" });
        updateCommandActionStatus("check", { kind: "idle", message: "Run check again" });
        updateCommandActionStatus("review", { kind: "success", message: "Reverted to checkpoint" });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setDiffReview((current) => current ? { ...current, reverting: false, statusMessage: message } : current);
        setOperationStatus({ kind: "failed", message });
      });
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, diffReview, updateCommandActionStatus]);

  const runAgentGeneration = useCallback(
    (brief: string): void => {
      startAgentGeneration(brief, {
        projectPath: activeProject && !activeProject.path.startsWith("~") && !activeProjectIsDeckPackage
          ? activeProject.path
          : undefined
      });
    },
    [activeProject, activeProjectIsDeckPackage, startAgentGeneration]
  );

  if (!activeProject) {
    return null;
  }

  if (view === "onboarding") {
    return (
      <Onboarding
        activeStepIndex={activeStepIndex}
        aiEngineSettings={aiEngineSettings}
        aiEngineStatus={aiEngineStatus}
        cliIntegration={cliIntegration}
        cliIntegrationStatus={cliIntegrationStatus}
        officialSkills={officialSkills}
        officialSkillsStatus={officialSkillsStatus}
        onChooseWorkspace={handleChooseWorkspace}
        onContinue={() => {
          if (activeStepIndex >= onboardingSteps.length - 1) {
            handleCompleteOnboarding();
            return;
          }
          setActiveStepIndex((index) => index + 1);
        }}
        onInstallCli={handleInstallCliIntegration}
        onInstallSkills={handleInstallOfficialSkills}
        onSelectAiEngine={handleSelectOnboardingAiMode}
        onSkip={async () => {
          if (aiEngineSettings.mode !== "no-ai") {
            if (!await handleSelectOnboardingAiMode("no-ai")) {
              return;
            }
          }
          if (activeStepIndex === 0 || activeStepIndex >= onboardingSteps.length - 1) {
            handleCompleteOnboarding();
            return;
          }
          setActiveStepIndex((index) => index + 1);
        }}
        steps={onboardingSteps}
        workspacePath={workspacePath}
      />
    );
  }

  if (view === "library") {
    return (
      <ProjectLibrary
        activeSection={librarySection}
        activeProjectPath={activeProjectPath}
        aiEngineSettings={aiEngineSettings}
        aiEngineStatus={aiEngineStatus}
        cliIntegration={cliIntegration}
        cliIntegrationStatus={cliIntegrationStatus}
        externalAgentStatuses={externalAgentStatuses}
        externalAgentConnection={externalAgentConnection}
        onCliIntegrationCopyManualCommand={handleCopyCliManualCommand}
        onCliIntegrationInstall={handleInstallCliIntegration}
        onCliIntegrationRefresh={handleRefreshCliIntegration}
        onCliIntegrationUninstall={handleUninstallCliIntegration}
        onChooseSourceFiles={handleChooseSourceFiles}
        onChooseWorkspace={handleChooseWorkspace}
        onLibrarySectionChange={setLibrarySection}
        onNewDeck={handleNewDeck}
        onOpenFolder={handleOpenFolder}
        onOpenProject={handleOpenProject}
        onRemoveProject={handleRemoveProject}
        onRefreshExternalAgents={handleRefreshExternalAgents}
        onTestExternalAgent={handleTestExternalAgent}
        onInstallProjectAgentSkills={handleInstallProjectAgentSkills}
        onSaveAiEngineSettings={handleSaveAiEngineSettings}
        operationStatus={operationStatus}
        officialSkills={officialSkills}
        officialSkillsStatus={officialSkillsStatus}
        projects={projects}
        projectAgentSkillsStatus={projectAgentSkillsStatus}
        onInstallOfficialSkills={handleInstallOfficialSkills}
        onRemoveOfficialSkill={handleRemoveOfficialSkill}
        workspacePath={workspacePath}
      />
    );
  }

  return (
    <Workspace
      activeStageIndex={activeStageIndex}
      agentCanCancel={Boolean(agentRunSnapshot?.canCancel && !agentCancelPendingRunId)}
      agentCanPause={agentRunSnapshot?.canPause ?? false}
      agentCanRetry={Boolean(agentRunSnapshot?.canRetry && !running)}
      agentCancelPending={agentCancelPendingRunId === agentRunSnapshot?.runId || agentRunSnapshot?.status === "cancelling"}
      agentEngine={agentRunSnapshot?.engine ?? selectedAgentEngine(aiEngineSettings)}
      generationEnabled={aiEngineSettings.mode !== "no-ai"}
      agentRunId={agentRunSnapshot?.runId}
      agentRunStatus={agentRunSnapshot?.status}
      commandValue={commandValue}
      diffReview={diffReview}
      inspectorTab={inspectorTab}
      initialPresenterOpen={directPresenterOpen}
      onAcceptDiff={handleAcceptDiff}
      onBackToLibrary={handleBackToLibrary}
      onCloseDiff={handleCloseDiff}
      onCommandChange={setCommandValue}
      onCommandSubmit={() => {
        const command = commandValue.trim();
        if (command.length === 0) {
          return;
        }
        runAgentGeneration(command);
        setCommandValue("");
      }}
      onCopyRepairPrompt={copyAgentRepairPrompt}
      onInspectorTabChange={setInspectorTab}
      loadPresenterDeck={loadPresenterDeck}
      loadPresenterPreferences={loadPresenterPreferences}
      listPresenterDisplays={listPresenterDisplays}
      onPresenterDisplaysChanged={desktopApi?.onPresenterDisplaysChanged}
      onAudienceWindowStateChanged={onAudienceWindowStateChanged}
      openAudienceWindow={openAudienceWindow}
      savePresenterPreferences={savePresenterPreferences}
      updateAudienceWindow={updateAudienceWindow}
      closeAudienceWindow={closeAudienceWindow}
      onQaFilterChange={setQaFilter}
      onFixQaIssue={handleFixQaIssue}
      onIgnoreQaIssue={handleIgnoreQaIssue}
      onRevertDiff={handleRevertDiff}
      onRunAction={(action) => {
        if (action === "start") {
          runAgentGeneration(commandValue.trim());
        }
        if (action === "cancel") {
          cancelAgentGeneration();
        }
        if (action === "retry") {
          retryAgentGeneration();
        }
      }}
      onSelectSlide={setSelectedSlideId}
      onSettingsOpen={() => {
        setLibrarySection("settings");
        setView("library");
      }}
      onToolbarAction={(action, exportOptions) => {
        if (action === "check") {
          runCheck();
        }
        if (action === "export") {
          runExport(exportOptions);
        }
        if (action === "present") {
          setOperationStatus({ kind: "success", message: "Presenter open" });
          updateCommandActionStatus("review", { kind: "success", message: "Reviewing in presenter" });
        }
        if (action === "generate") {
          runAgentGeneration(commandValue.trim());
        }
      }}
      onViewDiff={handleViewDiff}
      agentRunEvents={agentRunEvents}
      agentRunLogs={agentRunLogs}
      commandActionStatuses={commandActionStatuses}
      operationStatus={operationStatus}
      onSelectVisualDirection={chooseVisualDirection}
      project={activeProject}
      previewRevision={previewRevision}
      qaCheckStatus={qaCheckStatus}
      pendingVisualDirections={agentRunSnapshot?.pendingVisualDirections ?? []}
      qaFilter={qaFilter}
      qaIssues={qaIssues}
      running={running}
      selectedSlideId={selectedSlideId}
      slides={activeSlides}
      stages={agentStages}
      loadSlidePreview={desktopApi?.loadSlidePreview}
      notesSaveStatus={notesSaveStatus}
      notesReadOnly={activeProjectIsDeckPackage}
      onSaveSlideNotes={handleSaveSlideNotes}
    />
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("HTMLslide desktop root element was not found.");
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
