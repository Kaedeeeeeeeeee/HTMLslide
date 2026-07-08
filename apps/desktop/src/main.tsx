import "@htmlslide/shared-ui/styles.css";
import "./app.css";

import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Onboarding } from "./components/Onboarding";
import { ProjectLibrary } from "./components/ProjectLibrary";
import { Workspace } from "./components/Workspace";
import { getNextStageIndex, type AppView, type InspectorTab, type QaFilter } from "./model";
import { agentStages, onboardingSteps, projects, qaIssues, slides } from "./sampleData";

function App(): React.ReactNode {
  const [view, setView] = useState<AppView>("onboarding");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "demo-alpha");
  const [selectedSlideId, setSelectedSlideId] = useState(slides[0]?.id ?? "");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("qa");
  const [qaFilter, setQaFilter] = useState<QaFilter>("all");
  const [commandValue, setCommandValue] = useState("");
  const [running, setRunning] = useState(true);
  const [activeStageIndex, setActiveStageIndex] = useState(4);

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
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [selectedProjectId]
  );

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
        onOpenProject={(projectId) => {
          setSelectedProjectId(projectId);
          setView("workspace");
        }}
        projects={projects}
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
      project={activeProject}
      qaFilter={qaFilter}
      qaIssues={qaIssues}
      running={running}
      selectedSlideId={selectedSlideId}
      slides={slides}
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

