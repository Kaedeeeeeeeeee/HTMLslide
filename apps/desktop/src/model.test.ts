import { describe, expect, it } from "vitest";
import { DEFAULT_DECK_TEMPLATE_ID } from "@htmlslide/core/templates";
import {
  buildAgentRepairPrompt,
  buildNewDeckAgentBrief,
  buildAgentRunStages,
  buildRuntimeStages,
  countIssuesBySeverity,
  createDefaultNewDeckDraft,
  newDeckManifestExportOptionsFromOutputs,
  newDeckExportSelectionFromOutputs,
  defaultCommandActionStatuses,
  filterQaIssues,
  formatProjectOpenedAt,
  getNextStageIndex,
  newDeckTargetSlideCount,
  shouldAutoOpenAudienceWindow
} from "./model";
import type { AgentRunEventLike, AgentRunLogLike, AgentStage, QaIssue } from "./model";

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
  it("builds a bounded repair prompt without secrets or absolute paths", () => {
    const prompt = buildAgentRepairPrompt({
      checkErrors: 2,
      checkStatus: "failed",
      checkWarnings: 1,
      engine: "External agent",
      error: "request failed Bearer sk-live-secret at /Users/alice/deck/slides/001.html",
      filesChanged: ["slides/001.html", "/Users/alice/deck/notes/001.md", "../outside.txt", "slides/001.html"],
      runId: "run-123",
      status: "failed"
    });

    expect(prompt).toContain("Run id: run-123");
    expect(prompt).toContain("Changed source files: slides/001.html");
    expect(prompt).toContain("Bearer [redacted]");
    expect(prompt).toContain("[path omitted]");
    expect(prompt).not.toContain("sk-live-secret");
    expect(prompt).not.toContain("/Users/alice");
    expect(prompt).not.toContain("outside.txt");
    expect(prompt).toContain("htmlslide check --json");
    expect(prompt).not.toContain("stdout");
    expect(prompt).not.toContain("stderr");
  });

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

  it("maps real agent events and logs into runtime stages", () => {
    const events: AgentRunEventLike[] = [
      {
        createdAt: "2026-07-09T00:00:00.000Z",
        filesChanged: ["deck.json"],
        nextAction: "Build",
        runId: "run-1",
        sequence: 2,
        stage: "outline",
        status: "succeeded",
        summary: "Outline complete."
      },
      {
        createdAt: "2026-07-09T00:01:00.000Z",
        issuesFound: 2,
        nextAction: "Repair",
        runId: "run-1",
        sequence: 3,
        stage: "check",
        status: "running",
        summary: "Checking deck."
      }
    ];
    const logs: AgentRunLogLike[] = [
      {
        createdAt: "2026-07-09T00:01:10.000Z",
        level: "warning",
        message: "Safe area issue found.",
        runId: "run-1",
        stage: "check"
      }
    ];

    const runtimeStages = buildAgentRunStages(events, logs, stages);

    expect(runtimeStages.find((stage) => stage.id === "outline")?.status).toBe("complete");
    expect(runtimeStages.find((stage) => stage.id === "check")).toMatchObject({
      issuesFound: "2",
      logs: ["warning: Safe area issue found."],
      nextAction: "Repair",
      status: "running",
      summary: "Checking deck."
    });
  });

  it("keeps failed and cancelled agent stages distinct", () => {
    const runtimeStages = buildAgentRunStages([
      {
        createdAt: "2026-07-11T00:00:00.000Z",
        runId: "run-failed",
        sequence: 1,
        stage: "build",
        status: "failed",
        summary: "Build failed."
      },
      {
        createdAt: "2026-07-11T00:01:00.000Z",
        runId: "run-cancelled",
        sequence: 2,
        stage: "check",
        status: "cancelled",
        summary: "Check cancelled."
      }
    ], []);

    expect(runtimeStages.find((stage) => stage.id === "build")?.status).toBe("failed");
    expect(runtimeStages.find((stage) => stage.id === "check")?.status).toBe("cancelled");
  });

  it("marks a visual direction stage as paused while waiting for user choice", () => {
    const runtimeStages = buildAgentRunStages([
      {
        createdAt: "2026-07-11T00:00:00.000Z",
        nextAction: "Choose a visual direction",
        runId: "run-choice",
        sequence: 1,
        stage: "visual-direction",
        status: "running",
        summary: "Waiting for visual direction choice.",
        type: "user-choice-requested"
      }
    ], []);

    expect(runtimeStages.find((stage) => stage.id === "visual-direction")).toMatchObject({
      nextAction: "Choose a visual direction",
      status: "paused"
    });
  });

  it("creates explicit default command action statuses", () => {
    expect(defaultCommandActionStatuses()).toMatchObject({
      check: { kind: "idle", message: "Not checked" },
      export: { kind: "idle", message: "Not exported" },
      generate: { kind: "idle", message: "Ready" },
      repair: { kind: "idle", message: "No repair queued" },
      review: { kind: "idle", message: "No review yet" }
    });
  });

  it("creates a no-ai new deck draft by default", () => {
    const draft = createDefaultNewDeckDraft();

    expect(draft).toMatchObject({
      audience: "general",
      designDirection: "auto",
      generationMode: "no-ai",
      language: "auto",
      slideCount: "auto",
      templateId: DEFAULT_DECK_TEMPLATE_ID,
      title: "Untitled Deck"
    });
    expect(draft.outputs).toEqual(["pdf", "html", "deckpkg", "thumbnails", "speakerNotes"]);
  });

  it("maps New Deck output choices to the export contract", () => {
    expect(newDeckExportSelectionFromOutputs(["html", "thumbnails", "speakerNotes"])).toEqual({
      deckpkg: false,
      html: true,
      pdf: false,
      thumbnails: true
    });
  });

  it("maps New Deck output choices to the manifest export profile", () => {
    expect(newDeckManifestExportOptionsFromOutputs(["pdf", "deckpkg", "speakerNotes"])).toEqual({
      deckpkg: true,
      html: false,
      pdf: true,
      speakerNotes: true,
      thumbnails: false
    });
  });

  it("auto-opens audience only once when a second display is available", () => {
    expect(shouldAutoOpenAudienceWindow(1, false, false)).toBe(false);
    expect(shouldAutoOpenAudienceWindow(2, true, false)).toBe(false);
    expect(shouldAutoOpenAudienceWindow(2, false, true)).toBe(false);
    expect(shouldAutoOpenAudienceWindow(2, false, false)).toBe(true);
  });

  it("builds a structured agent brief from a new deck draft", () => {
    const draft = {
      ...createDefaultNewDeckDraft(),
      audience: "investors",
      brief: "Summarize Q3 growth and expansion risks.",
      designDirection: "consulting-clean",
      durationMinutes: "20",
      generationMode: "mock-agent" as const,
      language: "en-US",
      slideCount: "8",
      speakerNotes: "full-script" as const,
      sources: [
        { id: "file-1", kind: "file" as const, name: "research.csv", path: "/tmp/research.csv", size: 42 },
        { content: "Ship the beta", id: "text-1", kind: "text" as const, name: "Meeting transcript" }
      ],
      templateId: "default",
      title: "Investor Update",
      tone: "executive"
    };

    expect(buildNewDeckAgentBrief(draft)).toContain("Deck title: Investor Update");
    expect(buildNewDeckAgentBrief(draft)).toContain("Template: default");
    expect(buildNewDeckAgentBrief(draft)).toContain("Brief: Summarize Q3 growth and expansion risks.");
    expect(buildNewDeckAgentBrief(draft)).toContain("Audience: investors");
    expect(buildNewDeckAgentBrief(draft)).toContain("AI engine: local deterministic mock agent");
    expect(buildNewDeckAgentBrief(draft)).toContain("Source materials: file: research.csv, text: Meeting transcript");
    expect(buildNewDeckAgentBrief(draft)).toContain("Read any staged source materials under assets/sources/");
    expect(buildNewDeckAgentBrief(draft)).toContain("Slide count: 8 slides");
    expect(buildNewDeckAgentBrief(draft)).toContain("Speaker notes: full speaker script");
    expect(buildNewDeckAgentBrief(draft)).toContain("fixed 1920x1080 canvas");
    expect(newDeckTargetSlideCount(draft)).toBe(8);
    expect(newDeckTargetSlideCount({ ...draft, slideCount: "auto" })).toBeUndefined();
    expect(newDeckTargetSlideCount({ ...draft, slideCount: "invalid" })).toBeUndefined();
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
