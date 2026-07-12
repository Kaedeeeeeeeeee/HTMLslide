import { DEFAULT_DECK_TEMPLATE_ID } from "@htmlslide/core/templates";
import type { InspectorTabId, QaSeverityId } from "@htmlslide/shared-ui";

export type AppView = "onboarding" | "library" | "workspace";
export type LibrarySection = "recent" | "templates" | "skills" | "ai-engines" | "settings";
export type InspectorTab = InspectorTabId;
export type QaSeverity = QaSeverityId;
export type QaFilter = "all" | QaSeverity;
export type OperationStatusKind = "idle" | "running" | "success" | "failed";
export type CommandAction = "generate" | "check" | "repair" | "export" | "review";
export type NewDeckGenerationMode = "no-ai" | "htmlslide-agent" | "external-agent" | "mock-agent";
export type NewDeckOutputFormat = "pdf" | "html" | "deckpkg" | "thumbnails" | "speakerNotes";

export interface OperationStatus {
  kind: OperationStatusKind;
  message: string;
}

export type CommandActionStatuses = Record<CommandAction, OperationStatus>;

export interface NewDeckDraft {
  title: string;
  templateId: string;
  folderName: string;
  brief: string;
  language: string;
  audience: string;
  durationMinutes: string;
  slideCount: string;
  tone: string;
  designDirection: string;
  speakerNotes: string;
  outputs: NewDeckOutputFormat[];
  generationMode: NewDeckGenerationMode;
}

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
  sourcePath?: string;
  notesPath?: string;
}

export interface QaIssue {
  id: string;
  slideId: string;
  severity: QaSeverity;
  type: string;
  message: string;
  selector: string;
  measurement: string;
  suggestedFix: string;
}

export type AgentStageStatus = "complete" | "running" | "queued" | "paused" | "failed" | "cancelled";
export type AgentRunStageId =
  | "brief"
  | "outline"
  | "visual-direction"
  | "build"
  | "check"
  | "repair"
  | "export"
  | "review";
export type AgentRunEventStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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
  eventCount?: number;
  lastEventAt?: string;
  runId?: string;
}

export interface AgentRunEventLike {
  stage: AgentRunStageId;
  status: AgentRunEventStatus;
  summary: string;
  createdAt: string;
  runId?: string;
  sequence?: number;
  type?: string;
  filesChanged?: string[];
  issuesFound?: number;
  nextAction?: string;
}

export interface AgentRunLogLike {
  runId: string;
  stage?: AgentRunStageId;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  createdAt: string;
}

export interface AgentRepairPromptInput {
  runId?: string;
  engine: string;
  status?: string;
  error?: string;
  checkStatus?: string;
  checkErrors?: number;
  checkWarnings?: number;
  filesChanged?: readonly string[];
}

const repairPromptText = (value: string): string =>
  value
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, "sk-[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "github_pat_[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "gh_[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/gu, "glpat-[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "xox-[redacted]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/gu, "npm_[redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "AWS_[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "AIza[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*([^\s"'&]+)/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|private|tmp|home|var|Volumes)\/)[^\s,;]+/gu, "[path omitted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 320);

const repairPromptSourcePath = (value: string): string | undefined => {
  const normalized = value.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  return normalized;
};

export function buildAgentRepairPrompt(input: AgentRepairPromptInput): string {
  const changedFiles = Array.from(
    new Set((input.filesChanged ?? []).map(repairPromptSourcePath).filter((file): file is string => Boolean(file)))
  ).sort();
  return [
    "HTMLslide repair request",
    "",
    `Engine: ${repairPromptText(input.engine) || "unknown"}`,
    `Run status: ${repairPromptText(input.status ?? "failed") || "failed"}`,
    `Run id: ${repairPromptText(input.runId ?? "unavailable") || "unavailable"}`,
    `Failure summary: ${repairPromptText(input.error ?? "The agent run did not complete successfully.") || "The agent run did not complete successfully."}`,
    `Check status: ${repairPromptText(input.checkStatus ?? "not available") || "not available"}`,
    `Check errors: ${Number.isFinite(input.checkErrors) ? Math.max(0, Math.round(input.checkErrors ?? 0)) : 0}`,
    `Check warnings: ${Number.isFinite(input.checkWarnings) ? Math.max(0, Math.round(input.checkWarnings ?? 0)) : 0}`,
    `Changed source files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none recorded"}`,
    "",
    "Required next steps:",
    "1. Run htmlslide check --json for the project.",
    "2. Fix only project source areas and preserve the deck intent.",
    "3. Re-run check, then export after all blocking issues pass.",
    "",
    "Do not modify exports/, secrets, credentials, or files outside the HTMLslide project."
  ].join("\n");
}

export const defaultCommandActionStatuses = (): CommandActionStatuses => ({
  check: { kind: "idle", message: "Not checked" },
  export: { kind: "idle", message: "Not exported" },
  generate: { kind: "idle", message: "Ready" },
  repair: { kind: "idle", message: "No repair queued" },
  review: { kind: "idle", message: "No review yet" }
});

export const defaultNewDeckOutputs: NewDeckOutputFormat[] = ["pdf", "html", "deckpkg", "thumbnails", "speakerNotes"];

export function createDefaultNewDeckDraft(): NewDeckDraft {
  return {
    audience: "general",
    brief: "",
    designDirection: "auto",
    durationMinutes: "10",
    folderName: "untitled-deck",
    generationMode: "no-ai",
    language: "auto",
    outputs: [...defaultNewDeckOutputs],
    slideCount: "auto",
    speakerNotes: "bullet-notes",
    templateId: DEFAULT_DECK_TEMPLATE_ID,
    title: "Untitled Deck",
    tone: "concise"
  };
}

const newDeckLabelMaps = {
  audience: {
    executives: "executives",
    general: "general audience",
    investors: "investors",
    engineers: "engineers",
    students: "students"
  },
  designDirection: {
    auto: "auto-select the best design direction",
    "consulting-clean": "consulting-clean",
    "data-report": "data-report",
    "product-launch": "product-launch",
    "swiss-editorial": "swiss-editorial",
    "technical-dark": "technical-dark"
  },
  language: {
    auto: "auto-detect",
    "en-US": "English",
    "ja-JP": "Japanese",
    "zh-CN": "Chinese"
  },
  speakerNotes: {
    "bullet-notes": "bullet speaker notes",
    "full-script": "full speaker script",
    none: "no speaker notes",
    "rehearsal-cues": "rehearsal cues"
  },
  tone: {
    academic: "academic",
    concise: "concise",
    executive: "executive",
    "product-launch": "product launch",
    technical: "technical"
  },
  engine: {
    "external-agent": "connected coding agent",
    "htmlslide-agent": "HTMLslide Agent with API key metadata",
    "mock-agent": "local deterministic mock agent",
    "no-ai": "No AI"
  }
} as const;

function labelFromMap<TMap extends Record<string, string>>(map: TMap, value: string): string {
  return map[value as keyof TMap] ?? value;
}

export function buildNewDeckAgentBrief(draft: NewDeckDraft): string {
  const title = draft.title.trim() || "Untitled Deck";
  const brief = draft.brief.trim() || `Create a presentation titled "${title}".`;
  const outputs = draft.outputs.length > 0 ? draft.outputs.join(", ") : "pdf, html, deckpkg";
  const slideCount = draft.slideCount === "auto" ? "auto slide count" : `${draft.slideCount} slides`;

  return [
    `Deck title: ${title}`,
    `Template: ${draft.templateId}`,
    `Brief: ${brief}`,
    `Language: ${labelFromMap(newDeckLabelMaps.language, draft.language)}`,
    `Audience: ${labelFromMap(newDeckLabelMaps.audience, draft.audience)}`,
    `Duration: ${draft.durationMinutes} minutes`,
    `Slide count: ${slideCount}`,
    `Tone: ${labelFromMap(newDeckLabelMaps.tone, draft.tone)}`,
    `Design direction: ${labelFromMap(newDeckLabelMaps.designDirection, draft.designDirection)}`,
    `Speaker notes: ${labelFromMap(newDeckLabelMaps.speakerNotes, draft.speakerNotes)}`,
    `Requested outputs: ${outputs}`,
    `AI engine: ${labelFromMap(newDeckLabelMaps.engine, draft.generationMode)}`,
    "Constraints: use project-local HTML fragments, deck.json, notes, theme tokens, no remote assets, fixed 1920x1080 canvas, run check and export after generation."
  ].join("\n");
}

export function newDeckTargetSlideCount(draft: NewDeckDraft): number | undefined {
  if (draft.slideCount === "auto") {
    return undefined;
  }
  const value = Number(draft.slideCount);
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : undefined;
}

const agentStageLabels: Record<AgentRunStageId, string> = {
  brief: "Brief",
  build: "Build",
  check: "Check",
  export: "Export",
  outline: "Outline",
  repair: "Repair",
  review: "Review",
  "visual-direction": "Visual direction"
};

const agentStageOrder: AgentRunStageId[] = [
  "brief",
  "outline",
  "visual-direction",
  "build",
  "check",
  "repair",
  "export",
  "review"
];

function mapEventStatusToStageStatus(status: AgentRunEventStatus): AgentStageStatus {
  if (status === "succeeded") {
    return "complete";
  }

  if (status === "running") {
    return "running";
  }

  if (status === "failed" || status === "cancelled") {
    return status;
  }

  return "queued";
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

export function buildAgentRunStages(
  events: readonly AgentRunEventLike[],
  logs: readonly AgentRunLogLike[],
  fallbackStages: readonly AgentStage[] = []
): RuntimeAgentStage[] {
  if (events.length === 0) {
    return buildRuntimeStages(fallbackStages, 0, false);
  }

  const sortedEvents = [...events].sort((a, b) => {
    const sequenceDiff = (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER);
    if (sequenceDiff !== 0) {
      return sequenceDiff;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  const stageOrder = [
    ...agentStageOrder,
    ...sortedEvents.map((event) => event.stage).filter((stage) => !agentStageOrder.includes(stage))
  ];

  return stageOrder
    .map((stageId): RuntimeAgentStage | undefined => {
      const stageEvents = sortedEvents.filter((event) => event.stage === stageId);
      const latest = stageEvents.at(-1);
      const fallback = fallbackStages.find((stage) => stage.id === stageId);
      const canonical = agentStageOrder.includes(stageId);

      if (!latest && !fallback && !canonical) {
        return undefined;
      }

      const stageLogs = logs
        .filter((log) => log.stage === stageId || (!log.stage && latest?.runId && log.runId === latest.runId))
        .map((log) => `${log.level}: ${log.message}`);

      return {
        filesChanged:
          latest?.filesChanged && latest.filesChanged.length > 0
            ? String(latest.filesChanged.length)
            : fallback?.filesChanged ?? "0",
        id: stageId,
        issuesFound:
          typeof latest?.issuesFound === "number"
            ? String(latest.issuesFound)
            : fallback?.issuesFound ?? "0",
        label: fallback?.label ?? agentStageLabels[stageId],
        lastEventAt: latest?.createdAt,
        logs: stageLogs.length > 0 ? stageLogs : fallback?.logs ?? [],
        nextAction: latest?.nextAction ?? fallback?.nextAction ?? "Await event",
        runId: latest?.runId,
        status: latest?.type === "user-choice-requested"
          ? "paused"
          : mapEventStatusToStageStatus(latest?.status ?? "queued"),
        summary: latest?.summary ?? fallback?.summary ?? "Waiting for agent event.",
        eventCount: stageEvents.length
      };
    })
    .filter((stage): stage is RuntimeAgentStage => Boolean(stage));
}

export function getNextStageIndex(currentIndex: number, stageCount: number): number {
  if (stageCount <= 0) {
    return 0;
  }

  return Math.min(currentIndex + 1, stageCount - 1);
}

export function formatProjectOpenedAt(value: string): string {
  const openedAt = new Date(value);
  if (Number.isNaN(openedAt.getTime())) {
    return "Unknown";
  }

  return openedAt.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  });
}
