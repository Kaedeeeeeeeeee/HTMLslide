import type { InspectorTabId, QaSeverityId } from "@htmlslide/shared-ui";

export type AppView = "onboarding" | "library" | "workspace";
export type InspectorTab = InspectorTabId;
export type QaSeverity = QaSeverityId;
export type QaFilter = "all" | QaSeverity;

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  optionalAction: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  path: string;
  lastOpened: string;
  status:
    | "Ready"
    | "Needs check"
    | "Export failed"
    | "Missing files"
    | "External changes detected";
  slideCount: number;
}

export interface SlideSummary {
  id: string;
  number: string;
  title: string;
  section: string;
  status: "ready" | "needs-check" | "blocked";
  duration: string;
  accent: string;
  speakerNotes: string;
  bullets: string[];
}

export interface QaIssue {
  id: string;
  slideId: string;
  severity: QaSeverity;
  type:
    | "text-overflow"
    | "safe-area-violation"
    | "low-contrast"
    | "font-missing"
    | "remote-asset"
    | "missing-asset"
    | "image-too-large"
    | "broken-link"
    | "missing-notes"
    | "title-too-long"
    | "body-too-dense"
    | "chart-label-too-small"
    | "slide-id-mismatch"
    | "export-outdated";
  message: string;
  selector: string;
  measurement: string;
  suggestedFix: string;
}

export type AgentStageStatus = "complete" | "running" | "queued" | "paused";

export interface AgentStage {
  id: string;
  label: string;
  summary: string;
  filesChanged: string;
  issuesFound: string;
  nextAction: string;
  logs: string[];
}

export interface RuntimeAgentStage extends AgentStage {
  status: AgentStageStatus;
}

export function filterQaIssues(
  issues: readonly QaIssue[],
  filter: QaFilter,
  slideId: string | "all" = "all"
): QaIssue[] {
  return issues.filter((issue) => {
    const matchesSeverity = filter === "all" || issue.severity === filter;
    const matchesSlide = slideId === "all" || issue.slideId === slideId;
    return matchesSeverity && matchesSlide;
  });
}

export function countIssuesBySeverity(issues: readonly QaIssue[]): Record<QaSeverity, number> {
  return issues.reduce<Record<QaSeverity, number>>(
    (counts, issue) => {
      counts[issue.severity] += 1;
      return counts;
    },
    { error: 0, suggestion: 0, warning: 0 }
  );
}

export function buildRuntimeStages(
  stages: readonly AgentStage[],
  activeIndex: number,
  running: boolean
): RuntimeAgentStage[] {
  return stages.map((stage, index) => {
    if (!running && index > activeIndex) {
      return { ...stage, status: "queued" };
    }

    if (!running && index === activeIndex) {
      return { ...stage, status: "paused" };
    }

    if (index < activeIndex) {
      return { ...stage, status: "complete" };
    }

    if (index === activeIndex) {
      return { ...stage, status: "running" };
    }

    return { ...stage, status: "queued" };
  });
}

export function getNextStageIndex(currentIndex: number, stageCount: number): number {
  if (stageCount <= 0) {
    return 0;
  }

  return Math.min(currentIndex + 1, stageCount - 1);
}
