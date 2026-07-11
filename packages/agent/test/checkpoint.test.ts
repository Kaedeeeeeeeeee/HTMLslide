import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileCopyCheckpoint,
  diffFileCopyCheckpoint,
  recordCheckpointChanges,
  revertFileCopyCheckpoint
} from "../src/index.js";

const tempRoots: string[] = [];
const createdAt = "2026-07-09T00:00:00.000Z";
const recordedAt = "2026-07-09T00:01:00.000Z";

const createTempProject = async (): Promise<string> => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-checkpoint-"));
  tempRoots.push(projectPath);
  return projectPath;
};

const projectFilePath = (projectPath: string, filePath: string): string => path.join(projectPath, ...filePath.split("/"));

const writeProjectFile = async (projectPath: string, filePath: string, content: string): Promise<void> => {
  const absolutePath = projectFilePath(projectPath, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
};

const readProjectFile = async (projectPath: string, filePath: string): Promise<string> =>
  readFile(projectFilePath(projectPath, filePath), "utf8");

const expectMissing = async (absolutePath: string): Promise<void> => {
  await expect(access(absolutePath)).rejects.toThrow();
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-copy checkpoints", () => {
  it("rejects a symlinked checkpoint runtime before writing outside the project", async () => {
    const projectPath = await createTempProject();
    const outsidePath = await createTempProject();
    await writeProjectFile(projectPath, "deck.json", "{}\n");
    await symlink(outsidePath, path.join(projectPath, ".htmlslide"));

    await expect(createFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: "run-symlink",
      createdAt
    })).rejects.toThrow(/real project directory/);

    await expectMissing(path.join(outsidePath, "checkpoints", "run-symlink", "manifest.json"));
  });

  it("copies only deck source-scope files into a checkpoint manifest and snapshot", async () => {
    const projectPath = await createTempProject();
    await writeProjectFile(projectPath, "deck.json", '{"schemaVersion":"0.1.0"}\n');
    await writeProjectFile(projectPath, "slides/001-title.html", "<section>Title</section>\n");
    await writeProjectFile(projectPath, "slides/nested/chart.html", "<section>Chart</section>\n");
    await writeProjectFile(projectPath, "notes/001-title.md", "# Title\n");
    await writeProjectFile(projectPath, "theme/theme.css", ".slide { color: black; }\n");
    await writeProjectFile(projectPath, "assets/data.json", '{"points":[1,2,3]}\n');
    await writeProjectFile(projectPath, "exports/deck.html", "<html></html>\n");
    await writeProjectFile(projectPath, ".htmlslide/checkpoints/old/manifest.json", "{}\n");
    await writeProjectFile(projectPath, "assets/.secret", "hidden\n");
    await writeProjectFile(projectPath, "slides/.draft.html", "<section>Draft</section>\n");

    const checkpoint = await createFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: "run-source-scope",
      createdAt
    });

    expect(checkpoint).toMatchObject({
      id: "checkpoint-run-source-scope",
      runId: "run-source-scope",
      projectRoot: projectPath,
      strategy: "file-copy",
      createdAt,
      restore: {
        canRevert: true
      }
    });
    expect(checkpoint.files.map((file) => file.path)).toEqual([
      "deck.json",
      "slides/001-title.html",
      "slides/nested/chart.html",
      "notes/001-title.md",
      "theme/theme.css",
      "assets/data.json"
    ]);
    expect(checkpoint.files.every((file) => file.status === "unchanged" && file.origin === "snapshot")).toBe(true);
    expect(checkpoint.files.every((file) => file.digest !== undefined && file.snapshotPath !== undefined)).toBe(true);

    const checkpointRoot = path.join(projectPath, ".htmlslide", "checkpoints", "run-source-scope");
    const manifest = JSON.parse(await readFile(path.join(checkpointRoot, "manifest.json"), "utf8")) as {
      files: Array<{ path: string }>;
    };
    expect(manifest.files.map((file) => file.path)).toEqual(checkpoint.files.map((file) => file.path));
    await expect(readFile(path.join(checkpointRoot, "snapshot", "slides", "001-title.html"), "utf8")).resolves.toBe(
      "<section>Title</section>\n"
    );
    await expectMissing(path.join(checkpointRoot, "snapshot", "exports", "deck.html"));
    await expectMissing(path.join(checkpointRoot, "snapshot", "assets", ".secret"));
    await expectMissing(path.join(checkpointRoot, "snapshot", ".htmlslide", "checkpoints", "old", "manifest.json"));
  });

  it("records changed files, diffs current source, and reverts without deleting user additions", async () => {
    const projectPath = await createTempProject();
    await writeProjectFile(projectPath, "deck.json", "original deck\n");
    await writeProjectFile(projectPath, "slides/001-title.html", "original slide\n");
    await writeProjectFile(projectPath, "notes/001-title.md", "original notes\n");
    await writeProjectFile(projectPath, "theme/theme.css", "original theme\n");
    await writeProjectFile(projectPath, "assets/logo.txt", "original asset\n");

    const checkpoint = await createFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: "run-revert",
      createdAt
    });

    await writeProjectFile(projectPath, "deck.json", "agent deck\n");
    await unlink(projectFilePath(projectPath, "notes/001-title.md"));
    await writeProjectFile(projectPath, "slides/generated.html", "agent generated slide\n");
    await writeProjectFile(projectPath, "assets/safe-added.txt", "agent-added asset\n");
    await writeProjectFile(projectPath, "assets/user-edited-after.txt", "agent-added then edited\n");

    const recorded = await recordCheckpointChanges({
      projectRoot: projectPath,
      runId: "run-revert",
      recordedAt,
      filesChanged: [
        "deck.json",
        "notes/001-title.md",
        "slides/generated.html",
        "assets/safe-added.txt",
        "assets/user-edited-after.txt"
      ]
    });
    const recordedFiles = new Map(recorded.files.map((file) => [file.path, file]));
    expect(recordedFiles.get("deck.json")).toMatchObject({ status: "modified", origin: "snapshot" });
    expect(recordedFiles.get("notes/001-title.md")).toMatchObject({ status: "deleted", origin: "snapshot" });
    expect(recordedFiles.get("slides/generated.html")).toMatchObject({ status: "added", origin: "agent" });
    expect(recordedFiles.get("assets/safe-added.txt")?.digest).toBeDefined();

    await writeProjectFile(projectPath, "assets/user-edited-after.txt", "user changed this later\n");
    await writeProjectFile(projectPath, "assets/user-later.txt", "user later source\n");

    const diff = await diffFileCopyCheckpoint({
      projectRoot: projectPath,
      checkpointId: checkpoint.id
    });
    expect(diff.changed.map((file) => file.path)).toEqual(["deck.json"]);
    expect(diff.deleted.map((file) => file.path)).toEqual(["notes/001-title.md"]);
    expect(diff.added.map((file) => file.path)).toEqual([
      "slides/generated.html",
      "assets/safe-added.txt",
      "assets/user-edited-after.txt",
      "assets/user-later.txt"
    ]);
    expect(diff.summary).toEqual({
      changed: 1,
      added: 4,
      deleted: 1,
      unchanged: 3
    });
    expect(diff.textDiffs.map((textDiff) => textDiff.path)).toEqual([
      "deck.json",
      "slides/generated.html",
      "notes/001-title.md",
      "assets/safe-added.txt",
      "assets/user-edited-after.txt",
      "assets/user-later.txt"
    ]);
    expect(diff.textDiffs.find((textDiff) => textDiff.path === "deck.json")).toMatchObject({
      status: "modified",
      language: "json",
      lines: [
        { type: "removed", text: "original deck", oldLine: 1 },
        { type: "added", text: "agent deck", newLine: 1 }
      ],
      truncated: false
    });
    expect(diff.textDiffs.find((textDiff) => textDiff.path === "slides/generated.html")).toMatchObject({
      status: "added",
      lines: [{ type: "added", text: "agent generated slide", newLine: 1 }]
    });
    expect(diff.textDiffs.find((textDiff) => textDiff.path === "notes/001-title.md")).toMatchObject({
      status: "deleted",
      lines: [{ type: "removed", text: "original notes", oldLine: 1 }]
    });

    const reverted = await revertFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: "run-revert"
    });

    expect(reverted.restored).toEqual([
      "deck.json",
      "slides/001-title.html",
      "notes/001-title.md",
      "theme/theme.css",
      "assets/logo.txt"
    ]);
    expect(reverted.deleted).toEqual(["slides/generated.html", "assets/safe-added.txt"]);
    expect(reverted.preserved).toEqual(["assets/user-edited-after.txt"]);
    expect(await readProjectFile(projectPath, "deck.json")).toBe("original deck\n");
    expect(await readProjectFile(projectPath, "notes/001-title.md")).toBe("original notes\n");
    await expectMissing(projectFilePath(projectPath, "slides/generated.html"));
    await expectMissing(projectFilePath(projectPath, "assets/safe-added.txt"));
    expect(await readProjectFile(projectPath, "assets/user-edited-after.txt")).toBe("user changed this later\n");
    expect(await readProjectFile(projectPath, "assets/user-later.txt")).toBe("user later source\n");
  });

  it("rejects traversal, hidden, and out-of-scope changed paths", async () => {
    const projectPath = await createTempProject();
    await writeProjectFile(projectPath, "deck.json", "original deck\n");
    await createFileCopyCheckpoint({
      projectRoot: projectPath,
      runId: "run-unsafe-paths",
      createdAt
    });

    const unsafePaths = [
      "../deck.json",
      "slides/../deck.json",
      "exports/deck.html",
      ".htmlslide/checkpoints/run-x/manifest.json",
      "assets/.secret"
    ];

    for (const filePath of unsafePaths) {
      await expect(
        recordCheckpointChanges({
          projectRoot: projectPath,
          runId: "run-unsafe-paths",
          filesChanged: [filePath]
        })
      ).rejects.toThrow();
    }
  });
});
