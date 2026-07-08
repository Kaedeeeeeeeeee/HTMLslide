export * from "./errors.js";
export * from "./checkpoint.js";
export * from "./mock-provider.js";
export * from "./mock-project.js";
export * from "./orchestrator.js";
export * from "./providers/index.js";
export * from "./source-writes.js";
export * from "./types.js";

import { defaultAgentStages } from "./orchestrator.js";
import type { AgentEngine, AgentRunEvent } from "./types.js";

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
