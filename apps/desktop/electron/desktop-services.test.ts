import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCliRuntime,
  loadProjectPreview,
  readDesktopLibrary,
  summarizeDeckProject,
  upsertRecentProject,
  writeDesktopLibrary,
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
});
