import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkProject, type CheckReport, type HtmlslideIssue } from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../test-fixtures/decks/", import.meta.url));

const fixturePath = (name: string): string => path.join(FIXTURE_ROOT, name);

const withTempFixture = async <T>(fixtureName: string, callback: (projectPath: string) => Promise<T>): Promise<T> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-linter-"));
  const projectPath = path.join(tempRoot, fixtureName);
  await cp(fixturePath(fixtureName), projectPath, { recursive: true });

  try {
    return await callback(projectPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const issueTypes = (report: CheckReport): Set<string> => new Set(report.issues.map((issue) => issue.type));

const expectMachineRepairableIssues = (issues: readonly HtmlslideIssue[]): void => {
  for (const issue of issues) {
    expect(issue.agentInstruction).toEqual(expect.any(String));
    expect(issue.agentInstruction.length).toBeGreaterThan(0);
    expect(issue.suggestedFix).toEqual(expect.any(String));
    expect(issue.suggestedFix.length).toBeGreaterThan(0);
    expect(issue.measurement).toBeDefined();
    expect(typeof issue.measurement).toBe("object");
  }
};

const severityRank = (issue: HtmlslideIssue): number => {
  if (issue.severity === "error") {
    return 0;
  }
  if (issue.severity === "warning") {
    return 1;
  }
  return 2;
};

describe("HTMLslide linter", () => {
  it("passes a valid clean fixture", async () => {
    const report = await checkProject(fixturePath("linter-valid-clean"));

    expect(report.status).toBe("passed");
    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 0, suggestions: 0 });
    expect(report.issues).toEqual([]);
  });

  it("detects machine-repairable intentional QA failures", async () => {
    const report = await checkProject(fixturePath("linter-intentional-failures"));
    const types = issueTypes(report);

    expect(report.status).toBe("failed");
    expect([...types]).toEqual(
      expect.arrayContaining([
        "body-too-dense",
        "export-missing",
        "missing-asset",
        "missing-notes",
        "notes-too-short",
        "remote-asset",
        "remote-font",
        "remote-script",
        "slide-id-mismatch",
        "text-overflow",
        "title-too-long"
      ])
    );
    expectMachineRepairableIssues(report.issues);

    const ranks = report.issues.map(severityRank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it("detects text overflow in fixed-height slide copy", async () => {
    const report = await checkProject(fixturePath("linter-text-overflow"));
    const overflowIssue = report.issues.find((issue) => issue.type === "text-overflow");

    expect(report.status).toBe("failed");
    expect(overflowIssue).toMatchObject({
      severity: "error",
      slideId: "001-overflow",
      path: "slides/001-overflow.html",
      selector: "p.body-copy",
      measurement: {
        source: "estimated"
      }
    });
    expect(overflowIssue?.measurement?.overflowBottomPx).toEqual(expect.any(Number));
    expect(Number(overflowIssue?.measurement?.overflowBottomPx)).toBeGreaterThan(0);
    expectMachineRepairableIssues(report.issues);
  });

  it("normalizes core schema validation issues into repairable linter issues", async () => {
    const report = await checkProject(fixturePath("linter-schema-invalid"));

    expect(report.status).toBe("failed");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      slideId: "deck",
      severity: "error",
      type: "schema-validation",
      path: "slides.1.id",
      measurement: {
        path: "slides.1.id"
      }
    });
    expectMachineRepairableIssues(report.issues);
  });

  it("uses core project-file validation for missing referenced files", async () => {
    const report = await checkProject(fixturePath("linter-missing-project-file"));

    expect(report.status).toBe("failed");
    expect(report.issues).toHaveLength(2);
    expect(report.issues.map((issue) => issue.type)).toEqual(["missing-file", "missing-file"]);
    expect(report.issues.map((issue) => issue.path)).toEqual(["notes/001-missing.md", "slides/001-missing.html"]);
    expectMachineRepairableIssues(report.issues);
  });

  it("writes report.json and the compatibility check-report.json when requested", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const report = await checkProject({ projectPath, writeReport: true });
      const reportJsonPath = path.join(projectPath, ".htmlslide", "reports", "report.json");
      const compatibilityPath = path.join(projectPath, ".htmlslide", "reports", "check-report.json");

      expect(JSON.parse(await readFile(reportJsonPath, "utf8"))).toEqual(report);
      expect(JSON.parse(await readFile(compatibilityPath, "utf8"))).toEqual(report);
    });
  });

  it("flags expected exports that are older than deck sources", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const deckPath = path.join(projectPath, "deck.json");
      const deck = JSON.parse(await readFile(deckPath, "utf8")) as Record<string, unknown>;
      deck.export = {
        pdf: true,
        html: true,
        deckpkg: true,
        thumbnails: true,
        speakerNotes: true
      };
      await writeFile(deckPath, `${JSON.stringify(deck, null, 2)}\n`);

      const exportsPath = path.join(projectPath, "exports");
      const thumbnailsPath = path.join(exportsPath, "thumbnails");
      await mkdir(thumbnailsPath, { recursive: true });
      const artifacts = [
        path.join(exportsPath, "linter-valid-clean.pdf"),
        path.join(exportsPath, "linter-valid-clean.html"),
        path.join(exportsPath, "linter-valid-clean.deckpkg"),
        path.join(exportsPath, "notes.json"),
        path.join(thumbnailsPath, "001-clean.png")
      ];

      for (const artifact of artifacts) {
        await writeFile(artifact, "stale artifact");
        const staleDate = new Date("2000-01-01T00:00:00.000Z");
        await utimes(artifact, staleDate, staleDate);
      }

      const report = await checkProject(projectPath);
      const outdatedIssues = report.issues.filter((issue) => issue.type === "export-outdated");

      expect(report.status).toBe("passed");
      expect(outdatedIssues).toHaveLength(5);
      expect(report.issues.some((issue) => issue.type === "export-missing")).toBe(false);
      expectMachineRepairableIssues(outdatedIssues);
    });
  });
});
