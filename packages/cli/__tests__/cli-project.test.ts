import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkLoadedProject, createProject, exportLoadedProject } from "../src/index";

describe("CLI project helpers", () => {
  it("creates, checks, and exports a default deck project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const report = await checkLoadedProject(project);
      expect(report.status).toBe("passed");
      expect(report.summary.errors).toBe(0);

      const exported = await exportLoadedProject(project);
      expect(exported.artifacts.pdf).toBeTruthy();
      expect(exported.artifacts.html).toBeTruthy();
      expect(exported.artifacts.deckpkg).toBeTruthy();
      expect(exported.artifacts.thumbnails).toHaveLength(2);

      const deckJson = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(deckJson.schemaVersion).toBe("0.1.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

