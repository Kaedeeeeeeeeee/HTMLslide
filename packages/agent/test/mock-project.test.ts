import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMockAgentProject,
  createMockFailedCheck,
  createMockPassedCheck,
  createMockProvider,
  runAgent
} from "../src/index.js";

const fixedClock = (): Date => new Date("2026-07-09T00:00:00.000Z");
const tempRoots: string[] = [];

const createTempProject = async (): Promise<string> => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-apply-"));
  tempRoots.push(projectPath);
  return projectPath;
};

const runSuccessfulMockAgent = async (
  projectPath: string,
  targetSlideCount?: number,
  speakerNotesMode: "none" | "bullet-notes" | "full-script" | "rehearsal-cues" = "bullet-notes"
) =>
  runAgent(
    {
      projectRoot: projectPath,
      brief: "Create a short deck about controlled HTMLslide agent runs.",
      provider: createMockProvider({
        checkResults: [createMockPassedCheck()]
      }),
      runId: "run-apply-mock",
      speakerNotesMode,
      targetSlideCount
    },
    {
      clock: fixedClock
    }
  );

const readProjectFiles = async (projectPath: string, files: readonly string[]): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(projectPath, ...file.split("/")), "utf8")] as const)
  );
  return Object.fromEntries(entries);
};

const expectMissing = async (filePath: string): Promise<void> => {
  await expect(access(filePath)).rejects.toThrow();
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("applyMockAgentProject", () => {
  it("writes deterministic HTMLslide source files from a successful mock run", async () => {
    const projectPath = await createTempProject();
    const result = await runSuccessfulMockAgent(projectPath);

    const applied = await applyMockAgentProject({ projectPath, result });

    expect(applied.filesChanged).toEqual([
      "deck.json",
      "slides/001-title.html",
      "slides/002-workflow.html",
      "slides/003-review.html",
      "notes/001-title.md",
      "notes/002-workflow.md",
      "notes/003-review.md",
      "theme/theme.css",
      "theme/tokens.json"
    ]);
    expect(applied.slideIds).toEqual(["001-title", "002-workflow", "003-review"]);
    expect(applied.paths).toEqual({
      deck: "deck.json",
      slides: ["slides/001-title.html", "slides/002-workflow.html", "slides/003-review.html"],
      notes: ["notes/001-title.md", "notes/002-workflow.md", "notes/003-review.md"],
      theme: ["theme/theme.css", "theme/tokens.json"]
    });

    const files = await readProjectFiles(projectPath, applied.filesChanged);
    const deck = JSON.parse(files["deck.json"] ?? "{}");

    expect(deck).toMatchObject({
      schemaVersion: "0.1.0",
      id: "mock_htmlslide_deck",
      title: "Mock HTMLslide Deck",
      language: "en-US",
      theme: {
        css: "theme/theme.css",
        tokens: "theme/tokens.json"
      },
      agent: {
        preferredEngine: "htmlslide-mock",
        lastRunId: "run-apply-mock"
      }
    });
    expect(deck.slides.map((slide: { id: string; source: string; notes: string }) => ({
      id: slide.id,
      source: slide.source,
      notes: slide.notes
    }))).toEqual([
      { id: "001-title", source: "slides/001-title.html", notes: "notes/001-title.md" },
      { id: "002-workflow", source: "slides/002-workflow.html", notes: "notes/002-workflow.md" },
      { id: "003-review", source: "slides/003-review.html", notes: "notes/003-review.md" }
    ]);
    expect(files["slides/001-title.html"]).toContain('data-slide-id="001-title"');
    expect(files["slides/002-workflow.html"]).toContain('data-slide-id="002-workflow"');
    expect(files["slides/003-review.html"]).toContain('data-slide-id="003-review"');
    expect(deck.speakerNotesMode).toBe("bullet-notes");
    expect(files["notes/001-title.md"]).toContain("- Goal:");
    expect(files["notes/002-workflow.md"]).toContain("- Context:");
    expect(files["theme/theme.css"]).not.toMatch(/https?:\/\//i);
    expect(files["theme/tokens.json"]).toContain('"accent": "#2357d9"');
  });

  it.each([
    ["none", false],
    ["bullet-notes", true],
    ["full-script", true],
    ["rehearsal-cues", true]
  ] as const)("applies the %s mode to manifest paths and generated notes", async (mode, hasNotes) => {
    const projectPath = await createTempProject();
    const result = await runSuccessfulMockAgent(projectPath, undefined, mode);
    const applied = await applyMockAgentProject({ projectPath, result });
    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as {
      speakerNotesMode?: string;
      slides: Array<{ notes?: string }>;
      export: { speakerNotes: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.outputs.speakerNotesMode).toBe(mode);
    expect(deck.speakerNotesMode).toBe(mode);
    expect(deck.export.speakerNotes).toBe(hasNotes);
    expect(deck.slides.every((slide) => slide.notes !== undefined)).toBe(hasNotes);
    expect(applied.paths.notes).toHaveLength(hasNotes ? 3 : 0);
    if (hasNotes) {
      await expect(readFile(path.join(projectPath, "notes", "001-title.md"), "utf8")).resolves.toContain(
        mode === "full-script" ? "deterministic mock deck" : mode === "rehearsal-cues" ? "Cue:" : "- Goal:"
      );
    } else {
      await expectMissing(path.join(projectPath, "notes", "001-title.md"));
    }
  });

  it("removes template note files when none is selected", async () => {
    const projectPath = await createTempProject();
    await mkdir(path.join(projectPath, "notes"), { recursive: true });
    await writeFile(path.join(projectPath, "notes", "001-title.md"), "Old notes\n", "utf8");
    const result = await runSuccessfulMockAgent(projectPath, undefined, "none");

    await applyMockAgentProject({ projectPath, result });

    await expectMissing(path.join(projectPath, "notes", "001-title.md"));
  });

  it("overwrites the same successful result with byte-stable content", async () => {
    const projectPath = await createTempProject();
    const result = await runSuccessfulMockAgent(projectPath);
    const firstApply = await applyMockAgentProject({ projectPath, result });
    const firstFiles = await readProjectFiles(projectPath, firstApply.filesChanged);

    const secondApply = await applyMockAgentProject({ projectPath, result });
    const secondFiles = await readProjectFiles(projectPath, secondApply.filesChanged);

    expect(secondApply).toEqual(firstApply);
    expect(secondFiles).toEqual(firstFiles);
  });

  it("writes every slide from an explicit multi-slide target", async () => {
    const projectPath = await createTempProject();
    const result = await runSuccessfulMockAgent(projectPath, 8);

    const applied = await applyMockAgentProject({ projectPath, result });
    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as {
      slides: Array<{ id: string; source: string; notes: string }>;
    };

    expect(applied.slideIds).toHaveLength(8);
    expect(applied.paths.slides).toHaveLength(8);
    expect(applied.paths.notes).toHaveLength(8);
    expect(deck.slides.map((slide) => slide.id)).toEqual(applied.slideIds);
    await expect(readFile(path.join(projectPath, "slides", "008-review.html"), "utf8"))
      .resolves.toContain('data-slide-id="008-review"');
    await expect(readFile(path.join(projectPath, "notes", "003-detail.md"), "utf8"))
      .resolves.toContain("supporting point");
  });

  it("refuses a non-successful result without writing project files", async () => {
    const projectPath = await createTempProject();
    const failedResult = await runAgent(
      {
        projectRoot: projectPath,
        brief: "This run should not apply.",
        provider: createMockProvider({
          checkResults: [createMockFailedCheck()]
        }),
        runId: "run-apply-failed",
        maxRepairRounds: 0
      },
      {
        clock: fixedClock
      }
    );

    expect(failedResult.ok).toBe(false);
    await expect(applyMockAgentProject({ projectPath, result: failedResult })).rejects.toThrow(
      "non-successful agent run"
    );
    await expectMissing(path.join(projectPath, "deck.json"));
    await expectMissing(path.join(projectPath, "slides", "001-title.html"));
    await expectMissing(path.join(projectPath, "theme", "tokens.json"));
  });
});
