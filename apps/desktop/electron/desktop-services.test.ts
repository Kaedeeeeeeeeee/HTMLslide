import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCliRuntime,
  loadProjectPreview,
  readDesktopLibrary,
  runDesktopMockAgent,
  summarizeDeckProject,
  upsertRecentProject,
  writeDesktopLibrary,
  type DesktopCliRunner,
  type DesktopProjectRecord
} from "./desktop-services.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeDeck(projectPath: string): Promise<void> {
  await mkdir(path.join(projectPath, "slides"), { recursive: true });
  await mkdir(path.join(projectPath, "notes"), { recursive: true });
  await writeFile(
    path.join(projectPath, "deck.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        id: "deck_desktop_test",
        title: "Desktop Test Deck",
        language: "en",
        aspectRatio: "16:9",
        viewport: { width: 1920, height: 1080 },
        slides: [
          {
            id: "001-title",
            title: "Title",
            source: "slides/001-title.html",
            notes: "notes/001-title.md",
            durationSec: 75,
            kind: "title",
            status: "ready"
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(projectPath, "slides", "001-title.html"),
    `<section class="slide" data-slide-id="001-title"><h1>Title</h1><ul><li>First point</li><li>Second point</li></ul></section>\n`
  );
  await writeFile(path.join(projectPath, "notes", "001-title.md"), "# Notes\n\nSpeaker note body.\n");
}

function projectRecord(projectPath: string, title: string): DesktopProjectRecord {
  return {
    id: `proj_${title}`,
    lastOpenedAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
    path: projectPath,
    slideCount: 1,
    status: "Needs check",
    title
  };
}

describe("desktop services", () => {
  it("creates and updates the desktop library deterministically", async () => {
    const root = await tempDir();
    const libraryPath = path.join(root, "library.json");
    const firstProject = projectRecord(path.join(root, "one"), "One");
    const secondProject = projectRecord(path.join(root, "two"), "Two");

    expect(await readDesktopLibrary(libraryPath, "/workspace")).toEqual({
      defaultWorkspace: "/workspace",
      recentProjects: [],
      version: 1
    });

    await writeDesktopLibrary(libraryPath, {
      defaultWorkspace: "/workspace",
      recentProjects: [firstProject],
      version: 1
    });
    await upsertRecentProject(libraryPath, secondProject, "/workspace");
    await upsertRecentProject(libraryPath, { ...firstProject, status: "Ready" }, "/workspace");

    const raw = JSON.parse(await readFile(libraryPath, "utf8")) as { recentProjects: DesktopProjectRecord[] };
    expect(raw.recentProjects.map((project) => project.title)).toEqual(["One", "Two"]);
    expect(raw.recentProjects[0]?.status).toBe("Ready");
  });

  it("loads a project preview from deck source files", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    const summary = await summarizeDeckProject(projectPath);
    const preview = await loadProjectPreview(projectPath);

    expect(summary.title).toBe("Desktop Test Deck");
    expect(summary.slideCount).toBe(1);
    expect(summary.status).toBe("Needs check");
    expect(preview.slides[0]).toMatchObject({
      bullets: ["First point", "Second point"],
      duration: "1:15",
      id: "001-title",
      speakerNotes: "# Notes\n\nSpeaker note body.",
      status: "ready"
    });
    expect(preview.slides[0]?.html).toContain("data-slide-id=\"001-title\"");
  });

  it("rejects project-relative paths that escape the deck folder", async () => {
    const projectPath = await tempDir();
    await mkdir(path.join(projectPath, "slides"), { recursive: true });
    await writeFile(
      path.join(projectPath, "deck.json"),
      `${JSON.stringify({
        title: "Bad Deck",
        slides: [{ id: "bad", title: "Bad", source: "../outside.html" }]
      })}\n`
    );

    await expect(loadProjectPreview(projectPath)).rejects.toThrow("Unsafe project path");
  });

  it("finds a packaged CLI runtime under Electron resources", async () => {
    const root = await tempDir();
    const resourcesPath = path.join(root, "HTMLslide.app", "Contents", "Resources");
    const cliPath = path.join(resourcesPath, "app", "cli-runtime", "dist", "bin", "htmlslide.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, "#!/usr/bin/env node\n");

    expect(findCliRuntime(path.join(resourcesPath, "app", "dist", "electron"), resourcesPath)).toEqual({
      mode: "packaged",
      cliPath,
      cwd: path.join(resourcesPath, "app", "cli-runtime")
    });
  });

  it("finds the development CLI runtime from a workspace child path", async () => {
    const root = await tempDir();
    const cliPath = path.join(root, "packages", "cli", "dist", "bin", "htmlslide.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(cliPath, "#!/usr/bin/env node\n");

    expect(findCliRuntime(path.join(root, "apps", "desktop", "dist", "electron"))).toEqual({
      mode: "development",
      cliPath,
      cwd: root,
      rootPath: root
    });
  });

  it("runs the mock agent and then real project check/export through the CLI runner", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 1,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              html: path.join(projectPath, "exports", "deck.html"),
              notes: path.join(projectPath, "exports", "notes.json"),
              thumbnails: [path.join(projectPath, "exports", "thumbnails", "001-title.png")]
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDesktopMockAgent(
      {
        brief: "Make a deterministic product-alpha deck",
        projectPath,
        runId: "run-desktop-test"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("htmlslide-mock");
    expect(result.agent.ok).toBe(true);
    expect(result.applied).toMatchObject({
      projectPath,
      title: "Mock HTMLslide Deck",
      slideIds: ["001-title", "002-workflow", "003-review"]
    });
    expect(result.check?.ok).toBe(true);
    expect(result.export?.ok).toBe(true);
    expect(result.project?.project).toMatchObject({
      path: projectPath,
      title: "Mock HTMLslide Deck",
      slideCount: 3
    });
    expect(result.project?.slides.map((slide) => slide.id)).toEqual(["001-title", "002-workflow", "003-review"]);
    expect(result.project?.slides[2]?.html).toContain('data-slide-id="003-review"');
    expect(result.summary).toMatchObject({
      checkErrors: 0,
      checkStatus: "passed",
      checkWarnings: 1,
      completedStages: 8,
      exportStatus: "passed",
      runId: "run-desktop-test",
      status: "succeeded"
    });
    expect(result.summary.exportArtifacts).toEqual([
      path.join(projectPath, "exports", "deck.html"),
      path.join(projectPath, "exports", "notes.json"),
      path.join(projectPath, "exports", "thumbnails", "001-title.png")
    ]);
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "brief",
      "outline",
      "visual-direction",
      "build",
      "check",
      "repair",
      "export",
      "review"
    ]);
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);

    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8"));
    expect(deck.agent.lastRunId).toBe("run-desktop-test");
    expect(deck.slides).toHaveLength(3);
  });

  it("skips export when real project check fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "",
        json: {
          status: "failed",
          summary: {
            errors: 1,
            warnings: 0,
            info: 0,
            suggestions: 0
          },
          issues: [{ severity: "error", type: "missing-file", message: "Missing slide source." }]
        }
      };
    };

    const result = await runDesktopMockAgent(
      {
        brief: "Check without exporting",
        projectPath
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner
      }
    );

    expect(result.ok).toBe(false);
    expect(result.agent.ok).toBe(true);
    expect(result.check?.ok).toBe(false);
    expect(result.export).toBeUndefined();
    expect(result.summary).toMatchObject({
      checkErrors: 1,
      checkStatus: "failed"
    });
    expect(calls).toEqual([["check", projectPath, "--json"]]);
  });
});
