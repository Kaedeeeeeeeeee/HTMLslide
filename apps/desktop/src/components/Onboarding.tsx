import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import {
  ArrowRight,
  Check,
  CircleDashed,
  FolderOpen,
  KeyRound,
  Plug,
  SkipForward,
  Settings2,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { DesktopCliIntegrationState, DesktopOfficialSkillsState } from "../desktop-api";
import type { OnboardingStep, OperationStatus } from "../model";
import { aiEngineModes, type AiEngineMode, type AiEngineSettings } from "../settings-model";

interface OnboardingProps {
  steps: OnboardingStep[];
  activeStepIndex: number;
  workspacePath?: string;
  aiEngineSettings: AiEngineSettings;
  aiEngineStatus: OperationStatus;
  cliIntegration?: DesktopCliIntegrationState;
  cliIntegrationStatus: OperationStatus;
  officialSkills?: DesktopOfficialSkillsState;
  officialSkillsStatus: OperationStatus;
  onChooseWorkspace: () => Promise<boolean>;
  onSelectAiEngine: (mode: AiEngineMode) => Promise<boolean>;
  onInstallCli: () => void;
  onInstallSkills: () => void;
  onContinue: () => void;
  onSkip: () => Promise<void>;
}

const stepIcons = [Sparkles, FolderOpen, KeyRound, Plug, Settings2, Check] as const;

export function Onboarding({
  activeStepIndex,
  aiEngineSettings,
  aiEngineStatus,
  cliIntegration,
  cliIntegrationStatus,
  officialSkills,
  officialSkillsStatus,
  onChooseWorkspace,
  onContinue,
  onInstallCli,
  onInstallSkills,
  onSelectAiEngine,
  onSkip,
  steps,
  workspacePath
}: OnboardingProps): ReactNode {
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [selectingAiEngine, setSelectingAiEngine] = useState(false);
  const activeStep = steps[activeStepIndex] ?? steps[0];
  const finalStep = activeStepIndex >= steps.length - 1;

  if (!activeStep) {
    return null;
  }

  const handlePrimaryAction = async (): Promise<void> => {
    if (activeStep.id === "workspace") {
      setChoosingWorkspace(true);
      try {
        if (await onChooseWorkspace()) {
          onContinue();
        }
      } finally {
        setChoosingWorkspace(false);
      }
      return;
    }
    if (activeStep.id === "cli" && !cliIntegration?.installed) {
      onInstallCli();
      return;
    }
    if (activeStep.id === "skills" && !officialSkills?.installed) {
      onInstallSkills();
      return;
    }
    onContinue();
  };

  const handleSelectAiEngine = async (mode: AiEngineMode): Promise<void> => {
    setSelectingAiEngine(true);
    try {
      await onSelectAiEngine(mode);
    } finally {
      setSelectingAiEngine(false);
    }
  };

  const handleSkip = async (): Promise<void> => {
    if (activeStep.id === "engine") {
      setSelectingAiEngine(true);
    }
    try {
      await onSkip();
    } finally {
      setSelectingAiEngine(false);
    }
  };

  const primaryAction = onboardingPrimaryAction({
    activeStepId: activeStep.id,
    choosingWorkspace,
    cliInstalled: cliIntegration?.installed === true,
    cliRunning: cliIntegrationStatus.kind === "running",
    engineRunning: selectingAiEngine || aiEngineStatus.kind === "running",
    finalStep,
    setupReady: Boolean(workspacePath),
    skillsInstalled: officialSkills?.installed === true,
    skillsRunning: officialSkillsStatus.kind === "running"
  });
  const setupBusy =
    choosingWorkspace ||
    selectingAiEngine ||
    aiEngineStatus.kind === "running" ||
    cliIntegrationStatus.kind === "running" ||
    officialSkillsStatus.kind === "running";

  return (
    <main aria-busy={setupBusy} aria-labelledby="onboarding-title" className="onboarding-shell">
      <section aria-describedby="onboarding-step-content" className="onboarding-panel">
        <div className="brand-block">
          <span className="brand-mark">Hs</span>
          <div>
            <strong>HTMLslide</strong>
            <span>Desktop workbench</span>
          </div>
        </div>

        <div className="onboarding-content">
          <PanelHeader
            eyebrow={`Step ${activeStepIndex + 1} of ${steps.length}`}
            title={activeStep.title}
            titleId="onboarding-title"
          />
          <div aria-live="polite" className="onboarding-step-content" id="onboarding-step-content">
            <p className="onboarding-description">{activeStep.description}</p>
            <OnboardingStepContent
              aiEngineSettings={aiEngineSettings}
              aiEngineSelectionDisabled={selectingAiEngine}
              aiEngineStatus={aiEngineStatus}
              cliIntegration={cliIntegration}
              cliIntegrationStatus={cliIntegrationStatus}
              officialSkills={officialSkills}
              officialSkillsStatus={officialSkillsStatus}
              onSelectAiEngine={(mode) => void handleSelectAiEngine(mode)}
              stepId={activeStep.id}
              workspacePath={workspacePath}
            />
          </div>
          <div className="onboarding-actions">
            <Button
              aria-busy={primaryAction.busy}
              disabled={primaryAction.disabled}
              icon={primaryAction.icon}
              onClick={() => void handlePrimaryAction()}
              variant="primary"
            >
              {primaryAction.label}
            </Button>
            {!finalStep ? (
              <Button
                aria-busy={setupBusy}
                disabled={setupBusy}
                icon={<SkipForward />}
                onClick={() => void handleSkip()}
                variant="ghost"
              >
                {activeStep.optionalAction}
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <ol aria-label="Setup progress" className="setup-rail">
        {steps.map((step, index) => {
          const StepIcon = stepIcons[index] ?? Settings2;
          const done = index < activeStepIndex;
          const active = index === activeStepIndex;
          const stateLabel = active ? "current step" : done ? "completed step" : "upcoming step";
          return (
            <li
              aria-label={`${step.title}, ${stateLabel}`}
              aria-current={active ? "step" : undefined}
              className={active ? "setup-step is-active" : "setup-step"}
              data-state={active ? "current" : done ? "complete" : "upcoming"}
              key={step.id}
            >
              <span className={done ? "setup-step__icon is-done" : "setup-step__icon"}>
                {done ? <Check /> : <StepIcon />}
              </span>
              <span>
                <strong>{step.title}</strong>
                <small>{done ? "Complete" : active ? "In progress" : step.optionalAction}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </main>
  );
}

interface OnboardingStepContentProps {
  stepId: string;
  workspacePath?: string;
  aiEngineSettings: AiEngineSettings;
  aiEngineSelectionDisabled: boolean;
  aiEngineStatus: OperationStatus;
  cliIntegration?: DesktopCliIntegrationState;
  cliIntegrationStatus: OperationStatus;
  officialSkills?: DesktopOfficialSkillsState;
  officialSkillsStatus: OperationStatus;
  onSelectAiEngine: (mode: AiEngineMode) => void;
}

function OnboardingStepContent({
  aiEngineSettings,
  aiEngineSelectionDisabled,
  aiEngineStatus,
  cliIntegration,
  cliIntegrationStatus,
  officialSkills,
  officialSkillsStatus,
  onSelectAiEngine,
  stepId,
  workspacePath
}: OnboardingStepContentProps): ReactNode {
  if (stepId === "workspace") {
    return (
      <section aria-label="Current workspace" className="onboarding-status-card">
        <span className="onboarding-status-card__icon"><FolderOpen /></span>
        <span>
          <small>Current workspace</small>
          <strong aria-live="polite">{workspacePath ?? "Loading default workspace..."}</strong>
        </span>
      </section>
    );
  }

  if (stepId === "engine") {
    return (
      <section aria-label="AI engine modes" className="onboarding-choice-grid">
        {aiEngineModes.map((mode) => (
          <button
            aria-pressed={aiEngineSettings.mode === mode.id}
            className={aiEngineSettings.mode === mode.id ? "onboarding-choice is-selected" : "onboarding-choice"}
            disabled={aiEngineSelectionDisabled}
            key={mode.id}
            onClick={() => onSelectAiEngine(mode.id)}
            type="button"
          >
            <strong>{mode.label}</strong>
            <span>{mode.description}</span>
          </button>
        ))}
        <SetupOperationStatus label="AI engine setup status" status={aiEngineStatus} />
      </section>
    );
  }

  if (stepId === "cli") {
    return (
      <SetupCapabilityCard
        detail={cliIntegration?.targetPath ?? "HTMLslide will select a writable command path."}
        installed={cliIntegration?.installed === true}
        label="Command line tool"
        status={cliIntegrationStatus}
      />
    );
  }

  if (stepId === "skills") {
    return (
      <SetupCapabilityCard
        detail={officialSkills ? `${officialSkills.installedCount} of ${officialSkills.skillCount} official skills installed` : "Inspectable deck generation and QA guidance."}
        installed={officialSkills?.installed === true}
        label="Official skills"
        status={officialSkillsStatus}
      />
    );
  }

  if (stepId === "ready") {
    const selectedMode = aiEngineModes.find((mode) => mode.id === aiEngineSettings.mode)?.label ?? "No AI";
    return (
      <section aria-label="Setup summary" className="onboarding-summary">
        <SetupSummaryRow complete label="Desktop app" value="Ready" />
        <SetupSummaryRow complete={Boolean(workspacePath)} label="Workspace" value={workspacePath ?? "Default workspace"} />
        <SetupSummaryRow complete label="AI engine" value={selectedMode} />
        <SetupSummaryRow complete={cliIntegration?.installed === true} label="Command line tool" value={cliIntegration?.installed ? "Installed" : "Skipped"} />
        <SetupSummaryRow complete={officialSkills?.installed === true} label="Official skills" value={officialSkills?.installed ? `${officialSkills.installedCount} installed` : "Skipped"} />
      </section>
    );
  }

  return (
    <section aria-label="Setup overview" className="onboarding-overview">
      <span><FolderOpen /> Local project folders</span>
      <span><TerminalSquare /> Shared App and CLI workflow</span>
      <span><Sparkles /> Optional AI generation</span>
    </section>
  );
}

function SetupOperationStatus({ label, status }: { label: string; status: OperationStatus }): ReactNode {
  return (
    <StatusPill
      aria-atomic="true"
      aria-busy={status.kind === "running"}
      aria-label={label}
      aria-live="polite"
      className="onboarding-operation-status"
      data-status={status.kind}
      role="status"
      tone={status.kind === "failed" ? "danger" : status.kind === "success" ? "success" : "neutral"}
    >
      {status.message}
    </StatusPill>
  );
}

function SetupCapabilityCard({
  detail,
  installed,
  label,
  status
}: {
  detail: string;
  installed: boolean;
  label: string;
  status: OperationStatus;
}): ReactNode {
  return (
    <section
      aria-busy={status.kind === "running"}
      aria-label={label}
      className="onboarding-status-card onboarding-status-card--capability"
    >
      <span className={installed ? "onboarding-status-card__icon is-complete" : "onboarding-status-card__icon"}>
        {installed ? <Check /> : <CircleDashed />}
      </span>
      <span>
        <small>{installed ? "Installed" : "Optional setup"}</small>
        <strong>{label}</strong>
        <code>{detail}</code>
      </span>
      <SetupOperationStatus label={`${label} operation status`} status={status} />
    </section>
  );
}

function SetupSummaryRow({ complete, label, value }: { complete: boolean; label: string; value: string }): ReactNode {
  return (
    <div>
      <span className={complete ? "onboarding-summary__check is-complete" : "onboarding-summary__check"}>
        {complete ? <Check /> : <CircleDashed />}
      </span>
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function onboardingPrimaryAction(options: {
  activeStepId: string;
  choosingWorkspace: boolean;
  cliInstalled: boolean;
  cliRunning: boolean;
  engineRunning: boolean;
  finalStep: boolean;
  setupReady: boolean;
  skillsInstalled: boolean;
  skillsRunning: boolean;
}): { busy: boolean; disabled: boolean; icon: ReactNode; label: string } {
  if (options.activeStepId === "welcome" && !options.setupReady) {
    return {
      busy: true,
      disabled: true,
      icon: <CircleDashed />,
      label: "Loading Setup"
    };
  }
  if (options.activeStepId === "workspace") {
    return {
      busy: options.choosingWorkspace,
      disabled: options.choosingWorkspace,
      icon: <FolderOpen />,
      label: options.choosingWorkspace ? "Choosing Workspace" : "Choose Workspace"
    };
  }
  if (options.activeStepId === "engine") {
    return {
      busy: options.engineRunning,
      disabled: options.engineRunning,
      icon: options.engineRunning ? <CircleDashed /> : <ArrowRight />,
      label: options.engineRunning ? "Saving AI Engine" : "Continue"
    };
  }
  if (options.activeStepId === "cli" && !options.cliInstalled) {
    return {
      busy: options.cliRunning,
      disabled: options.cliRunning,
      icon: <TerminalSquare />,
      label: options.cliRunning ? "Installing CLI" : "Install CLI"
    };
  }
  if (options.activeStepId === "skills" && !options.skillsInstalled) {
    return {
      busy: options.skillsRunning,
      disabled: options.skillsRunning,
      icon: <Sparkles />,
      label: options.skillsRunning ? "Installing Skills" : "Install Skills"
    };
  }
  return {
    busy: false,
    disabled: false,
    icon: options.finalStep ? <Check /> : <ArrowRight />,
    label: options.finalStep ? "Open Library" : options.activeStepId === "welcome" ? "Start Setup" : "Continue"
  };
}
