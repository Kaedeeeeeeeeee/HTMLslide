import { Button, PanelHeader } from "@htmlslide/shared-ui";
import { ArrowRight, Check, FolderOpen, KeyRound, Plug, Settings2, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { OnboardingStep } from "../model";

interface OnboardingProps {
  steps: OnboardingStep[];
  activeStepIndex: number;
  onContinue: () => void;
  onSkip: () => void;
}

const stepIcons = [Sparkles, FolderOpen, KeyRound, Plug, Settings2, Check] as const;

export function Onboarding({
  activeStepIndex,
  onContinue,
  onSkip,
  steps
}: OnboardingProps): ReactNode {
  const activeStep = steps[activeStepIndex] ?? steps[0];
  const finalStep = activeStepIndex >= steps.length - 1;

  if (!activeStep) {
    return null;
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-panel">
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
          />
          <p>{activeStep.description}</p>
          <div className="onboarding-actions">
            <Button
              icon={finalStep ? <Check /> : <ArrowRight />}
              onClick={onContinue}
              variant="primary"
            >
              {finalStep ? "Open Library" : "Continue"}
            </Button>
            <Button
              onClick={onSkip}
              variant="ghost"
            >
              {activeStep.optionalAction}
            </Button>
          </div>
        </div>
      </section>

      <aside className="setup-rail">
        {steps.map((step, index) => {
          const StepIcon = stepIcons[index] ?? Settings2;
          const done = index < activeStepIndex;
          const active = index === activeStepIndex;
          return (
            <button
              aria-current={active ? "step" : undefined}
              className={active ? "setup-step is-active" : "setup-step"}
              key={step.id}
              type="button"
            >
              <span className={done ? "setup-step__icon is-done" : "setup-step__icon"}>
                {done ? <Check /> : <StepIcon />}
              </span>
              <span>
                <strong>{step.title}</strong>
                <small>{step.optionalAction}</small>
              </span>
            </button>
          );
        })}
      </aside>
    </main>
  );
}
