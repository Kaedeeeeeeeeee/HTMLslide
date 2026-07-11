import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildArtifactMetadata } from "./artifact-metadata.mjs";
import { renderChecklist } from "./create-rc-acceptance.mjs";
import { renderReleaseNotes } from "./create-release-notes.mjs";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(currentDir, "..", "..");

describe("release evidence scripts", () => {
  it("builds deterministic artifact integrity metadata", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-artifact-metadata-"));
    try {
      const artifactPath = path.join(tempRoot, "HTMLslide-test-artifact.dmg");
      await writeFile(artifactPath, "HTMLslide release artifact\n", "utf8");

      const metadata = await buildArtifactMetadata([artifactPath]);

      expect(metadata).toEqual([
        {
          path: artifactPath,
          fileName: "HTMLslide-test-artifact.dmg",
          sizeBytes: 27,
          sha256: "4b920746baa5375f6d5124c6efe25b116502b39c9b6295706faaa3761890e266"
        }
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders alpha RC checklists with run-bound metadata and manual evidence sections", () => {
    const checklist = renderChecklist({
      artifactUrl: "https://example.test/htmlslide-alpha.dmg",
      channel: "alpha",
      ciRunUrl: "https://github.test/ci",
      packageRunUrl: "https://github.test/package",
      version: "0.1.0"
    });

    expect(checklist).toContain("| Version | 0.1.0 |");
    expect(checklist).toContain("| Channel | alpha |");
    expect(checklist).toContain("| CI run | https://github.test/ci |");
    expect(checklist).toContain("| Package workflow run | https://github.test/package |");
    expect(checklist).toContain("| DMG / artifact URL | https://example.test/htmlslide-alpha.dmg |");
    expect(checklist).toContain("pnpm docs:build");
    expect(checklist).toContain("pnpm version:check");
    expect(checklist).toContain("pnpm security:check");
    expect(checklist).toContain("pnpm e2e:desktop:a11y");
    expect(checklist).toContain("Validate Real Claude/Codex Compatibility And Gemini Boundary");
    expect(checklist).toContain("If compatibility is not claimed, mark N/A");
    expect(checklist).toContain("Gemini CLI remains detection-only");
    expect(checklist).toContain("htmlslide agent validate-provider");
    expect(checklist).not.toContain("Release macOS completed with signed, notarized, stapled manifest.");
  });

  it("renders release RC checklists with signed notarization evidence", () => {
    const checklist = renderChecklist({
      artifactUrl: "https://example.test/htmlslide-release.dmg",
      channel: "release",
      ciRunUrl: "https://github.test/ci",
      packageRunUrl: "https://github.test/release",
      releaseTag: "v0.1.0",
      version: "0.1.0"
    });

    expect(checklist).toContain("| Release tag | v0.1.0 |");
    expect(checklist).toContain("| Channel | release |");
    expect(checklist).toContain("Release macOS completed with signed, notarized, stapled manifest.");
    expect(checklist).toContain("signed/notarized release behavior");
  });

  it("keeps rc:checklist stdout behavior wired to the script entrypoint", async () => {
    const scriptPath = path.join(root, "scripts", "release", "create-rc-acceptance.mjs");
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--stdout",
      "--channel",
      "alpha",
      "--version",
      "0.1.0",
      "--ci-run-url",
      "https://github.test/ci",
      "--package-run-url",
      "https://github.test/package",
      "--artifact-url",
      "https://example.test/htmlslide-alpha.dmg"
    ]);

    expect(stdout).toContain("# HTMLslide Release Candidate Acceptance");
    expect(stdout).toContain("| Channel | alpha |");
    expect(stdout).toContain("| CI run | https://github.test/ci |");
    expect(stdout).toContain("Delete App And Check System Files");
  });

  it("renders release notes from deterministic commit metadata", () => {
    const notes = renderReleaseNotes({
      commits: [
        {
          author: "Codex",
          date: "2026-07-09",
          sha: "d39de6398244abf9b58c927305273929bd2ed6ab",
          shortSha: "d39de63",
          subject: "Embed deckpkg package-local assets"
        }
      ],
      currentRef: "v0.1.0",
      deckSchemaVersion: "0.1.0",
      generatedAt: "2026-07-09T13:45:00.000Z",
      packageVersion: "0.1.0",
      previousTag: "v0.0.9",
      tag: "v0.1.0"
    });

    expect(notes).toContain("# HTMLslide v0.1.0");
    expect(notes).toContain("Generated at: 2026-07-09T13:45:00.000Z");
    expect(notes).toContain("Package version: 0.1.0");
    expect(notes).toContain("Deck schema version: 0.1.0");
    expect(notes).toContain("Range: v0.0.9...v0.1.0");
    expect(notes).toContain("- d39de63 Embed deckpkg package-local assets (2026-07-09, Codex)");
    expect(notes).toContain("Release macOS workflow: required for signed/notarized artifacts.");
    expect(notes).toContain("Manual RC acceptance: required");
  });

  it("makes empty release ranges explicit instead of silently publishing blank changes", () => {
    const notes = renderReleaseNotes({
      commits: [],
      currentRef: "v0.1.0",
      deckSchemaVersion: "0.1.0",
      generatedAt: "2026-07-09T13:45:00.000Z",
      packageVersion: "0.1.0",
      previousTag: undefined,
      tag: "v0.1.0"
    });

    expect(notes).toContain("Range: initial history through v0.1.0");
    expect(notes).toContain("No commits found in the release range.");
    expect(notes).toContain("Verify checkout fetch depth and tag history.");
  });
});
