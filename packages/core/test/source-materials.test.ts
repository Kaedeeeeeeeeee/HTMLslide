import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
  MAX_SOURCE_MATERIAL_BYTES_TOTAL,
  MAX_SOURCE_MATERIAL_COUNT,
  SOURCE_MATERIAL_INDEX_PATH,
  SourceMaterialError,
  stageSourceMaterials
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("source material staging", () => {
  it("copies files, writes pasted Markdown, and creates a source index without touching exports", async () => {
    const projectRoot = await makeProject();
    const selectedFile = path.join(projectRoot, "selected-reference.txt");
    await fs.writeFile(selectedFile, "selected source\n", "utf8");
    const exportsSentinel = path.join(projectRoot, "exports", "keep.txt");
    await fs.writeFile(exportsSentinel, "do not modify\n", "utf8");

    const result = await stageSourceMaterials(projectRoot, [
      { kind: "file", sourcePath: selectedFile },
      { kind: "text", name: "pasted-notes", content: "# Pasted notes\n\nUse this as context.\n" }
    ]);

    expect(result.indexPath).toBe(SOURCE_MATERIAL_INDEX_PATH);
    expect(result.records).toEqual([
      {
        kind: "file",
        name: "selected-reference.txt",
        path: "assets/sources/selected-reference.txt",
        bytes: Buffer.byteLength("selected source\n"),
        sha256: sha256("selected source\n")
      },
      {
        kind: "text",
        name: "pasted-notes.md",
        path: "assets/sources/pasted-notes.md",
        bytes: Buffer.byteLength("# Pasted notes\n\nUse this as context.\n"),
        sha256: sha256("# Pasted notes\n\nUse this as context.\n")
      }
    ]);
    await expect(fs.readFile(path.join(projectRoot, "assets/sources/selected-reference.txt"), "utf8")).resolves.toBe(
      "selected source\n"
    );
    await expect(fs.readFile(path.join(projectRoot, "assets/sources/pasted-notes.md"), "utf8")).resolves.toBe(
      "# Pasted notes\n\nUse this as context.\n"
    );
    await expect(fs.readFile(exportsSentinel, "utf8")).resolves.toBe("do not modify\n");

    const index = JSON.parse(await fs.readFile(path.join(projectRoot, SOURCE_MATERIAL_INDEX_PATH), "utf8")) as {
      schemaVersion: number;
      materials: unknown[];
    };
    expect(index).toEqual({
      schemaVersion: 1,
      materials: [
        result.records[1],
        result.records[0]
      ].sort((left, right) => String((left as { path: string }).path).localeCompare(String((right as { path: string }).path)))
    });
  });

  it("allocates deterministic suffixes for duplicate names and preserves the prior index", async () => {
    const projectRoot = await makeProject();
    const firstSource = path.join(projectRoot, "first", "brief.txt");
    const secondSource = path.join(projectRoot, "second", "brief.txt");
    await fs.mkdir(path.dirname(firstSource), { recursive: true });
    await fs.mkdir(path.dirname(secondSource), { recursive: true });
    await fs.writeFile(firstSource, "first\n", "utf8");
    await fs.writeFile(secondSource, "second\n", "utf8");

    const first = await stageSourceMaterials(projectRoot, [{ kind: "file", sourcePath: firstSource }]);
    const second = await stageSourceMaterials(projectRoot, [{ kind: "file", sourcePath: secondSource }]);

    expect(first.records[0]?.name).toBe("brief.txt");
    expect(second.records[0]?.name).toBe("brief-2.txt");
    await expect(fs.readFile(path.join(projectRoot, "assets/sources/brief-2.txt"), "utf8")).resolves.toBe("second\n");
    const index = JSON.parse(await fs.readFile(path.join(projectRoot, SOURCE_MATERIAL_INDEX_PATH), "utf8")) as {
      materials: Array<{ name: string; path: string }>;
    };
    expect(index.materials.map((record) => record.name)).toEqual(["brief-2.txt", "brief.txt"]);
    expect(index.materials.map((record) => record.path)).toEqual([
      "assets/sources/brief-2.txt",
      "assets/sources/brief.txt"
    ]);
  });

  it("rejects source symlinks, directories, and secret-like files", async () => {
    const projectRoot = await makeProject();
    const realFile = path.join(projectRoot, "real.txt");
    const symlinkFile = path.join(projectRoot, "linked.txt");
    const directory = path.join(projectRoot, "source-directory");
    const secretFile = path.join(projectRoot, ".env.local");
    await fs.writeFile(realFile, "real\n", "utf8");
    await fs.symlink(realFile, symlinkFile);
    await fs.mkdir(directory);
    await fs.writeFile(secretFile, "TOKEN=do-not-import\n", "utf8");

    await expectRejected(stageSourceMaterials(projectRoot, [{ kind: "file", sourcePath: symlinkFile }]), "SOURCE_SYMLINK");
    await expectRejected(
      stageSourceMaterials(projectRoot, [{ kind: "file", sourcePath: directory }]),
      "SOURCE_NOT_REGULAR_FILE"
    );
    await expectRejected(stageSourceMaterials(projectRoot, [{ kind: "file", sourcePath: secretFile }]), "SOURCE_SECRET_LIKE");
    await expect(fs.stat(path.join(projectRoot, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe target directories and leaves outside files unchanged", async () => {
    const projectRoot = await makeProject();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-source-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsideSentinel = path.join(outsideRoot, "outside.txt");
    await fs.writeFile(outsideSentinel, "outside\n", "utf8");
    await fs.symlink(outsideRoot, path.join(projectRoot, "assets"));

    await expectRejected(
      stageSourceMaterials(projectRoot, [{ kind: "text", name: "notes", content: "# Notes\n" }]),
      "SOURCE_TARGET_UNSAFE"
    );
    await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("outside\n");
  });

  it("enforces the fixed count and byte limits, including pasted text", async () => {
    const projectRoot = await makeProject();
    expect(MAX_SOURCE_MATERIAL_COUNT).toBe(20);
    expect(MAX_SOURCE_MATERIAL_BYTES_PER_FILE).toBe(25 * 1024 * 1024);
    expect(MAX_SOURCE_MATERIAL_BYTES_TOTAL).toBe(200 * 1024 * 1024);

    await expectRejected(
      stageSourceMaterials(
        projectRoot,
        [{ kind: "text", name: "too-large", content: "1234" }],
        { maxBytesPerFile: 3 }
      ),
      "SOURCE_FILE_TOO_LARGE"
    );
    await expectRejected(
      stageSourceMaterials(
        projectRoot,
        [
          { kind: "text", name: "one", content: "123" },
          { kind: "text", name: "two", content: "456" }
        ],
        { maxBytesTotal: 5 }
      ),
      "SOURCE_TOTAL_TOO_LARGE"
    );
    await expectRejected(
      stageSourceMaterials(
        projectRoot,
        [
          { kind: "text", name: "one", content: "1" },
          { kind: "text", name: "two", content: "2" }
        ],
        { maxCount: 1 }
      ),
      "SOURCE_COUNT_TOO_LARGE"
    );
    await expect(fs.stat(path.join(projectRoot, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes byte-identical indexes for identical inputs and sorts records by path", async () => {
    const firstProject = await makeProject();
    const secondProject = await makeProject();
    const inputs = [
      { kind: "text" as const, name: "zeta", content: "z\n" },
      { kind: "text" as const, name: "alpha", content: "a\n" },
      { kind: "text" as const, name: "zeta", content: "z2\n" }
    ];

    await stageSourceMaterials(firstProject, inputs);
    await stageSourceMaterials(secondProject, inputs);

    const firstIndex = await fs.readFile(path.join(firstProject, SOURCE_MATERIAL_INDEX_PATH));
    const secondIndex = await fs.readFile(path.join(secondProject, SOURCE_MATERIAL_INDEX_PATH));
    expect(firstIndex.equals(secondIndex)).toBe(true);
    expect(JSON.parse(firstIndex.toString("utf8"))).toEqual({
      schemaVersion: 1,
      materials: [
        {
          kind: "text",
          name: "alpha.md",
          path: "assets/sources/alpha.md",
          bytes: 2,
          sha256: sha256("a\n")
        },
        {
          kind: "text",
          name: "zeta-2.md",
          path: "assets/sources/zeta-2.md",
          bytes: 3,
          sha256: sha256("z2\n")
        },
        {
          kind: "text",
          name: "zeta.md",
          path: "assets/sources/zeta.md",
          bytes: 2,
          sha256: sha256("z\n")
        }
      ]
    });
  });
});

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-source-materials-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "exports"));
  return root;
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    return error instanceof SourceMaterialError && error.code === code;
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
