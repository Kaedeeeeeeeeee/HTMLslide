import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSourceWrites,
  normalizeAgentSourceWritePath,
  normalizeAgentSourceWrites,
  parseAgentSourceWrites,
  resolveAgentSourceWritePath
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "htmlslide-source-writes-"));
  tempRoots.push(projectPath);
  return projectPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent source writes", () => {
  it("parses provider output from either a writes object or an array", () => {
    expect(parseAgentSourceWrites({
      writes: [
        { path: "deck.json", content: "{}\n" },
        { path: "slides/001-title.html", content: "<section></section>\n" }
      ]
    })).toEqual([
      { path: "deck.json", content: "{}\n" },
      { path: "slides/001-title.html", content: "<section></section>\n" }
    ]);

    expect(parseAgentSourceWrites([{ path: "notes/001-title.md", content: "# Notes\n" }])).toEqual([
      { path: "notes/001-title.md", content: "# Notes\n" }
    ]);
  });

  it("writes only normalized deck source paths", async () => {
    const projectPath = await tempProject();

    const result = await applyAgentSourceWrites({
      projectPath,
      writes: [
        { path: " deck.json ", content: "{\"title\":\"Test\"}\n" },
        { path: "slides/001-title.html", content: "<section data-slide-id=\"001-title\"></section>\n" },
        { path: "notes/001-title.md", content: "# Notes\n" },
        { path: "theme/theme.css", content: ".slide { color: black; }\n" },
        { path: "assets/data/source.csv", content: "label,value\nA,1\n" }
      ]
    });

    expect(result.filesChanged).toEqual([
      "deck.json",
      "slides/001-title.html",
      "notes/001-title.md",
      "theme/theme.css",
      "assets/data/source.csv"
    ]);
    await expect(readFile(path.join(projectPath, "deck.json"), "utf8")).resolves.toContain("Test");
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.toContain(
      "001-title"
    );
    await expect(readFile(path.join(projectPath, "assets", "data", "source.csv"), "utf8")).resolves.toContain("A,1");
  });

  it("rejects path traversal, artifacts, private runtime files, unknown roots, and duplicate writes before writing", async () => {
    const projectPath = await tempProject();
    const invalidPaths = [
      "",
      "../escape.html",
      "/tmp/escape.html",
      "slides/\0escape.html",
      "slides/../escape.html",
      "slides\\001-title.html",
      "slides:001-title.html",
      "exports/deck.pdf",
      ".htmlslide/runs/run-1/prompt.md",
      "README.md"
    ];

    for (const invalidPath of invalidPaths) {
      expect(() => normalizeAgentSourceWritePath(invalidPath)).toThrow();
    }

    expect(() =>
      normalizeAgentSourceWrites([
        { path: "slides/001-title.html", content: "first" },
        { path: " slides/001-title.html ", content: "second" }
      ])
    ).toThrow("Duplicate agent source write path");

    await expect(applyAgentSourceWrites({
      projectPath,
      writes: [
        { path: "slides/001-title.html", content: "<section></section>\n" },
        { path: "exports/bad.html", content: "artifact\n" }
      ]
    })).rejects.toThrow("Refusing to write non-source path");

    await expect(access(path.join(projectPath, "slides", "001-title.html"))).rejects.toThrow();
  });

  it("keeps resolved writes inside the selected project root", async () => {
    const projectPath = await tempProject();
    const resolved = resolveAgentSourceWritePath(projectPath, "theme/tokens.json");

    expect(resolved).toBe(path.join(projectPath, "theme", "tokens.json"));
  });

  it("rejects existing source symlinks before writing any files", async () => {
    const projectPath = await tempProject();
    const outsidePath = await tempProject();
    await mkdir(path.join(outsidePath, "slides"));
    await writeFile(path.join(outsidePath, "slides", "existing.html"), "outside\n", "utf8");
    await symlink(path.join(outsidePath, "slides"), path.join(projectPath, "slides"));

    await expect(applyAgentSourceWrites({
      projectPath,
      writes: [
        { path: "deck.json", content: "{}\n" },
        { path: "slides/generated.html", content: "generated\n" }
      ]
    })).rejects.toThrow(/contains a symlink/);

    await expect(access(path.join(projectPath, "deck.json"))).rejects.toThrow();
    await expect(access(path.join(outsidePath, "slides", "generated.html"))).rejects.toThrow();
  });
});
