import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDeckProject } from "@htmlslide/core";
import { exportDeck } from "../../compiler/src/index.js";
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

const requestAllExports = async (projectPath: string): Promise<void> => {
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
};

const exportLoadedFixture = async (projectPath: string) => {
  const project = await loadDeckProject(projectPath);
  return exportDeck({
    projectPath,
    title: project.deck.title,
    language: project.deck.language,
    viewport: project.deck.viewport,
    safeArea: project.deck.safeArea,
    themeCssPath: project.deck.theme?.css,
    themeTokensPath: project.deck.theme?.tokens,
    slides: project.deck.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes,
      durationSec: slide.durationSec
    }))
  });
};

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
        "safe-area-violation",
        "slide-id-mismatch",
        "text-overflow",
        "title-too-long"
      ])
    );
    expectMachineRepairableIssues(report.issues);

    const ranks = report.issues.map(severityRank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it("applies project-local QA ignore rules to the shared check report", async () => {
    await withTempFixture("linter-text-overflow", async (projectPath) => {
      await mkdir(path.join(projectPath, ".htmlslide"), { recursive: true });
      await writeFile(
        path.join(projectPath, ".htmlslide", "qa-ignores.json"),
        `${JSON.stringify({ version: 1, issueTypes: ["text-overflow"] }, null, 2)}\n`
      );

      const report = await checkProject(projectPath);

      expect(issueTypes(report)).not.toContain("text-overflow");
    });
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

  it("detects positioned elements that violate the deck safe area", async () => {
    const report = await checkProject(fixturePath("linter-safe-area"));
    const safeAreaIssue = report.issues.find((issue) => issue.type === "safe-area-violation");

    expect(report.status).toBe("failed");
    expect(safeAreaIssue).toMatchObject({
      severity: "error",
      slideId: "001-safe-area",
      path: "slides/001-safe-area.html",
      selector: "p.caption",
      measurement: {
        overflowBottomPx: 32,
        safeBottom: 1008
      }
    });
    expectMachineRepairableIssues(report.issues);
  });

  it("detects low contrast inline text styles", async () => {
    const report = await checkProject(fixturePath("linter-contrast"));
    const contrastIssue = report.issues.find((issue) => issue.type === "low-contrast");

    expect(report.status).toBe("passed");
    expect(report.issues.map((issue) => issue.type)).toEqual(["low-contrast"]);
    expect(contrastIssue).toMatchObject({
      severity: "warning",
      slideId: "001-contrast",
      path: "slides/001-contrast.html",
      selector: "p.low-contrast",
      measurement: {
        minContrastRatio: 4.5,
        foreground: "#777777",
        background: "#888888"
      }
    });
    expect(contrastIssue?.measurement?.contrastRatio).toEqual(expect.any(Number));
    expect(Number(contrastIssue?.measurement?.contrastRatio)).toBeLessThan(4.5);
    expectMachineRepairableIssues(report.issues);
  });

  it("detects remote font references in an independent fixture", async () => {
    const report = await checkProject(fixturePath("linter-remote-font"));
    const fontIssue = report.issues.find((issue) => issue.type === "remote-font");

    expect(report.status).toBe("passed");
    expect(report.issues.map((issue) => issue.type)).toEqual(["remote-font"]);
    expect(fontIssue).toMatchObject({
      severity: "warning",
      slideId: "001-remote-font",
      path: "slides/001-remote-font.html",
      selector: "link[href]",
      measurement: {
        url: "https://fonts.googleapis.com/css2?family=Inter:wght@700"
      }
    });
    expectMachineRepairableIssues(report.issues);
  });

  it("detects remote assets and scripts as local-first security issues", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await writeFile(
        path.join(projectPath, "slides", "001-clean.html"),
        `<!doctype html>
<section class="slide" data-slide-id="001-clean">
  <style>@import url("https://cdn.example.test/theme.css");</style>
  <img src="https://cdn.example.test/photo.png" alt="Remote" />
  <script src="https://cdn.example.test/app.js"></script>
  <h1>Remote asset test</h1>
</section>
`,
        "utf8"
      );

      const report = await checkProject(projectPath);

      expect(report.status).toBe("failed");
      expect(report.issues.map((issue) => issue.type)).toEqual(
        expect.arrayContaining(["remote-asset", "remote-script"])
      );
      expect(report.issues.filter((issue) => issue.type === "remote-script")).toEqual([
        expect.objectContaining({
          severity: "error",
          measurement: {
            url: "https://cdn.example.test/app.js"
          }
        })
      ]);
      expect(report.issues.filter((issue) => issue.type === "remote-asset").map((issue) => issue.measurement?.url)).toEqual(
        expect.arrayContaining(["https://cdn.example.test/photo.png", "https://cdn.example.test/theme.css"])
      );
    });
  });

  it("detects slides without speaker notes in an independent fixture", async () => {
    const report = await checkProject(fixturePath("linter-missing-notes"));
    const notesIssue = report.issues.find((issue) => issue.type === "missing-notes");

    expect(report.status).toBe("passed");
    expect(report.issues.map((issue) => issue.type)).toEqual(["missing-notes"]);
    expect(notesIssue).toMatchObject({
      severity: "warning",
      slideId: "001-missing-notes",
      path: "deck.json",
      selector: "slides[].notes",
      measurement: {
        minWords: 12
      }
    });
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
      await requestAllExports(projectPath);

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
      expect(report.issues).toContainEqual(expect.objectContaining({ type: "export-manifest-missing" }));
      expect(report.issues.some((issue) => issue.type === "export-missing")).toBe(false);
      expectMachineRepairableIssues(outdatedIssues);
    });
  });

  it("uses compiler fingerprints to detect source changes even when mtimes look older", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      await exportLoadedFixture(projectPath);

      const cleanReport = await checkProject(projectPath);
      expect(cleanReport.issues.filter((issue) => issue.type.startsWith("export-"))).toEqual([]);

      const slidePath = path.join(projectPath, "slides", "001-clean.html");
      const source = await readFile(slidePath, "utf8");
      await writeFile(slidePath, `${source}\n<!-- changed after export -->\n`);
      const oldDate = new Date("2000-01-01T00:00:00.000Z");
      await utimes(slidePath, oldDate, oldDate);

      const report = await checkProject(projectPath);
      const outdatedIssues = report.issues.filter((issue) => issue.type === "export-outdated");

      expect(outdatedIssues).toHaveLength(5);
      expect(outdatedIssues[0]?.measurement).toMatchObject({
        changedSourceCount: 1,
        firstChangedSourcePath: "slides/001-clean.html"
      });
      expect(report.issues.some((issue) => issue.type === "export-manifest-missing")).toBe(false);
      expectMachineRepairableIssues(outdatedIssues);
    });
  });

  it("detects manual edits to compiler-owned export artifacts", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      const exported = await exportLoadedFixture(projectPath);
      await writeFile(exported.artifacts.pdf!, "manually edited export");

      const report = await checkProject(projectPath);
      const modifiedIssues = report.issues.filter((issue) => issue.type === "export-modified");

      expect(modifiedIssues).toHaveLength(1);
      expect(modifiedIssues[0]).toMatchObject({
        path: "exports/linter-valid-clean.pdf",
        slideId: "deck"
      });
      expect(report.issues.some((issue) => issue.type === "export-outdated")).toBe(false);
      expectMachineRepairableIssues(modifiedIssues);
    });
  }, 30_000);

  it("ignores mtime-only source changes when source bytes still match the manifest", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      await exportLoadedFixture(projectPath);
      const slidePath = path.join(projectPath, "slides", "001-clean.html");
      const futureDate = new Date("2040-01-01T00:00:00.000Z");
      await utimes(slidePath, futureDate, futureDate);

      const report = await checkProject(projectPath);

      expect(report.issues.filter((issue) => issue.type.startsWith("export-"))).toEqual([]);
    });
  }, 30_000);

  it("fails closed when the compiler export manifest is truncated", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      const exported = await exportLoadedFixture(projectPath);
      await writeFile(exported.metadata.manifest, '{"schemaVersion":');

      const report = await checkProject(projectPath);
      const manifestIssue = report.issues.find((issue) => issue.type === "export-manifest-invalid");

      expect(report.status).toBe("failed");
      expect(manifestIssue).toMatchObject({
        severity: "error",
        path: "exports/export-manifest.json",
        slideId: "deck"
      });
      expect(report.issues.some((issue) => issue.type === "export-outdated")).toBe(false);
      expectMachineRepairableIssues([manifestIssue!]);
    });
  });

  it("fails closed for a present invalid manifest even when the deck requests no exports", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const exportsPath = path.join(projectPath, "exports");
      await mkdir(exportsPath, { recursive: true });
      await writeFile(path.join(exportsPath, "export-manifest.json"), '{"schemaVersion":');

      const report = await checkProject(projectPath);

      expect(report.status).toBe("failed");
      expect(report.issues).toContainEqual(expect.objectContaining({
        severity: "error",
        type: "export-manifest-invalid",
        path: "exports/export-manifest.json"
      }));
    });
  });

  it("reports an artifact symlink as a stable integrity error", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      const exported = await exportLoadedFixture(projectPath);
      const outsidePdf = path.join(path.dirname(projectPath), "outside.pdf");
      await writeFile(outsidePdf, "outside");
      await rm(exported.artifacts.pdf!);
      await symlink(outsidePdf, exported.artifacts.pdf!);

      const report = await checkProject(projectPath);
      const integrityIssue = report.issues.find((issue) =>
        issue.type === "export-integrity-unverified" && issue.path === "exports/linter-valid-clean.pdf"
      );

      expect(report.status).toBe("failed");
      expect(integrityIssue).toMatchObject({ severity: "error", slideId: "deck" });
      expectMachineRepairableIssues([integrityIssue!]);
    });
  });

  it("uses an exact partial-export manifest without treating removed artifacts as untracked", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      await requestAllExports(projectPath);
      await exportLoadedFixture(projectPath);
      const project = await loadDeckProject(projectPath);
      await exportDeck({
        projectPath,
        title: project.deck.title,
        language: project.deck.language,
        viewport: project.deck.viewport,
        safeArea: project.deck.safeArea,
        slides: project.deck.slides.map((slide) => ({
          id: slide.id,
          title: slide.title,
          sourcePath: slide.source,
          notesPath: slide.notes,
          durationSec: slide.durationSec
        }))
      }, {
        pdf: false,
        html: true,
        deckpkg: false,
        thumbnails: false
      });

      const report = await checkProject(projectPath);
      const exportIssues = report.issues.filter((issue) => issue.type.startsWith("export-"));

      expect(exportIssues.filter((issue) => issue.type === "export-missing")).toHaveLength(3);
      expect(exportIssues.some((issue) => issue.type === "export-untracked")).toBe(false);
      expect(exportIssues.some((issue) => issue.type === "export-manifest-invalid")).toBe(false);
    });
  });
});
