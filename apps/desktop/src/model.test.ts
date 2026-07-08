import { describe, expect, it } from "vitest";
import {
  buildRuntimeStages,
  countIssuesBySeverity,
  filterQaIssues,
  formatProjectOpenedAt,
  getNextStageIndex
} from "./model";
import type { AgentStage, QaIssue } from "./model";

const issues: QaIssue[] = [
  {
    id: "one",
    measurement: "12 px",
    message: "Caption leaves safe area.",
    selector: ".caption",
    severity: "error",
    slideId: "slide-1",
    suggestedFix: "Move caption up.",
    type: "safe-area-violation"
  },
  {
    id: "two",
    measurement: "44 words",
    message: "Body is dense.",
    selector: ".body",
    severity: "warning",
    slideId: "slide-2",
    suggestedFix: "Split body text.",
    type: "body-too-dense"
  },
  {
    id: "three",
    measurement: "22 chars",
    message: "Title is long.",
    selector: "h1",
    severity: "suggestion",
    slideId: "slide-2",
    suggestedFix: "Shorten title.",
    type: "title-too-long"
  }
];

const stages: AgentStage[] = [
  {
    filesChanged: "0",
    id: "plan",
    issuesFound: "0",
    label: "Plan",
    logs: [],
    nextAction: "Outline",
    summary: "Planning"
  },
  {
    filesChanged: "1",
    id: "outline",
    issuesFound: "0",
    label: "Outline",
    logs: [],
    nextAction: "Build",
    summary: "Outlining"
  },
  {
    filesChanged: "2",
    id: "build",
    issuesFound: "1 warning",
    label: "Build",
    logs: [],
    nextAction: "Check",
    summary: "Building"
  }
];

describe("desktop model helpers", () => {
  it("filters QA issues by severity and slide", () => {
    expect(filterQaIssues(issues, "all", "slide-2")).toHaveLength(2);
    expect(filterQaIssues(issues, "warning", "slide-2")).toEqual([issues[1]]);
    expect(filterQaIssues(issues, "error", "slide-2")).toEqual([]);
  });

  it("counts issues by severity", () => {
    expect(countIssuesBySeverity(issues)).toEqual({
      error: 1,
      suggestion: 1,
      warning: 1
    });
  });

  it("builds runtime stage statuses for a running agent", () => {
    expect(buildRuntimeStages(stages, 1, true).map((stage) => stage.status)).toEqual([
      "complete",
      "running",
      "queued"
    ]);
  });

  it("caps stage advancement at the last known stage", () => {
    expect(getNextStageIndex(0, stages.length)).toBe(1);
    expect(getNextStageIndex(2, stages.length)).toBe(2);
    expect(getNextStageIndex(4, 0)).toBe(0);
  });

  it("formats project open timestamps with a fallback", () => {
    expect(formatProjectOpenedAt("not-a-date")).toBe("Unknown");
    expect(formatProjectOpenedAt("2026-07-08T00:00:00.000Z")).not.toBe("Unknown");
  });
});
