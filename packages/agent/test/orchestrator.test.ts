import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canTransitionAgentRunState,
  createFileCopyCheckpoint,
  createMockFailedCheck,
  createMockPassedCheck,
  createMockProvider,
  runAgent,
  startAgentRun,
  type AgentRunEvent,
  type AgentRunLog,
  type AgentRunStage,
  type ModelRequest,
  type ModelResponse
} from "../src/index.js";

let projectRoot = "";
const fixedClock = (): Date => new Date("2026-07-09T00:00:00.000Z");

const createProjectFixture = async (): Promise<string> => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-orchestrator-"));
  await Promise.all([
    mkdir(path.join(fixtureRoot, "slides"), { recursive: true }),
    mkdir(path.join(fixtureRoot, "notes"), { recursive: true }),
    mkdir(path.join(fixtureRoot, "theme"), { recursive: true }),
    mkdir(path.join(fixtureRoot, "assets"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(fixtureRoot, "deck.json"), '{"schemaVersion":"0.1.0","id":"fixture","title":"Fixture","language":"en-US","aspectRatio":"16:9","viewport":{"width":1600,"height":900},"slides":[{"id":"001-title","title":"Title","source":"slides/001-title.html"}]}\n', "utf8"),
    writeFile(path.join(fixtureRoot, "slides", "001-title.html"), '<section data-slide-id="001-title">Fixture</section>\n', "utf8"),
    writeFile(path.join(fixtureRoot, "notes", "001-title.md"), "# Fixture\n", "utf8"),
    writeFile(path.join(fixtureRoot, "theme", "theme.css"), ".slide { color: black; }\n", "utf8"),
    writeFile(path.join(fixtureRoot, "assets", "data.json"), '{"fixture":true}\n', "utf8")
  ]);
  return fixtureRoot;
};

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

beforeEach(async () => {
  projectRoot = await createProjectFixture();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  projectRoot = "";
});

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

  it("propagates an explicit slide target and makes mock stage output honor it", async () => {
    const baseProvider = createMockProvider({
      checkResults: [createMockPassedCheck()]
    });
    const requests: ModelRequest[] = [];
    const provider = {
      ...baseProvider,
      validateCredentials: () => baseProvider.validateCredentials(),
      complete: async (request: ModelRequest): Promise<ModelResponse> => {
        requests.push(request);
        return baseProvider.complete(request);
      }
    };

    const result = await runMockAgent({
      provider,
      runId: "run-target-count",
      targetSlideCount: 8
    });

    expect(result.ok).toBe(true);
    expect(result.outputs.outline?.slides).toHaveLength(8);
    expect(result.outputs.build?.slidesChanged).toHaveLength(8);
    expect(result.outputs.build?.slidesChanged).toEqual(result.outputs.outline?.slides.map((slide) => slide.id));
    expect(requests).not.toHaveLength(0);
    for (const request of requests) {
      expect(request.input).toMatchObject({ targetSlideCount: 8 });
      expect(request.metadata).toMatchObject({ targetSlideCount: 8 });
    }
    expect(requests.find((request) => request.stage === "outline")?.prompt).toContain("exactly 8 slide(s)");
    expect(requests.find((request) => request.stage === "export")?.prompt).not.toContain("exactly 8 slide(s)");
  });

  it("rejects an explicit outline count mismatch before visual and build stages", async () => {
    const baseProvider = createMockProvider({
      checkResults: [createMockPassedCheck()]
    });
    const requestedStages: AgentRunStage[] = [];
    const provider = {
      ...baseProvider,
      validateCredentials: () => baseProvider.validateCredentials(),
      complete: async (request: ModelRequest): Promise<ModelResponse> => {
        requestedStages.push(request.stage);
        const response = await baseProvider.complete(request);
        if (request.stage !== "outline") {
          return response;
        }

        const outline = response.output as { slides: unknown[] };
        return {
          ...response,
          output: {
            ...outline,
            slides: outline.slides.slice(0, 3)
          }
        };
      }
    };

    const result = await runMockAgent({
      provider,
      runId: "run-target-mismatch",
      targetSlideCount: 4
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "invalid-output",
        message: "Outline stage returned 3 slide(s); expected exactly 4.",
        stage: "outline"
      });
    }
    expect(result.outputs.outline).toBeUndefined();
    expect(requestedStages).toEqual(["brief", "outline"]);
    expect(result.events.some((event) => event.type === "stage-failed" && event.stage === "outline")).toBe(true);
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

  it("passes the speaker notes mode through every model request and run output", async () => {
    const baseProvider = createMockProvider({
      checkResults: [createMockPassedCheck()]
    });
    const requests: ModelRequest[] = [];
    const provider = {
      ...baseProvider,
      validateCredentials: () => baseProvider.validateCredentials(),
      complete: async (request: ModelRequest): Promise<ModelResponse> => {
        requests.push(request);
        return baseProvider.complete(request);
      }
    };

    const result = await runAgent({
      projectRoot,
      brief: "Rehearse this deck.",
      provider,
      runId: "run-notes-mode",
      speakerNotesMode: "rehearsal-cues"
    }, { clock: fixedClock });

    expect(result.ok).toBe(true);
    expect(result.outputs.speakerNotesMode).toBe("rehearsal-cues");
    expect(requests.find((request) => request.stage === "build")?.input).toMatchObject({
      speakerNotesMode: "rehearsal-cues"
    });
    expect(requests.find((request) => request.stage === "build")?.metadata).toMatchObject({
      speakerNotesMode: "rehearsal-cues"
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

  it("delivers events and logs while a run is still in progress", async () => {
    const baseProvider = createMockProvider({
      checkResults: [createMockPassedCheck()]
    });
    let releaseBrief: (() => void) | undefined;
    const briefGate = new Promise<void>((resolve) => {
      releaseBrief = resolve;
    });
    const provider = {
      ...baseProvider,
      complete: async (request: ModelRequest): Promise<ModelResponse> => {
        if (request.stage === "brief") {
          await briefGate;
        }
        return baseProvider.complete(request);
      }
    };
    const observedEvents: AgentRunEvent[] = [];
    const observedLogs: AgentRunLog[] = [];
    let doneSettled = false;

    const controller = startAgentRun(
      {
        projectRoot,
        brief: "Observe this run live.",
        provider,
        runId: "run-live-observer"
      },
      {
        clock: fixedClock,
        onEvent: (event) => observedEvents.push(event),
        onLog: (log) => observedLogs.push(log)
      }
    );
    void controller.done.then(() => {
      doneSettled = true;
    });

    await vi.waitFor(() => {
      expect(observedEvents.some((event) => event.type === "stage-started" && event.stage === "brief")).toBe(true);
      expect(observedLogs.some((log) => log.stage === "brief" && log.message === "brief started.")).toBe(true);
    });
    expect(doneSettled).toBe(false);
    expect(controller.getStatus().status).toBe("running");

    releaseBrief?.();
    await expect(controller.done).resolves.toMatchObject({
      ok: true,
      status: "succeeded"
    });
  });

  it("delivers observers in the same append order as the final result", async () => {
    const observedEvents: AgentRunEvent[] = [];
    const observedLogs: AgentRunLog[] = [];
    const result = await runAgent(
      {
        projectRoot,
        brief: "Preserve observer ordering.",
        provider: createMockProvider({
          checkResults: [createMockPassedCheck()]
        }),
        runId: "run-observer-order"
      },
      {
        clock: fixedClock,
        onEvent: (event) => observedEvents.push(event),
        onLog: (log) => observedLogs.push(log)
      }
    );

    expect(observedEvents).toEqual(result.events);
    expect(observedLogs).toEqual(result.logs);
    expect(observedEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: observedEvents.length }, (_, index) => index + 1)
    );
    expect(observedEvents.at(-1)?.type).toBe("run-completed");
  });

  it("isolates synchronous throws and async rejections without affecting the run", async () => {
    let eventCalls = 0;
    let logCalls = 0;
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      const result = await runAgent(
        {
          projectRoot,
          brief: "Ignore observer failures.",
          provider: createMockProvider({
            checkResults: [createMockPassedCheck()]
          }),
          runId: "run-observer-errors"
        },
        {
          clock: fixedClock,
          onEvent: () => {
            eventCalls += 1;
            if (eventCalls === 1) {
              throw new Error("event observer threw");
            }
            return Promise.reject(new Error("event observer rejected"));
          },
          onLog: () => {
            logCalls += 1;
            if (logCalls === 1) {
              throw new Error("log observer threw");
            }
            return Promise.reject(new Error("log observer rejected"));
          }
        }
      );

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.ok).toBe(true);
      expect(result.status).toBe("succeeded");
      expect(eventCalls).toBe(result.events.length);
      expect(logCalls).toBe(result.logs.length);
      expect(result.logs.every((log) => log.level === "info")).toBe(true);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", recordUnhandledRejection);
    }
  });

  it("delivers cancellation once without duplicating the terminal event", async () => {
    const observedEvents: AgentRunEvent[] = [];
    const observedLogs: AgentRunLog[] = [];
    const controller = startAgentRun(
      {
        projectRoot,
        brief: "Cancel after observer delivery starts.",
        provider: createMockProvider({
          delayMs: 1_000
        }),
        runId: "run-cancel-observer"
      },
      {
        clock: fixedClock,
        onEvent: (event) => observedEvents.push(event),
        onLog: (log) => observedLogs.push(log)
      }
    );

    await vi.waitFor(() => {
      expect(observedEvents.some((event) => event.type === "stage-started" && event.stage === "brief")).toBe(true);
    });
    controller.cancel("Stopped by observer test.");

    expect(observedEvents.filter((event) => event.type === "run-cancelled")).toHaveLength(1);
    expect(observedLogs.filter((log) => log.level === "warning" && log.message === "Stopped by observer test.")).toHaveLength(
      1
    );

    const result = await controller.done;
    expect(result.status).toBe("cancelled");
    expect(result.events.filter((event) => event.type === "run-cancelled")).toHaveLength(1);
    expect(observedEvents).toEqual(result.events);
    expect(observedLogs).toEqual(result.logs);
  });

  it("creates a reversible file-copy checkpoint before model stages", async () => {
    const result = await runMockAgent({ runId: "run-checkpoint" });

    expect(result.checkpoint).toMatchObject({
      id: "checkpoint-run-checkpoint",
      runId: "run-checkpoint",
      projectRoot,
      strategy: "file-copy",
      sourceRoots: ["deck.json", "slides/", "notes/", "theme/", "assets/"],
      restore: {
        canRevert: true
      }
    });
    const checkpointRoot = path.join(projectRoot, ".htmlslide", "checkpoints", "run-checkpoint");
    await expect(access(path.join(checkpointRoot, "manifest.json"))).resolves.toBeUndefined();
    await expect(access(path.join(checkpointRoot, "snapshot"))).resolves.toBeUndefined();
    await expect(readFile(path.join(checkpointRoot, "snapshot", "deck.json"), "utf8")).resolves.toContain(
      '"id":"fixture"'
    );
    await expect(readFile(path.join(checkpointRoot, "manifest.json"), "utf8")).resolves.toContain('"strategy": "file-copy"');
    expect(result.events[0]?.type).toBe("run-created");
    expect(result.events[1]?.type).toBe("checkpoint-created");
  });

  it("uses a caller-provided checkpoint callback instead of the default", async () => {
    const checkpoint = await createFileCopyCheckpoint({
      runId: "run-custom-checkpoint",
      projectRoot,
      createdAt: fixedClock().toISOString()
    });
    const createCheckpoint = vi.fn(async () => checkpoint);

    const result = await runMockAgent({
      runId: "run-custom-checkpoint",
      createCheckpoint
    });

    expect(createCheckpoint).toHaveBeenCalledWith({
      runId: "run-custom-checkpoint",
      projectRoot,
      createdAt: fixedClock().toISOString()
    });
    expect(result.checkpoint).toEqual(checkpoint);
  });

  it("exposes the controlled state-machine transitions", () => {
    expect(canTransitionAgentRunState("idle", "briefing")).toBe(true);
    expect(canTransitionAgentRunState("checking", "repairing")).toBe(true);
    expect(canTransitionAgentRunState("checking", "exporting")).toBe(true);
    expect(canTransitionAgentRunState("completed", "building")).toBe(false);
  });
});
