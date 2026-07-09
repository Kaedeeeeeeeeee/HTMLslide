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
  type DesktopCheckReport,
  type DesktopAudienceWindowRequest,
  type DesktopAudienceWindowState,
  type DesktopByokAgentRunResult,
  type DesktopCliIntegrationState,
  type DesktopExternalAgentRunResult,
  type DesktopMockAgentRunResult,
  type DesktopOfficialSkillsState,
  type DesktopPresenterDeckResult,
  type DesktopProjectPreview,
  type DesktopProjectRecord,
  type DesktopSmokeReadyMarker
} from "./desktop-api";
import {
  buildNewDeckAgentBrief,
  defaultCommandActionStatuses,
  formatProjectOpenedAt,
  getNextStageIndex,
  type AgentRunEventLike,
  type AgentRunLogLike,
  type AppView,
  type CommandAction,
  type CommandActionStatuses,
  type InspectorTab,
  type LibrarySection,
  type NewDeckDraft,
  type OperationStatus,
  type ProjectSummary,
  type QaFilter,
  type QaIssue,
  type SlideSummary
} from "./model";
import {
  buildAiEngineSettingsUpdate,
  createDefaultAiEngineSettings,
  createDefaultExternalAgentStatuses,
  normalizeAiEngineSettings,
  type AiEngineSettings,
  type AiEngineSettingsDraft,
  type ExternalAgentStatus
} from "./settings-model";
import type { FileCopyCheckpointDiff } from "@htmlslide/agent";
import {
  agentStages,
  onboardingSteps,
  projects as sampleProjects,
  qaIssues as sampleQaIssues,
  slides as sampleSlides
} from "./sampleData";

const idleStatus: OperationStatus = {
  kind: "idle",
  message: "Ready"
};

const nowIso = (): string => new Date().toISOString();

type DesktopAgentRunResult = DesktopMockAgentRunResult | DesktopByokAgentRunResult | DesktopExternalAgentRunResult;
type DesktopGenerationEngine = "mock-agent" | "htmlslide-agent" | "external-agent";

type DirectPresenterOpen = {
  id: string;
  source: "deckpkg-file";
  deckpkgPath: string;
  deck: PresenterDeck;
};

const presenterDeckAccents = ["#315fcb", "#267a4f", "#9a6410", "#286a8d", "#7b4ab8", "#bc3a3a"];

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
    slideCount: project.slideCount
  };
}

function projectRecordsToSummaries(projects: DesktopProjectRecord[]): ProjectSummary[] {
  return projects.map(projectRecordToSummary);
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
    project: projectRecordToSummary(preview.project),
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
  const [selectedSlideId, setSelectedSlideId] = useState(sampleSlides[0]?.id ?? "");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("qa");
  const [qaFilter, setQaFilter] = useState<QaFilter>("all");
  const [qaIssues, setQaIssues] = useState<QaIssue[]>(sampleQaIssues);
  const [commandValue, setCommandValue] = useState("");
  const [running, setRunning] = useState(true);
  const [activeStageIndex, setActiveStageIndex] = useState(4);
  const [operationStatus, setOperationStatus] = useState<OperationStatus>(idleStatus);
  const [commandActionStatuses, setCommandActionStatuses] = useState<CommandActionStatuses>(() =>
    defaultCommandActionStatuses()
  );
  const [diffReview, setDiffReview] = useState<AgentDiffReview | undefined>();
  const [agentRunEvents, setAgentRunEvents] = useState<AgentRunEventLike[]>([]);
  const [agentRunLogs, setAgentRunLogs] = useState<AgentRunLogLike[]>([]);
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
  const [aiEngineStatus, setAiEngineStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "No AI mode"
  });
  const [directPresenterOpen, setDirectPresenterOpen] = useState<DirectPresenterOpen | undefined>();
  const desktopApi = getDesktopApi();

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
      setQaIssues([]);
      setDiffReview(undefined);
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
  }, []);

  const openDeckPackagePath = useCallback(
    async (deckpkgPath: string, baseProjects?: ProjectSummary[]): Promise<DesktopPresenterDeckResult | undefined> => {
      if (!desktopApi) {
        setOperationStatus({ kind: "failed", message: "Desktop API unavailable" });
        return undefined;
      }

      setOperationStatus({ kind: "running", message: "Opening deck package" });
      const result = await desktopApi.loadPresenterDeckPackage(deckpkgPath);
      applyDeckPackageOpenResult(result, baseProjects);
      return result;
    },
    [applyDeckPackageOpenResult, desktopApi]
  );

  const reportSmokeReady = useCallback(
    async (marker: DesktopSmokeReadyMarker): Promise<void> => {
      await desktopApi?.reportSmokeReady(marker);
    },
    [desktopApi]
  );

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    let cancelled = false;
    Promise.all([desktopApi.getSetup(), desktopApi.listProjects(), desktopApi.getAiEngineSettings()])
      .then(async ([setup, records, settings]) => {
        if (cancelled) {
          return;
        }
        const projectSummaries = projectRecordsToSummaries(records);
        setWorkspacePath(setup.workspacePath);
        setProjects(projectSummaries);
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

        if (setup.initialOpen?.kind === "deckpkg") {
          const openResult = await openDeckPackagePath(setup.initialOpen.path, projectSummaries);
          if (setup.smoke?.expectOpenDeckpkgPath) {
            await reportSmokeReady(
              openResult?.ok
                ? {
                    status: "passed",
                    kind: "deckpkg-open",
                    deckpkgPath: openResult.deckpkgPath,
                    expectedDeckpkgPath: setup.smoke.expectOpenDeckpkgPath,
                    title: openResult.deck.title,
                    slideCount: openResult.deck.slides.length
                  }
                : {
                    status: "failed",
                    kind: "deckpkg-open",
                    deckpkgPath: setup.initialOpen.path,
                    expectedDeckpkgPath: setup.smoke.expectOpenDeckpkgPath,
                    error: openResult?.error ?? "Deck package did not open."
                  }
            );
          }
          if (cancelled) {
            return;
          }
        } else if (setup.smoke?.expectOpenDeckpkgPath) {
          await reportSmokeReady({
            status: "failed",
            kind: "deckpkg-open",
            expectedDeckpkgPath: setup.smoke.expectOpenDeckpkgPath,
            error: "Packaged smoke expected an initial deckpkg open request."
          });
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
    };
  }, [desktopApi, openDeckPackagePath, reportSmokeReady]);

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    return desktopApi.onOpenDeckPackage((request) => {
      if (request.kind === "deckpkg") {
        void openDeckPackagePath(request.path);
      }
    });
  }, [desktopApi, openDeckPackagePath]);

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
    (result: DesktopAgentRunResult): void => {
      const checkReport = result.check?.json as DesktopCheckReport | undefined;
      const repairs = result.providerId === "external-generic" ? [] : result.agent?.outputs.repairs ?? [];
      const checkErrors = result.summary.checkErrors ?? 0;
      const checkWarnings = result.summary.checkWarnings ?? 0;
      const agentLabel =
        result.providerId === "external-generic"
          ? "External agent"
          : result.providerId === "htmlslide-byok"
            ? "HTMLslide Agent"
            : "Mock agent";
      const generationOk = result.providerId === "external-generic" ? result.adapter?.ok === true : result.agent?.ok === true;

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
      setOperationStatus({
        kind: result.ok ? "success" : "failed",
        message: result.ok
          ? `${agentLabel} completed check and export`
          : result.check?.ok === false
            ? `${agentLabel} completed, but check found issues`
            : result.export?.ok === false
              ? `${agentLabel} completed, but export failed`
              : `${agentLabel} run failed`
      });
      updateCommandActionStatus("generate", {
        kind: generationOk ? "success" : "failed",
        message: generationOk
          ? result.providerId === "external-generic"
            ? "External agent complete"
            : result.providerId === "htmlslide-byok"
              ? "HTMLslide Agent complete"
              : "Mock generation complete"
          : result.providerId === "external-generic"
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
        kind: result.ok ? "success" : "failed",
        message: result.ok ? "Ready for review" : "Review required"
      });
    },
    [updateCommandActionStatus]
  );

  const startAgentGeneration = useCallback(
    (brief: string, options: { action?: "generate" | "retry"; engine?: DesktopGenerationEngine; forceMock?: boolean; projectPath?: string } = {}): void => {
      const trimmedBrief = brief.trim();
      const prompt = trimmedBrief.length > 0 ? trimmedBrief : "Create or revise this HTMLslide deck.";
      const action = options.action ?? "generate";
      const selectedEngine: DesktopGenerationEngine = options.forceMock
        ? "mock-agent"
        : options.engine ?? (aiEngineSettings.mode === "no-ai" ? "mock-agent" : aiEngineSettings.mode);
      const useByokAgent = selectedEngine === "htmlslide-agent";
      const useExternalAgent = selectedEngine === "external-agent";
      const agentLabel = useExternalAgent ? "External agent" : useByokAgent ? "HTMLslide Agent" : "Mock generation";
      const generateMessage = useExternalAgent
        ? action === "retry"
          ? "Retrying external agent"
          : "External agent running"
        : useByokAgent
          ? action === "retry"
            ? "Retrying HTMLslide Agent"
            : "HTMLslide Agent running"
        : action === "retry"
          ? "Retrying mock generation"
          : "Mock generation running";

      setRunning(true);
      setActiveStageIndex(0);
      setInspectorTab("qa");
      setAgentRunEvents([]);
      setAgentRunLogs([]);
      setDiffReview(undefined);
      setCommandActionStatuses({
        ...defaultCommandActionStatuses(),
        generate: {
          kind: "running",
          message: generateMessage
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
        return;
      }

      setOperationStatus({ kind: "running", message: `Running ${agentLabel}` });
      const run = useExternalAgent
        ? desktopApi.runExternalAgent({
            brief: prompt,
            projectPath: options.projectPath,
            runExport: true
          })
        : useByokAgent
          ? desktopApi.runByokAgent({
              brief: prompt,
              projectPath: options.projectPath,
              runExport: true
            })
        : desktopApi.runMockAgent({
            brief: prompt,
            projectPath: options.projectPath,
            runExport: true
          });

      run
        .then(applyAgentRunResult)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setRunning(false);
          setOperationStatus({ kind: "failed", message });
          updateCommandActionStatus("generate", { kind: "failed", message });
        });
    },
    [aiEngineSettings.mode, applyAgentRunResult, desktopApi, seedMockAgentRun, updateCommandActionStatus]
  );

  const activeProject = useMemo(() => {
    const selectedPreview = projectPreviews[selectedProjectId];
    return selectedPreview
      ? projectRecordToSummary(selectedPreview.project)
      : projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? sampleProjects[0];
  }, [projectPreviews, projects, selectedProjectId]);
  const activeProjectIsDeckPackage = Boolean(
    directPresenterOpen && activeProject?.path === directPresenterOpen.deckpkgPath
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
    setQaIssues([]);
    setDiffReview(undefined);
    setOperationStatus({
      kind: "success",
      message: "Project loaded"
    });
    setView("workspace");
  }, []);

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

  const handleNewDeck = useCallback((draft: NewDeckDraft): void => {
    if (!desktopApi) {
      handleOpenProject(sampleProjects[0]?.id ?? "demo-alpha");
      return;
    }

    setOperationStatus({ kind: "running", message: "Creating deck" });
    desktopApi.createProject({ ...draft, workspacePath })
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
            forceMock: draft.generationMode === "mock-agent",
            projectPath: result.project.project.path
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

  const handleChooseWorkspace = useCallback((): void => {
    if (!desktopApi) {
      return;
    }
    desktopApi.chooseWorkspace()
      .then((nextWorkspace) => {
        if (nextWorkspace) {
          setWorkspacePath(nextWorkspace);
          setOperationStatus({ kind: "success", message: "Workspace updated" });
        }
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi]);

  const handleSaveAiEngineSettings = useCallback(
    (draft: AiEngineSettingsDraft): void => {
      const nextSettings = buildAiEngineSettingsUpdate(aiEngineSettings, draft);
      aiEngineSettingsTouchedRef.current = true;
      setAiEngineSettings(nextSettings);
      setAiEngineStatus({ kind: "running", message: "Saving AI engine settings" });

      if (!desktopApi) {
        setAiEngineStatus({ kind: "success", message: "AI engine metadata updated locally" });
        return;
      }

      desktopApi.saveAiEngineSettings({
        settings: nextSettings,
        apiKeyInput: draft.apiKeyInput,
        clearKey: draft.clearKey
      })
        .then((savedSettings) => {
          setAiEngineSettings(normalizeAiEngineSettings(savedSettings));
          setAiEngineStatus({ kind: "success", message: draft.apiKeyInput?.trim() ? "AI engine key saved" : "AI engine settings saved" });
        })
        .catch((error: unknown) => {
          setAiEngineStatus({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
        });
    },
    [aiEngineSettings, desktopApi]
  );

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

  const runCheck = useCallback((): void => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setInspectorTab("qa");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before running check" });
      updateCommandActionStatus("check", { kind: "failed", message: "Local project required" });
      return;
    }

    setInspectorTab("qa");
    setOperationStatus({ kind: "running", message: "Running check" });
    updateCommandActionStatus("check", { kind: "running", message: "Checking project" });
    desktopApi.checkProject(activeProject.path)
      .then((result) => {
        const report = result.json as DesktopCheckReport | undefined;
        setQaIssues(reportToIssues(report));
        const nextStatus: OperationStatus = {
          kind: result.ok ? "success" : "failed",
          message: result.ok ? "Check passed" : report?.status === "failed" ? "Check found issues" : result.error ?? "Check failed"
        };
        setOperationStatus({
          kind: nextStatus.kind,
          message: nextStatus.message
        });
        updateCommandActionStatus("check", nextStatus);
        updateCommandActionStatus("repair", {
          kind: result.ok ? "idle" : "running",
          message: result.ok ? "No repair needed" : "Repair recommended"
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setOperationStatus({
          kind: "failed",
          message
        });
        updateCommandActionStatus("check", { kind: "failed", message });
      });
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, updateCommandActionStatus]);

  const runExport = useCallback((): void => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~") || activeProjectIsDeckPackage) {
      setInspectorTab("export");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before export" });
      updateCommandActionStatus("export", { kind: "failed", message: "Local project required" });
      return;
    }

    setInspectorTab("export");
    setOperationStatus({ kind: "running", message: "Exporting artifacts" });
    updateCommandActionStatus("export", { kind: "running", message: "Exporting artifacts" });
    desktopApi.exportProject(activeProject.path)
      .then((result) => {
        const nextStatus: OperationStatus = {
          kind: result.ok ? "success" : "failed",
          message: result.ok ? "Export complete" : result.error ?? `Export exited with ${result.exitCode}`
        };
        setOperationStatus({
          kind: nextStatus.kind,
          message: nextStatus.message
        });
        updateCommandActionStatus("export", nextStatus);
        updateCommandActionStatus("review", {
          kind: result.ok ? "running" : "idle",
          message: result.ok ? "Ready for review" : "Waiting for clean export"
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setOperationStatus({
          kind: "failed",
          message
        });
        updateCommandActionStatus("export", { kind: "failed", message });
    });
  }, [activeProject, activeProjectIsDeckPackage, desktopApi, updateCommandActionStatus]);

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

  const listPresenterDisplays = useCallback(
    () => desktopApi?.listPresenterDisplays() ?? Promise.resolve([]),
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
    (brief: string, action: "generate" | "retry" = "generate"): void => {
      startAgentGeneration(brief, {
        action,
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
        onContinue={() => {
          if (onboardingSteps[activeStepIndex]?.id === "cli") {
            handleInstallCliIntegration();
          }
          if (onboardingSteps[activeStepIndex]?.id === "skills") {
            handleInstallOfficialSkills();
          }
          if (activeStepIndex >= onboardingSteps.length - 1) {
            setView("library");
            return;
          }
          setActiveStepIndex((index) => index + 1);
        }}
        onSkip={() => setView("library")}
        steps={onboardingSteps}
      />
    );
  }

  if (view === "library") {
    return (
      <ProjectLibrary
        activeSection={librarySection}
        aiEngineSettings={aiEngineSettings}
        aiEngineStatus={aiEngineStatus}
        cliIntegration={cliIntegration}
        cliIntegrationStatus={cliIntegrationStatus}
        externalAgentStatuses={externalAgentStatuses}
        onCliIntegrationCopyManualCommand={handleCopyCliManualCommand}
        onCliIntegrationInstall={handleInstallCliIntegration}
        onCliIntegrationRefresh={handleRefreshCliIntegration}
        onCliIntegrationUninstall={handleUninstallCliIntegration}
        onChooseWorkspace={handleChooseWorkspace}
        onLibrarySectionChange={setLibrarySection}
        onNewDeck={handleNewDeck}
        onOpenFolder={handleOpenFolder}
        onOpenProject={handleOpenProject}
        onRemoveProject={handleRemoveProject}
        onRefreshExternalAgents={handleRefreshExternalAgents}
        onSaveAiEngineSettings={handleSaveAiEngineSettings}
        operationStatus={operationStatus}
        officialSkills={officialSkills}
        officialSkillsStatus={officialSkillsStatus}
        projects={projects}
        onInstallOfficialSkills={handleInstallOfficialSkills}
        workspacePath={workspacePath}
      />
    );
  }

  return (
    <Workspace
      activeStageIndex={activeStageIndex}
      commandValue={commandValue}
      diffReview={diffReview}
      inspectorTab={inspectorTab}
      initialPresenterOpen={directPresenterOpen}
      onAcceptDiff={handleAcceptDiff}
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
      onInspectorTabChange={setInspectorTab}
      loadPresenterDeck={loadPresenterDeck}
      listPresenterDisplays={listPresenterDisplays}
      openAudienceWindow={openAudienceWindow}
      updateAudienceWindow={updateAudienceWindow}
      closeAudienceWindow={closeAudienceWindow}
      onQaFilterChange={setQaFilter}
      onRevertDiff={handleRevertDiff}
      onRunAction={(action) => {
        if (action === "start" || action === "retry") {
          runAgentGeneration(commandValue.trim(), action === "retry" ? "retry" : "generate");
        }
        if (action === "pause" || action === "cancel") {
          setRunning(false);
          updateCommandActionStatus("generate", {
            kind: action === "cancel" ? "failed" : "idle",
            message: action === "cancel" ? "Generation cancelled" : "Generation paused"
          });
        }
      }}
      onSelectSlide={setSelectedSlideId}
      onSettingsOpen={() => {
        setLibrarySection("settings");
        setView("library");
      }}
      onToolbarAction={(action) => {
        if (action === "check") {
          runCheck();
        }
        if (action === "export") {
          runExport();
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
      project={activeProject}
      qaFilter={qaFilter}
      qaIssues={qaIssues}
      running={running}
      selectedSlideId={selectedSlideId}
      slides={activeSlides}
      stages={agentStages}
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
