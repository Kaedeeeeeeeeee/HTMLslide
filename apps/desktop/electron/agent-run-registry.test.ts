import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunEvent, AgentRunLog } from "@htmlslide/agent";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopAgentRunRegistry,
  type DesktopAgentRunExecutor,
  type DesktopAgentRunResult
} from "./agent-run-registry.js";

const event = (runId: string, sequence = 1): AgentRunEvent => ({
  runId,
  sequence,
  type: "run-created",
  stage: "brief",
  status: "running",
  summary: "Run created.",
  createdAt: "2026-07-11T00:00:00.000Z"
});

const log = (runId: string): AgentRunLog => ({
  runId,
  stage: "brief",
  level: "info",
  message: "Live log.",
  createdAt: "2026-07-11T00:00:00.000Z"
});

const allStrings = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(allStrings);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [key, ...allStrings(item)]);
  }
  return [];
};

const result = (
  runId: string,
  status: "succeeded" | "failed" | "cancelled" = "succeeded"
): DesktopAgentRunResult => ({
  ok: status === "succeeded",
  providerId: "htmlslide-mock",
  projectPath: "/tmp/deck",
  stages: [],
  events: [event(runId)],
  logs: [log(runId)],
  agent: {
    ok: status === "succeeded",
    status,
    runId,
    outputs: { checks: [], repairs: [] },
    events: [event(runId)],
    logs: [log(runId)]
  },
  summary: {
    runId,
    status,
    stageCount: 1,
    completedStages: status === "succeeded" ? 1 : 0,
    failedStages: status === "failed" ? 1 : 0,
    exportArtifacts: []
  }
} as DesktopAgentRunResult);

describe("DesktopAgentRunRegistry", () => {
  it("returns immediately and publishes live snapshots before completion", async () => {
    let finish: ((value: DesktopAgentRunResult) => void) | undefined;
    const updates: number[] = [];
    const execute: DesktopAgentRunExecutor = (request, control) => {
      control.onEvent(event(request.runId));
      control.onLog(log(request.runId));
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const registry = new DesktopAgentRunRegistry({
      execute,
      onUpdate: (snapshot) => updates.push(snapshot.sequence),
      runIdFactory: () => "run-live"
    });

    const initial = registry.start({ engine: "mock-agent", projectPath: "/tmp/deck", brief: "Build" });
    expect(initial.status).toBe("running");
    expect(registry.get("run-live")).toMatchObject({ events: [{ summary: "Run created." }], logs: [{ message: "Live log." }] });

    finish?.(result("run-live"));
    await vi.waitFor(() => expect(registry.get("run-live")?.status).toBe("succeeded"));
    expect(updates).toEqual([...updates].sort((a, b) => a - b));
  });

  it("prevents concurrent project runs and cancels idempotently", async () => {
    const execute: DesktopAgentRunExecutor = (request, control) => new Promise((resolve) => {
      control.signal.addEventListener("abort", () => resolve(result(request.runId, "cancelled")), { once: true });
    });
    const registry = new DesktopAgentRunRegistry({ execute, runIdFactory: () => "run-cancel" });

    registry.start({ engine: "mock-agent", projectPath: "/tmp/deck", brief: "Build" });
    expect(() => registry.start({ engine: "mock-agent", projectPath: "/tmp/deck", brief: "Again" })).toThrow(
      /already active/
    );
    expect(registry.cancel("run-cancel").status).toBe("cancelling");
    expect(registry.cancel("run-cancel").status).toBe("cancelling");
    await vi.waitFor(() => expect(registry.get("run-cancel")?.status).toBe("cancelled"));
  });

  it("rejects unknown engines at the runtime boundary", () => {
    const registry = new DesktopAgentRunRegistry({
      execute: async (request) => result(request.runId),
      runIdFactory: () => "run-invalid"
    });

    expect(() => registry.start({
      engine: "unexpected" as "mock-agent",
      projectPath: "/tmp/deck",
      brief: "Build"
    })).toThrow(/Unknown agent engine/);
  });

  it("uses the canonical project path for active-run locking and recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-registry-"));
    const projectPath = path.join(root, "deck");
    const aliasPath = path.join(root, "deck-alias");
    await mkdir(projectPath);
    await symlink(projectPath, aliasPath);
    const execute: DesktopAgentRunExecutor = (request, control) => new Promise((resolve) => {
      control.signal.addEventListener("abort", () => resolve(result(request.runId, "cancelled")), { once: true });
    });
    const registry = new DesktopAgentRunRegistry({ execute, runIdFactory: () => "run-canonical" });

    try {
      const started = registry.start({ engine: "mock-agent", projectPath, brief: "Build" });
      expect(registry.getActive(aliasPath)?.runId).toBe(started.runId);
      expect(() => registry.start({ engine: "mock-agent", projectPath: aliasPath, brief: "Again" })).toThrow(
        /already active/
      );
      registry.cancel(started.runId);
      await vi.waitFor(() => expect(registry.get(started.runId)?.status).toBe("cancelled"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles fast terminal runs and waits for cancellation drain", async () => {
    const execute = vi.fn<DesktopAgentRunExecutor>(async (request, control) => {
      if (request.brief === "fast") {
        return result(request.runId);
      }
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      return result(request.runId, "cancelled");
    });
    const ids = ["run-fast", "run-drain"];
    const registry = new DesktopAgentRunRegistry({ execute, runIdFactory: () => ids.shift() ?? "run-extra" });

    registry.start({ engine: "mock-agent", projectPath: "/tmp/fast", brief: "fast" });
    await vi.waitFor(() => expect(registry.get("run-fast")?.status).toBe("succeeded"));
    registry.start({ engine: "mock-agent", projectPath: "/tmp/drain", brief: "wait" });
    await registry.cancelAllAndWait("Quit", 1_000);
    expect(registry.get("run-drain")?.status).toBe("cancelled");
  });

  it("caps live and terminal log delivery", async () => {
    const execute: DesktopAgentRunExecutor = async (request, control) => {
      for (let index = 0; index < 20; index += 1) {
        control.onLog({
          ...log(request.runId),
          message: index === 0 ? `api_key=sk-${"x".repeat(20_000)}` : `Log ${index}`
        });
      }
      return {
        ...result(request.runId),
        logs: Array.from({ length: 20 }, (_, index) => ({
          ...log(request.runId),
          message: index === 0 ? "y".repeat(20_000) : `Final ${index}`
        }))
      } as DesktopAgentRunResult;
    };
    const registry = new DesktopAgentRunRegistry({
      execute,
      maxLogsPerRun: 10,
      runIdFactory: () => "run-logs"
    });

    registry.start({ engine: "mock-agent", projectPath: "/tmp/logs", brief: "Build" });
    await vi.waitFor(() => expect(registry.get("run-logs")?.status).toBe("succeeded"));
    expect(registry.get("run-logs")?.logs).toHaveLength(10);
    expect(registry.get("run-logs")?.logs[0]?.message.length).toBeLessThanOrEqual(8_192);
    expect(registry.get("run-logs")?.logs[0]?.message).not.toContain("sk-");
    expect(registry.get("run-logs")?.logs.at(-1)?.message).toMatch(/truncated/);
  });

  it("delivers a compact terminal shape without provider sourceWrites content", { timeout: 15_000 }, async () => {
    const sourceSentinel = "PRIVATE_PROVIDER_SLIDE_SOURCE_MUST_NOT_CROSS_IPC";
    const secret = "sk-providersecret123456789";
    const huge = `api_key=${secret} ${"x".repeat(100_000)}`;
    const execute: DesktopAgentRunExecutor = async (request) => {
      const mock = result(request.runId);
      if (mock.providerId !== "htmlslide-mock") {
        throw new Error("Expected mock fixture.");
      }
      const checkpoint = {
        id: `checkpoint-${request.runId}`,
        runId: request.runId,
        projectRoot: "/tmp/deck",
        strategy: "file-copy" as const,
        createdAt: "2026-07-11T00:00:00.000Z",
        label: "Before provider run",
        sourceRoots: ["deck.json", "slides"],
        files: Array.from({ length: 250 }, (_, index) => ({
          path: `slides/${index}.html`,
          status: "modified" as const,
          digest: huge
        })),
        restore: { canRevert: true, notes: huge }
      };
      const diffFiles = Array.from({ length: 250 }, (_, index) => ({
        path: `slides/${index}.html`,
        status: "modified" as const,
        digest: huge
      }));

      return {
        ...mock,
        providerId: "htmlslide-byok",
        settings: { provider: "openai", model: huge },
        events: Array.from({ length: 250 }, (_, index) => ({
          ...event(request.runId, index),
          summary: huge,
          metadata: { secret, nested: Array.from({ length: 100 }, () => huge) }
        })),
        logs: Array.from({ length: 150 }, () => ({ ...log(request.runId), message: huge })),
        agent: {
          ...mock.agent,
          checkpoint,
          outputs: {
            ...mock.agent.outputs,
            build: {
              filesChanged: ["slides/001-title.html"],
              slidesChanged: ["001-title"],
              notesChanged: [],
              themeChanged: [],
              sourceWrites: [{ path: "slides/001-title.html", content: `${sourceSentinel}${huge}` }]
            },
            repairs: [{
              attempt: 1,
              filesChanged: ["slides/001-title.html"],
              issuesAddressed: ["overflow"],
              sourceWrites: [{ path: "slides/001-title.html", content: `${sourceSentinel}${huge}` }]
            }]
          },
          events: Array.from({ length: 250 }, (_, index) => ({
            ...event(request.runId, index),
            summary: huge
          })),
          logs: Array.from({ length: 150 }, () => ({ ...log(request.runId), message: huge }))
        },
        applied: {
          projectPath: "/tmp/deck",
          source: "provider-source-writes",
          filesChanged: ["slides/001-title.html"],
          writeCount: 1,
          stages: [{ stage: "build", filesChanged: ["slides/001-title.html"], writeCount: 1 }]
        },
        checkpointDiff: {
          checkpoint,
          changed: diffFiles,
          added: diffFiles,
          deleted: diffFiles,
          unchanged: diffFiles,
          textDiffs: Array.from({ length: 60 }, (_, index) => ({
            path: `slides/${index}.html`,
            status: "modified" as const,
            language: "html" as const,
            lines: Array.from({ length: 10 }, () => ({ type: "added" as const, text: huge })),
            truncated: false
          })),
          summary: { changed: 250, added: 250, deleted: 250, unchanged: 250 }
        },
        check: {
          ok: false,
          exitCode: 2,
          stdout: huge,
          stderr: huge,
          json: {
            status: "failed",
            issues: Array.from({ length: 250 }, (_, index) => ({
              severity: "error",
              type: `provider-${index}`,
              message: huge,
              metadata: { secret, values: Array.from({ length: 250 }, () => huge) }
            }))
          }
        },
        export: { ok: true, exitCode: 0, stdout: huge, stderr: "", json: { artifacts: ["exports/deck.pdf"] } },
        project: {
          project: {
            id: "deck",
            title: "Deck",
            path: "/tmp/deck",
            lastOpenedAt: "2026-07-11T00:00:00.000Z",
            status: "Ready",
            slideCount: 1
          },
          slides: [{
            id: "001-title",
            number: "01",
            title: "Title",
            section: "Intro",
            status: "ready",
            duration: "1 min",
            accent: "#000000",
            speakerNotes: huge,
            bullets: ["One"],
            sourcePath: "slides/001-title.html"
          }]
        },
        summary: {
          ...mock.summary,
          provider: "openai",
          model: "gpt-test"
        }
      } as DesktopAgentRunResult;
    };
    const registry = new DesktopAgentRunRegistry({ execute, runIdFactory: () => "run-provider-bounds" });

    registry.start({ engine: "htmlslide-agent", projectPath: "/tmp/deck", brief: "Build" });
    await vi.waitFor(() => expect(registry.get("run-provider-bounds")?.status).toBe("succeeded"));
    const snapshot = registry.get("run-provider-bounds");
    expect(snapshot?.events).toHaveLength(200);
    expect(snapshot?.logs).toHaveLength(100);
    expect(snapshot?.result?.providerId).toBe("htmlslide-byok");
    if (snapshot?.result?.providerId !== "htmlslide-byok") {
      throw new Error("Expected compact BYOK result.");
    }

    expect(snapshot.result.agent?.outputs.build).not.toHaveProperty("sourceWrites");
    expect(snapshot.result.agent?.outputs.repairs[0]).not.toHaveProperty("sourceWrites");
    expect(snapshot.result.applied).toMatchObject({ writeCount: 1, filesChanged: ["slides/001-title.html"] });
    expect(snapshot.result.project?.project.id).toBe("deck");
    expect(snapshot.result.check?.stdout.length).toBeLessThanOrEqual(32_768);
    expect(snapshot.result.check?.stderr.length).toBeLessThanOrEqual(32_768);
    expect((snapshot.result.check?.json as { issues: unknown[] }).issues).toHaveLength(200);
    expect(snapshot.result.checkpointDiff?.changed).toHaveLength(200);
    expect(snapshot.result.checkpointDiff?.textDiffs).toHaveLength(50);
    expect(snapshot.result.checkpointDiff?.textDiffs.flatMap((diff) => diff.lines)).toHaveLength(400);
    expect(snapshot.result.checkpointDiff?.textDiffs.flatMap((diff) => diff.lines).every((line) => line.text.length <= 1_024)).toBe(true);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(sourceSentinel);
    expect(serialized).not.toContain(secret);
    expect(allStrings(snapshot).every((value) => value.length <= 32_768)).toBe(true);
  });

  it("bounds and sanitizes external adapter output and collections", async () => {
    const secret = "sk-adaptersecret123456789";
    const huge = `Bearer ${secret} ${"z".repeat(100_000)}`;
    const execute: DesktopAgentRunExecutor = async (request) => {
      const mock = result(request.runId);
      return {
        ok: true,
        providerId: "external-agent",
        projectPath: "/tmp/external",
        stages: mock.stages,
        events: mock.events,
        logs: mock.logs,
        adapter: {
          ok: true,
          status: "completed",
          adapter: { id: "generic", label: huge, kind: "generic", capabilities: { headlessRun: true } },
          command: { command: "agent", args: Array.from({ length: 250 }, () => huge) },
          cwd: "/tmp/external",
          stdout: huge,
          stderr: huge,
          reportedWrites: Array.from({ length: 250 }, (_, index) => `slides/${index}.html`)
        },
        summary: {
          runId: request.runId,
          status: "succeeded",
          stageCount: 1,
          completedStages: 1,
          failedStages: 0,
          exportArtifacts: [],
          filesChanged: ["slides/001-title.html"]
        }
      };
    };
    const registry = new DesktopAgentRunRegistry({ execute, runIdFactory: () => "run-adapter-bounds" });

    registry.start({ engine: "external-agent", projectPath: "/tmp/external", brief: "Build" });
    await vi.waitFor(() => expect(registry.get("run-adapter-bounds")?.status).toBe("succeeded"));
    const snapshot = registry.get("run-adapter-bounds");
    if (snapshot?.result?.providerId !== "external-agent" || !snapshot.result.adapter) {
      throw new Error("Expected compact external result.");
    }
    expect(snapshot.result.adapter.stdout?.length).toBeLessThanOrEqual(32_768);
    expect(snapshot.result.adapter.stderr?.length).toBeLessThanOrEqual(32_768);
    expect(snapshot.result.adapter.reportedWrites).toHaveLength(200);
    expect(snapshot.result.adapter.command?.args).toHaveLength(200);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("retries terminal failures with a new run id and bounds terminal history", async () => {
    const ids = ["run-one", "run-two", "run-three"];
    const execute = vi.fn<DesktopAgentRunExecutor>(async (request) => result(request.runId, "failed"));
    const registry = new DesktopAgentRunRegistry({
      execute,
      maxTerminalRuns: 1,
      runIdFactory: () => ids.shift() ?? "run-extra"
    });

    registry.start({ engine: "mock-agent", projectPath: "/tmp/deck", brief: "Build" });
    await vi.waitFor(() => expect(registry.get("run-one")?.status).toBe("failed"));
    const retry = registry.retry("run-one");
    expect(retry.runId).toBe("run-two");
    await vi.waitFor(() => expect(registry.get("run-two")?.status).toBe("failed"));
    expect(registry.get("run-one")).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
