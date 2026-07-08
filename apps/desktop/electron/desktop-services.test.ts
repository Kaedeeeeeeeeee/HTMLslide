import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffDesktopCheckpoint,
  findCliRuntime,
  getDesktopCliIntegration,
  installDesktopCliIntegration,
  loadDesktopPresenterDeck,
  loadProjectPreview,
  readDesktopLibrary,
  resolveDesktopCliIntegrationTarget,
  resolveCreateProjectRequest,
  revertDesktopCheckpoint,
  runDesktopExternalAgent,
  runDesktopMockAgent,
  summarizeDeckProject,
  uninstallDesktopCliIntegration,
  upsertRecentProject,
  writeDesktopLibrary,
  type CliRunResult,
  type DesktopCliRunner,
  type DesktopAiEngineSettings,
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

function externalAgentSettings(commandTemplate: string, selectedId: "claude-code" | "codex-cli" | "generic" = "generic"): DesktopAiEngineSettings {
  return {
    apiKey: {
      hasKey: false,
      model: "gpt-5-mini",
      provider: "openai"
    },
    externalAgent: {
      customCommand: commandTemplate,
      selectedId
    },
    mode: "external-agent",
    version: 1
  };
}

async function writeExternalAgentScript(projectPath: string, name: string, source: string): Promise<string> {
  const scriptFile = path.join(projectPath, ".htmlslide", "runs", `${name}.mjs`);
  await mkdir(path.dirname(scriptFile), { recursive: true });
  await writeFile(scriptFile, source.trimStart(), "utf8");
  return scriptFile;
}

describe("desktop services", () => {
  it("resolves new deck requests inside the selected workspace", async () => {
    const workspacePath = await tempDir();

    expect(
      resolveCreateProjectRequest({
        folderName: "quarterly-launch-review",
        title: "  Quarterly Launch Review  ",
        workspacePath
      })
    ).toEqual({
      folderName: "quarterly-launch-review",
      projectPath: path.join(workspacePath, "quarterly-launch-review"),
      title: "Quarterly Launch Review",
      workspacePath
    });
  });

  it("rejects unsafe new deck folder names", async () => {
    const workspacePath = await tempDir();

    for (const folderName of ["../escape", "Escape", ".hidden", "deck/child", "deck child", "deck..child"]) {
      expect(() =>
        resolveCreateProjectRequest({
          folderName,
          title: "Deck",
          workspacePath
        })
      ).toThrow();
    }
  });

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

  it("resolves the app-managed CLI target from environment overrides", async () => {
    const root = await tempDir();
    const target = await resolveDesktopCliIntegrationTarget({
      HTMLSLIDE_CLI_TARGET_DIR: path.join(root, "bin"),
      HTMLSLIDE_HOME: path.join(root, "state")
    });

    expect(target).toEqual({
      htmlslideHomeDir: path.join(root, "state"),
      source: "env",
      targetDir: path.join(root, "bin"),
      targetPath: path.join(root, "bin", "htmlslide")
    });
  });

  it("checks, installs, and uninstalls the app-managed CLI shim through the embedded CLI", async () => {
    const root = await tempDir();
    const targetDir = path.join(root, "bin");
    const homeDir = path.join(root, "state");
    const cliRuntime = {
      cliPath: path.join(root, "cli-runtime", "htmlslide.js"),
      cwd: path.join(root, "cli-runtime"),
      mode: "development" as const,
      rootPath: root
    };
    const calls: string[][] = [];
    const resultFor = (args: string[]): CliRunResult => {
      if (args[0] === "setup" && args[1] === "status") {
        return {
          exitCode: 0,
          json: {
            command: "setup status",
            htmlslideHomeDir: homeDir,
            installed: false,
            managed: false,
            message: `HTMLslide CLI shim is not installed at ${path.join(targetDir, "htmlslide")}.`,
            onPath: false,
            status: "info",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      if (args[0] === "setup" && args[1] === "install-cli") {
        return {
          exitCode: 0,
          json: {
            action: "installed",
            command: "setup install-cli",
            htmlslideHomeDir: homeDir,
            message: `Installed HTMLslide CLI shim at ${path.join(targetDir, "htmlslide")}.`,
            status: "passed",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      if (args[0] === "setup" && args[1] === "uninstall-cli") {
        return {
          exitCode: 0,
          json: {
            action: "removed",
            command: "setup uninstall-cli",
            htmlslideHomeDir: homeDir,
            message: `Removed HTMLslide CLI shim from ${path.join(targetDir, "htmlslide")}.`,
            status: "passed",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      throw new Error(`Unexpected CLI integration call: ${args.join(" ")}`);
    };
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return resultFor(args);
    };
    const options = {
      appPath: path.join(root, "HTMLslide.app"),
      appVersion: "0.1.0-test",
      bundleId: "app.htmlslide.test",
      cliRuntime,
      cliRunner: runner,
      env: {
        HTMLSLIDE_CLI_TARGET_DIR: targetDir,
        HTMLSLIDE_HOME: homeDir
      },
      now: "2026-07-08T00:00:00.000Z"
    };

    const status = await getDesktopCliIntegration(options);
    expect(status).toMatchObject({
      available: true,
      installed: false,
      manualInstallCommand: expect.stringContaining("setup"),
      mode: "development",
      status: "info",
      targetPath: path.join(targetDir, "htmlslide")
    });

    const installed = await installDesktopCliIntegration(options);
    expect(installed).toMatchObject({
      action: "installed",
      available: true,
      message: `Installed HTMLslide CLI shim at ${path.join(targetDir, "htmlslide")}.`,
      targetPath: path.join(targetDir, "htmlslide")
    });

    const uninstalled = await uninstallDesktopCliIntegration(options);
    expect(uninstalled).toMatchObject({
      action: "removed",
      message: `Removed HTMLslide CLI shim from ${path.join(targetDir, "htmlslide")}.`
    });

    expect(calls).toEqual([
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      [
        "setup",
        "install-cli",
        "--target-path",
        path.join(targetDir, "htmlslide"),
        "--app-path",
        path.join(root, "HTMLslide.app"),
        "--app-version",
        "0.1.0-test",
        "--bundle-id",
        "app.htmlslide.test",
        "--fallback-cli-path",
        cliRuntime.cliPath,
        "--json"
      ],
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      ["setup", "uninstall-cli", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"]
    ]);
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
    expect(result.agent.checkpoint).toMatchObject({
      id: "checkpoint-run-desktop-test",
      strategy: "file-copy",
      restore: {
        canRevert: true
      }
    });
    expect(result.applied).toMatchObject({
      projectPath,
      title: "Mock HTMLslide Deck",
      slideIds: ["001-title", "002-workflow", "003-review"]
    });
    expect(result.checkpointDiff?.summary).toMatchObject({
      changed: 3,
      added: 6,
      deleted: 0
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

    const diff = await diffDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test"
    });
    expect(diff.added.map((file) => file.path)).toEqual(
      expect.arrayContaining(["slides/002-workflow.html", "slides/003-review.html", "theme/theme.css"])
    );

    await expect(revertDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test"
    })).rejects.toThrow("explicit confirmation");

    const reverted = await revertDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test",
      confirmed: true
    });
    expect(reverted.restored).toEqual(expect.arrayContaining(["deck.json", "slides/001-title.html"]));
    expect(reverted.deleted).toEqual(
      expect.arrayContaining(["slides/002-workflow.html", "slides/003-review.html", "theme/theme.css"])
    );
    expect(reverted.project?.project).toMatchObject({
      title: "Desktop Test Deck",
      slideCount: 1
    });
    const restoredDeck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8"));
    expect(restoredDeck.title).toBe("Desktop Test Deck");
    expect(restoredDeck.slides).toHaveLength(1);
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

  it("runs a configured generic external agent through check and export", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const scriptFile = await writeExternalAgentScript(
      projectPath,
      "edit-slide",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const promptFile = requireArg(args, "--prompt-file");
const manifestFile = requireArg(args, "--writes-manifest");
const slideFile = path.join(projectRoot, "slides", "001-title.html");
fs.readFileSync(promptFile, "utf8");
fs.writeFileSync(slideFile, '<section class="slide" data-slide-id="001-title"><h1>Edited externally</h1><ul><li>External point</li></ul></section>\\n');
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["slides/001-title.html"] }));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );
    const commandTemplate = `"${process.execPath}" "${scriptFile}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;
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
              warnings: 0,
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
              deckpkg: path.join(projectPath, "exports", "desktop-test.deckpkg"),
              pdf: path.join(projectPath, "exports", "desktop-test.pdf")
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDesktopExternalAgent(
      {
        brief: "Tighten the title slide.",
        projectPath,
        runId: "run-external-test"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("external-generic");
    expect(result.adapter?.ok).toBe(true);
    expect(result.summary).toMatchObject({
      checkStatus: "passed",
      exportStatus: "passed",
      filesChanged: ["slides/001-title.html"],
      runId: "run-external-test",
      status: "succeeded"
    });
    expect(result.summary.exportArtifacts).toEqual([
      path.join(projectPath, "exports", "desktop-test.deckpkg"),
      path.join(projectPath, "exports", "desktop-test.pdf")
    ]);
    expect(result.checkpointDiff?.summary).toMatchObject({
      changed: 1,
      added: 0,
      deleted: 0
    });
    expect(result.project?.slides[0]?.html).toContain("Edited externally");
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);

    const prompt = await readFile(path.join(projectPath, ".htmlslide", "runs", "run-external-test", "prompt.md"), "utf8");
    expect(prompt).toContain("Tighten the title slide.");
    expect(prompt).toContain("deck.json, slides/, notes/, theme/, or assets/");
  });

  it("blocks external agent runs until Generic command is selected and configured", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    const nonGeneric = await runDesktopExternalAgent(
      {
        brief: "Edit the deck.",
        projectPath,
        runId: "run-codex-blocked"
      },
      {
        settings: externalAgentSettings("codex exec", "codex-cli")
      }
    );
    expect(nonGeneric).toMatchObject({
      error: "Only Generic command headless runs are enabled in this milestone.",
      ok: false,
      providerId: "external-generic"
    });

    const emptyCommand = await runDesktopExternalAgent(
      {
        brief: "Edit the deck.",
        projectPath,
        runId: "run-empty-command"
      },
      {
        settings: externalAgentSettings("")
      }
    );
    expect(emptyCommand).toMatchObject({
      error: "Generic command template is required before running an external agent.",
      ok: false
    });
  });

  it("fails external agent runs that report artifact writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const scriptFile = await writeExternalAgentScript(
      projectPath,
      "forbidden-artifact",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const manifestFile = requireArg(args, "--writes-manifest");
const exportFile = path.join(projectRoot, "exports", "bad.html");
fs.mkdirSync(path.dirname(exportFile), { recursive: true });
fs.writeFileSync(exportFile, "not a source edit");
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["exports/bad.html"] }));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );
    const commandTemplate = `"${process.execPath}" "${scriptFile}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;

    const result = await runDesktopExternalAgent(
      {
        brief: "Write an artifact.",
        projectPath,
        runId: "run-forbidden-artifact"
      },
      {
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(result.ok).toBe(false);
    expect(result.adapter?.ok).toBe(false);
    if (result.adapter?.ok === false) {
      expect(result.adapter.failure.type).toBe("forbidden-file-write");
      expect(result.adapter.failure.path).toBe(path.join(projectPath, "exports", "bad.html"));
    }
    expect(result.check).toBeUndefined();
    expect(result.export).toBeUndefined();
  });

  it("returns a presenter preparation error when deckpkg export fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "Export failed because the deck has blocking QA issues.",
        error: "Export failed"
      };
    };

    const result = await loadDesktopPresenterDeck(projectPath, {
      cliRuntime: {
        cliPath: "/fake/htmlslide.js",
        cwd: "/fake",
        mode: "development",
        rootPath: "/fake"
      },
      cliRunner: runner
    });

    expect(result).toMatchObject({
      error: "Export failed",
      ok: false,
      projectPath,
      source: "invalid"
    });
    expect(calls).toEqual([["export", projectPath, "--json"]]);
  });
});
