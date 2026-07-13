import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addQaIgnoreRule,
  QA_IGNORE_RULES_PATH,
  readQaIgnoreConfig
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("QA ignore rules", () => {
  it("returns an empty config when the project has no rules file", async () => {
    const projectRoot = await makeProject();

    await expect(readQaIgnoreConfig(projectRoot)).resolves.toEqual({ version: 1, issueTypes: [] });
  });

  it("normalizes, sorts, deduplicates, and persists added rules", async () => {
    const projectRoot = await makeProject();

    await expect(addQaIgnoreRule(projectRoot, " text-overflow ")).resolves.toEqual({
      version: 1,
      issueTypes: ["text-overflow"]
    });
    await expect(addQaIgnoreRule(projectRoot, "missing-notes")).resolves.toEqual({
      version: 1,
      issueTypes: ["missing-notes", "text-overflow"]
    });
    await expect(addQaIgnoreRule(projectRoot, "text-overflow")).resolves.toEqual({
      version: 1,
      issueTypes: ["missing-notes", "text-overflow"]
    });

    await expect(
      fs.readFile(path.join(projectRoot, QA_IGNORE_RULES_PATH), "utf8")
    ).resolves.toContain('"issueTypes": [\n    "missing-notes",\n    "text-overflow"\n  ]');
  });

  it("normalizes an existing config and rejects malformed configs", async () => {
    const projectRoot = await makeProject();
    const rulesPath = path.join(projectRoot, QA_IGNORE_RULES_PATH);
    await fs.mkdir(path.dirname(rulesPath), { recursive: true });

    await fs.writeFile(rulesPath, JSON.stringify({ version: 1, issueTypes: [" text-overflow ", "text-overflow"] }));
    await expect(readQaIgnoreConfig(projectRoot)).resolves.toEqual({
      version: 1,
      issueTypes: ["text-overflow"]
    });

    for (const malformed of [
      { version: 2, issueTypes: [] },
      { version: 1, issueTypes: [""] }
    ]) {
      await fs.writeFile(rulesPath, JSON.stringify(malformed));
      await expect(readQaIgnoreConfig(projectRoot)).rejects.toThrow();
    }
  });

  it("rejects an empty rule", async () => {
    const projectRoot = await makeProject();

    await expect(addQaIgnoreRule(projectRoot, "  ")).rejects.toThrow(/require an issue type/iu);
  });
});

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-qa-ignore-"));
  temporaryRoots.push(root);
  return root;
}
