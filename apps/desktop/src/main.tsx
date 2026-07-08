import "@htmlslide/shared-ui/styles.css";
import "./app.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Onboarding } from "./components/Onboarding";
import { ProjectLibrary } from "./components/ProjectLibrary";
import { Workspace } from "./components/Workspace";
import { getDesktopApi, type DesktopCheckReport, type DesktopProjectPreview, type DesktopProjectRecord } from "./desktop-api";
import {
  formatProjectOpenedAt,
  getNextStageIndex,
  type AppView,
  type InspectorTab,
  type LibrarySection,
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
  const [aiEngineSettings, setAiEngineSettings] = useState<AiEngineSettings>(() => createDefaultAiEngineSettings());
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
      });

    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveStageIndex((current) => getNextStageIndex(current, agentStages.length));
    }, 2800);

    return () => window.clearInterval(timer);
  }, [running]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? sampleProjects[0],
    [projects, selectedProjectId]
  );

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

  const handleNewDeck = useCallback((): void => {
    if (!desktopApi) {
      handleOpenProject(sampleProjects[0]?.id ?? "demo-alpha");
      return;
    }

    const name = window.prompt("Deck folder name", "demo-deck");
    if (!name) {
      return;
    }

    setOperationStatus({ kind: "running", message: "Creating deck" });
    desktopApi.createProject({ name, workspacePath })
      .then((result) => {
        if (!result.ok || !result.project) {
          setOperationStatus({
            kind: "failed",
            message: result.error ?? `htmlslide new exited with ${result.exitCode}`
          });
          return;
        }
        openPreview(result.project);
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [desktopApi, handleOpenProject, openPreview, workspacePath]);

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

  const runCheck = useCallback((): void => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
      setInspectorTab("qa");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before running check" });
      return;
    }

    setInspectorTab("qa");
    setOperationStatus({ kind: "running", message: "Running check" });
    desktopApi.checkProject(activeProject.path)
      .then((result) => {
        const report = result.json as DesktopCheckReport | undefined;
        setQaIssues(reportToIssues(report));
        setOperationStatus({
          kind: result.ok ? "success" : "failed",
          message: result.ok ? "Check passed" : report?.status === "failed" ? "Check found issues" : result.error ?? "Check failed"
        });
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [activeProject, desktopApi]);

  const runExport = useCallback((): void => {
    if (!desktopApi || !activeProject || activeProject.path.startsWith("~")) {
      setInspectorTab("export");
      setOperationStatus({ kind: "failed", message: "Open a local deck project before export" });
      return;
    }

    setInspectorTab("export");
    setOperationStatus({ kind: "running", message: "Exporting artifacts" });
    desktopApi.exportProject(activeProject.path)
      .then((result) => {
        setOperationStatus({
          kind: result.ok ? "success" : "failed",
          message: result.ok ? "Export complete" : result.error ?? `Export exited with ${result.exitCode}`
        });
      })
      .catch((error: unknown) => {
        setOperationStatus({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }, [activeProject, desktopApi]);

  if (!activeProject) {
    return null;
  }

  if (view === "onboarding") {
    return (
      <Onboarding
        activeStepIndex={activeStepIndex}
        onContinue={() => {
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
        externalAgentStatuses={externalAgentStatuses}
        onChooseWorkspace={handleChooseWorkspace}
        onLibrarySectionChange={setLibrarySection}
        onNewDeck={handleNewDeck}
        onOpenFolder={handleOpenFolder}
        onOpenProject={handleOpenProject}
        onRefreshExternalAgents={handleRefreshExternalAgents}
        onSaveAiEngineSettings={handleSaveAiEngineSettings}
        projects={projects}
        workspacePath={workspacePath}
      />
    );
  }

  return (
    <Workspace
      activeStageIndex={activeStageIndex}
      commandValue={commandValue}
      inspectorTab={inspectorTab}
      onCommandChange={setCommandValue}
      onCommandSubmit={() => {
        if (commandValue.trim().length === 0) {
          return;
        }
        setRunning(true);
        setActiveStageIndex(0);
        setInspectorTab("qa");
        setCommandValue("");
      }}
      onInspectorTabChange={setInspectorTab}
      onQaFilterChange={setQaFilter}
      onRunAction={(action) => {
        if (action === "start" || action === "retry") {
          setRunning(true);
          setActiveStageIndex(action === "retry" ? 0 : activeStageIndex);
        }
        if (action === "pause" || action === "cancel") {
          setRunning(false);
        }
      }}
      onSelectSlide={setSelectedSlideId}
      onSettingsOpen={() => {
        setLibrarySection("ai-engines");
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
        }
      }}
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
