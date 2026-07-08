import "@htmlslide/shared-ui/styles.css";
import "./app.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Onboarding } from "./components/Onboarding";
import { ProjectLibrary } from "./components/ProjectLibrary";
import { Workspace, type AgentDiffReview } from "./components/Workspace";
import {
  getDesktopApi,
  type DesktopCheckReport,
  type DesktopCliIntegrationState,
  type DesktopMockAgentRunResult,
  type DesktopProjectPreview,
  type DesktopProjectRecord
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
  const [cliIntegration, setCliIntegration] = useState<DesktopCliIntegrationState | undefined>();
  const [cliIntegrationStatus, setCliIntegrationStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "CLI integration not checked"
  });
  const [externalAgentStatuses, setExternalAgentStatuses] = useState<ExternalAgentStatus[]>(() =>
    createDefaultExternalAgentStatuses()
  );
  const [aiEngineStatus, setAiEngineStatus] = useState<OperationStatus>({
    kind: "idle",
    message: "No AI mode"
  });
  const desktopApi = getDesktopApi();

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    let cancelled = false;
    Promise.all([desktopApi.getSetup(), desktopApi.listProjects(), desktopApi.getAiEngineSettings()])
      .then(([setup, records, settings]) => {
        if (cancelled) {
          return;
        }
        setWorkspacePath(setup.workspacePath);
        setProjects(records.map(projectRecordToSummary));
        setAiEngineSettings(normalizeAiEngineSettings(settings));
        setCliIntegration(setup.cliIntegration);
        setCliIntegrationStatus({
          kind: setup.cliIntegration.status === "failed" ? "failed" : setup.cliIntegration.installed ? "success" : "idle",
          message: setup.cliIntegration.message
        });
        setOperationStatus({
          kind: setup.cli.available ? "success" : "failed",
          message: setup.cli.available ? "CLI available" : "CLI unavailable"
        });
        setAiEngineStatus({
          kind: "success",
          message: "AI engine settings loaded"
        });
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
      });

    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

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

  const applyMockAgentResult = useCallback(
    (result: DesktopMockAgentRunResult): void => {
      const checkReport = result.check?.json as DesktopCheckReport | undefined;
      const repairs = result.agent.outputs.repairs ?? [];
      const checkErrors = result.summary.checkErrors ?? 0;
      const checkWarnings = result.summary.checkWarnings ?? 0;

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
          ? "Mock agent completed check and export"
          : result.check?.ok === false
            ? "Mock agent completed, but check found issues"
            : result.export?.ok === false
              ? "Mock agent completed, but export failed"
              : "Mock agent run failed"
      });
      updateCommandActionStatus("generate", {
        kind: result.agent.ok ? "success" : "failed",
        message: result.agent.ok ? "Mock generation complete" : "Mock generation failed"
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

  const startMockGeneration = useCallback(
    (brief: string, options: { action?: "generate" | "retry"; projectPath?: string } = {}): void => {
      const trimmedBrief = brief.trim();
      const prompt = trimmedBrief.length > 0 ? trimmedBrief : "Create or revise this HTMLslide deck.";
      const action = options.action ?? "generate";

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
          message: action === "retry" ? "Retrying mock generation" : "Mock generation running"
        },
        review: {
          kind: "idle",
          message: "Waiting for generated result"
        }
      });

      if (!desktopApi || !options.projectPath) {
        seedMockAgentRun(
          !desktopApi
            ? `Mock generation running for: ${prompt}`
            : "Open a local deck project before running the mock agent."
        );
        if (desktopApi && !options.projectPath) {
          updateCommandActionStatus("generate", { kind: "failed", message: "Local project required" });
          setOperationStatus({ kind: "failed", message: "Open a local deck project before Generate" });
          setRunning(false);
        }
        return;
      }

      setOperationStatus({ kind: "running", message: "Running mock agent" });
      desktopApi.runMockAgent({
        brief: prompt,
        projectPath: options.projectPath,
        runExport: true
      })
        .then(applyMockAgentResult)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setRunning(false);
          setOperationStatus({ kind: "failed", message });
          updateCommandActionStatus("generate", { kind: "failed", message });
        });
    },
    [applyMockAgentResult, desktopApi, seedMockAgentRun, updateCommandActionStatus]
  );

  const activeProject = useMemo(() => {
    const selectedPreview = projectPreviews[selectedProjectId];
    return selectedPreview
      ? projectRecordToSummary(selectedPreview.project)
      : projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? sampleProjects[0];
  }, [projectPreviews, projects, selectedProjectId]);

  const openPreview = useCallback((preview: DesktopProjectPreview): void => {
    const next = projectPreviewToState(preview);
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

      setSelectedProjectId(projectId);
      const cachedPreview = projectPreviews[projectId];
      if (cachedPreview) {
        const next = projectPreviewToState(cachedPreview);
        setActiveSlides(next.slides);
        setSelectedSlideId(next.slides[0]?.id ?? "");
        setView("workspace");
        return;
      }

      if (!desktopApi || project.path.startsWith("~")) {
        setActiveSlides(sampleSlides);
        setSelectedSlideId(sampleSlides[0]?.id ?? "");
        setView("workspace");
        return;
      }

      setOperationStatus({ kind: "running", message: "Loading project" });
      desktopApi.loadProject(project.path)
        .then(openPreview)
        .catch((error: unknown) => {
          setOperationStatus({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
        });
    },
    [desktopApi, openPreview, projectPreviews, projects]
  );

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
        if (draft.generationMode === "mock-agent") {
          startMockGeneration(buildNewDeckAgentBrief(draft), {
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
  }, [desktopApi, handleOpenProject, openPreview, startMockGeneration, workspacePath]);

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
      setAiEngineSettings(nextSettings);
      setAiEngineStatus({ kind: "running", message: "Saving AI engine settings" });

      if (!desktopApi) {
        setAiEngineStatus({ kind: "success", message: "AI engine metadata updated locally" });
        return;
      }

      desktopApi.saveAiEngineSettings(nextSettings)
        .then((savedSettings) => {
          setAiEngineSettings(normalizeAiEngineSettings(savedSettings));
          setAiEngineStatus({ kind: "success", message: "AI engine metadata saved" });
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
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
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
  }, [activeProject, desktopApi, updateCommandActionStatus]);

  const runExport = useCallback((): void => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
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
  }, [activeProject, desktopApi, updateCommandActionStatus]);

  const handleViewDiff = useCallback((): void => {
    if (!diffReview?.runId && !diffReview?.checkpointId) {
      setOperationStatus({ kind: "failed", message: "No agent checkpoint is available" });
      return;
    }

    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
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
  }, [activeProject, desktopApi, diffReview]);

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

    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
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
  }, [activeProject, desktopApi, diffReview, updateCommandActionStatus]);

  const runMockGeneration = useCallback(
    (brief: string, action: "generate" | "retry" = "generate"): void => {
      startMockGeneration(brief, {
        action,
        projectPath: activeProject && !activeProject.path.startsWith("~") ? activeProject.path : undefined
      });
    },
    [activeProject, startMockGeneration]
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
        onRefreshExternalAgents={handleRefreshExternalAgents}
        onSaveAiEngineSettings={handleSaveAiEngineSettings}
        operationStatus={operationStatus}
        projects={projects}
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
      onAcceptDiff={handleAcceptDiff}
      onCloseDiff={handleCloseDiff}
      onCommandChange={setCommandValue}
      onCommandSubmit={() => {
        const command = commandValue.trim();
        if (command.length === 0) {
          return;
        }
        runMockGeneration(command);
        setCommandValue("");
      }}
      onInspectorTabChange={setInspectorTab}
      onQaFilterChange={setQaFilter}
      onRevertDiff={handleRevertDiff}
      onRunAction={(action) => {
        if (action === "start" || action === "retry") {
          runMockGeneration(commandValue.trim(), action === "retry" ? "retry" : "generate");
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
          setOperationStatus({ kind: "success", message: "Rehearsal mode open" });
          updateCommandActionStatus("review", { kind: "success", message: "Reviewing in rehearsal" });
        }
        if (action === "generate") {
          runMockGeneration(commandValue.trim());
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
