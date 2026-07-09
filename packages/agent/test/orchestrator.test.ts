import { describe, expect, it } from "vitest";
import {
  canTransitionAgentRunState,
  createMockFailedCheck,
  createMockPassedCheck,
  createMockProvider,
  runAgent,
  startAgentRun,
  type AgentRunStage,
  type ModelRequest,
  type ModelResponse
} from "../src/index.js";

const projectRoot = "/tmp/htmlslide-agent-project";
const fixedClock = (): Date => new Date("2026-07-09T00:00:00.000Z");

const runMockAgent = (overrides: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent(
    {
      projectRoot,
      brief: "Create a short deck about controlled HTMLslide agent runs.",
      provider: createMockProvider({
        checkResults: [createMockPassedCheck()]
      }),
      runId: "run-test",
      ...overrides
    },
    {
      clock: fixedClock
    }
  );

describe("agent orchestrator", () => {
  it("moves from brief to outline with deterministic mock output", async () => {
    const result = await runMockAgent({ runId: "run-brief-outline" });

    expect(result.ok).toBe(true);
    expect(result.outputs.brief?.title).toBe("Mock HTMLslide Deck");
    expect(result.outputs.outline?.slides.map((slide) => slide.id)).toEqual([
      "001-title",
      "002-workflow",
      "003-review"
    ]);
    expect(
      result.events
        .filter((event) => event.type === "stage-completed")
        .map((event) => event.stage)
        .slice(0, 2)
    ).toEqual(["brief", "outline"]);
  });

  it("supports visual direction selection before build", async () => {
    const result = await runMockAgent({
      runId: "run-visual-direction",
      chooseVisualDirection: () => "direction-systems"
    });

    expect(result.ok).toBe(true);
    expect(result.outputs.visualDirection?.directions.map((direction) => direction.id)).toEqual([
      "direction-editorial",
      "direction-systems"
    ]);
    expect(result.outputs.selectedVisualDirectionId).toBe("direction-systems");
    expect(result.events.some((event) => event.type === "user-choice-requested")).toBe(true);
    expect(result.events.some((event) => event.type === "user-choice-selected")).toBe(true);
  });

  it("passes structured outputs forward between model stages", async () => {
    const baseProvider = createMockProvider({
      checkResults: [createMockPassedCheck()]
    });
    const requests: Array<{ stage: AgentRunStage; input: unknown }> = [];
    const provider = {
      ...baseProvider,
      validateCredentials: () => baseProvider.validateCredentials(),
      complete: async (request: ModelRequest): Promise<ModelResponse> => {
        requests.push({
          stage: request.stage,
          input: request.input
        });
        return baseProvider.complete(request);
      }
    };

    const result = await runAgent(
      {
        projectRoot,
        brief: "Check model handoffs.",
        chooseVisualDirection: () => "direction-systems",
        provider,
        runId: "run-stage-handoffs"
      },
      {
        clock: fixedClock
      }
    );

    expect(result.ok).toBe(true);
    expect(requests.find((request) => request.stage === "outline")?.input).toMatchObject({
      brief: result.outputs.brief
    });
    expect(requests.find((request) => request.stage === "visual-direction")?.input).toMatchObject({
      brief: result.outputs.brief,
      outline: result.outputs.outline
    });
    expect(requests.find((request) => request.stage === "build")?.input).toMatchObject({
      brief: result.outputs.brief,
      outline: result.outputs.outline,
      selectedVisualDirectionId: "direction-systems"
    });
    expect(requests.find((request) => request.stage === "check")?.input).toMatchObject({
      build: result.outputs.build,
      repairs: []
    });
  });

  it("runs the full mock build, check, repair, export, and review flow", async () => {
    const result = await runAgent(
      {
        projectRoot,
        brief: "Create a deterministic mock deck.",
        provider: createMockProvider(),
        runId: "run-full-flow"
      },
      {
        clock: fixedClock
      }
    );

    expect(result.ok).toBe(true);
    expect(result.outputs.checks).toHaveLength(2);
    expect(result.outputs.repairs).toHaveLength(1);
    expect(result.outputs.export?.artifacts.map((artifact) => artifact.type)).toEqual([
      "pdf",
      "html",
      "deckpkg",
      "speaker-notes"
    ]);
    expect(result.outputs.review?.issuesRemaining).toBe(0);
    expect(
      result.events.filter((event) => event.type === "stage-completed").map((event) => event.stage)
    ).toEqual(["brief", "outline", "visual-direction", "build", "check", "repair", "check", "export", "review"]);
  });

  it("stops the repair loop after a successful check", async () => {
    const result = await runAgent(
      {
        projectRoot,
        brief: "Repair once.",
        provider: createMockProvider({
          checkResults: [createMockFailedCheck(), createMockPassedCheck()]
        }),
        runId: "run-repair-success",
        maxRepairRounds: 3
      },
      {
        clock: fixedClock
      }
    );

    expect(result.ok).toBe(true);
    expect(result.outputs.repairs).toHaveLength(1);
    expect(result.outputs.checks.map((check) => check.summary.errors)).toEqual([1, 0]);
  });

  it("fails after the max repair rounds without exporting", async () => {
    const result = await runAgent(
      {
        projectRoot,
        brief: "Repair until max.",
        provider: createMockProvider({
          checkResults: [createMockFailedCheck()]
        }),
        runId: "run-repair-max",
        maxRepairRounds: 2
      },
      {
        clock: fixedClock
      }
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    if (!result.ok) {
      expect(result.error.code).toBe("check-failed");
      expect(result.error.message).toContain("after 2 repair attempt(s)");
    }
    expect(result.outputs.repairs).toHaveLength(2);
    expect(result.outputs.checks).toHaveLength(3);
    expect(result.outputs.export).toBeUndefined();
  });

  it("records provider errors and leaves partial outputs for recovery", async () => {
    const result = await runAgent(
      {
        projectRoot,
        brief: "Fail while outlining.",
        provider: createMockProvider({
          failStages: ["outline"]
        }),
        runId: "run-provider-error"
      },
      {
        clock: fixedClock
      }
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    if (!result.ok) {
      expect(result.error.code).toBe("provider-error");
      expect(result.error.stage).toBe("outline");
    }
    expect(result.outputs.brief?.title).toBe("Mock HTMLslide Deck");
    expect(result.outputs.outline).toBeUndefined();
    expect(result.events.some((event) => event.type === "stage-failed" && event.stage === "outline")).toBe(true);
  });

  it("cancels an in-flight run and exposes cancellable status", async () => {
    const controller = startAgentRun(
      {
        projectRoot,
        brief: "Cancel this run.",
        provider: createMockProvider({
          delayMs: 25
        }),
        runId: "run-cancel"
      },
      {
        clock: fixedClock
      }
    );

    controller.cancel("No longer needed.");
    expect(controller.getStatus().status).toBe("cancelled");

    const result = await controller.done;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("cancelled");
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
    expect(result.events.some((event) => event.type === "run-cancelled")).toBe(true);
  });

  it("creates checkpoint metadata before model stages", async () => {
    const result = await runMockAgent({ runId: "run-checkpoint" });

    expect(result.checkpoint).toMatchObject({
      id: "checkpoint-run-checkpoint",
      runId: "run-checkpoint",
      projectRoot,
      strategy: "metadata-only",
      sourceRoots: ["deck.json", "slides/", "notes/", "theme/", "assets/"],
      restore: {
        canRevert: false
      }
    });
    expect(result.events[0]?.type).toBe("run-created");
    expect(result.events[1]?.type).toBe("checkpoint-created");
  });

  it("exposes the controlled state-machine transitions", () => {
    expect(canTransitionAgentRunState("idle", "briefing")).toBe(true);
    expect(canTransitionAgentRunState("checking", "repairing")).toBe(true);
    expect(canTransitionAgentRunState("checking", "exporting")).toBe(true);
    expect(canTransitionAgentRunState("completed", "building")).toBe(false);
  });
});
