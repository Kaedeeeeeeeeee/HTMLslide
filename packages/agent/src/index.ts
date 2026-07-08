export type AgentRunStage =
  | "plan"
  | "outline"
  | "visual-direction"
  | "build"
  | "check"
  | "repair"
  | "export"
  | "review";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type AgentRunEvent = {
  stage: AgentRunStage;
  status: AgentRunStatus;
  summary: string;
  filesChanged?: string[];
  issuesFound?: number;
  nextAction?: string;
  createdAt: string;
};

export type AgentEngine = {
  id: string;
  label: string;
  mode: "byok" | "external" | "mock";
  available: boolean;
};

export const defaultAgentStages: AgentRunStage[] = [
  "plan",
  "outline",
  "visual-direction",
  "build",
  "check",
  "repair",
  "export",
  "review"
];

export const mockEngines: AgentEngine[] = [
  {
    id: "htmlslide-mock",
    label: "HTMLslide Mock Provider",
    mode: "mock",
    available: true
  },
  {
    id: "htmlslide-byok-openai",
    label: "OpenAI with your API key",
    mode: "byok",
    available: false
  },
  {
    id: "external-codex",
    label: "Codex CLI",
    mode: "external",
    available: false
  }
];

export const createMockRunEvents = (): AgentRunEvent[] => {
  const now = new Date().toISOString();
  return defaultAgentStages.map((stage, index) => ({
    stage,
    status: index < 5 ? "succeeded" : index === 5 ? "running" : "queued",
    summary:
      index < 5
        ? `${stage} completed by mock provider`
        : index === 5
          ? "Repair pass is checking machine-readable QA output"
          : "Waiting for previous stage",
    issuesFound: stage === "check" ? 2 : undefined,
    nextAction: index === 5 ? "Apply deterministic repair instructions" : undefined,
    createdAt: now
  }));
};

