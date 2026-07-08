import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkLoadedProject, createProject, exportLoadedProject, loadProject, tryLoadProjectForCheck } from "../src/index";

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

  it("discovers the deck project from nested project paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const nestedSlidePath = path.join(project.projectPath, "slides", "001-title.html");
      const loaded = await loadProject(nestedSlidePath);

      expect(loaded.projectPath).toBe(project.projectPath);
      expect(loaded.manifest.id).toBe(project.manifest.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a machine-readable report when project loading fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const loaded = await tryLoadProjectForCheck(path.join(root, "missing"));

      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("Expected project load to fail");
      }
      expect(loaded.report.status).toBe("failed");
      expect(loaded.report.summary.errors).toBeGreaterThan(0);
      expect(loaded.report.issues[0]?.agentInstruction).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects export option flags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const exported = await exportLoadedProject(project, {
        pdf: false,
        deckpkg: false,
        html: true,
        thumbnails: false
      });

      expect(exported.artifacts.pdf).toBeUndefined();
      expect(exported.artifacts.deckpkg).toBeUndefined();
      expect(exported.artifacts.thumbnails).toBeUndefined();
      expect(exported.artifacts.html).toBeTruthy();
      expect(exported.artifacts.notes).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
