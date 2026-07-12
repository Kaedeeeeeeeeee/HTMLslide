import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildArtifactMetadata } from "./artifact-metadata.mjs";
import { renderChecklist } from "./create-rc-acceptance.mjs";
import { renderReleaseNotes } from "./create-release-notes.mjs";
import { main as verifyByokEvidence } from "./verify-byok-acceptance.mjs";
import { main as verifyChecklist } from "./verify-rc-checklist.mjs";
import { main as verifyExternalAgentEvidence } from "./verify-external-agent-acceptance.mjs";

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

  it("writes metadata-only real external-agent evidence bound to a package manifest", async () => {
    const fixture = await createExternalAgentEvidenceFixture();
    try {
      const outputPath = path.join(fixture.root, "verified.json");
      await verifyExternalAgentEvidence([
        "--evidence", fixture.evidencePath,
        "--package-manifest", fixture.manifestPath,
        "--commit", "f570b88",
        "--artifact-url", "https://github.test/actions/artifacts/123",
        "--output", outputPath
      ]);

      const evidenceText = await readFile(outputPath, "utf8");
      const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        kind: "htmlslide-external-agent-acceptance-evidence",
        status: "passed",
        provider: { id: "codex-cli", version: "codex-cli 0.144.1" },
        candidate: {
          binding: "caller-declared",
          commit: "f570b88",
          artifactUrl: "https://github.test/actions/artifacts/123",
          channel: "alpha",
          signing: "ad-hoc",
          notarized: false
        },
        runs: {
          successful: {
            status: "succeeded",
            changedFiles: ["slides/001-title.html"],
            check: "passed",
            export: "passed",
            diffReview: "passed",
            revert: "passed"
          },
          cancellation: { status: "cancelled", postCancelCheckExport: "not-started" }
        }
      });
      expect(evidenceText).not.toContain("/tmp/");
      expect(evidenceText).not.toContain("codex-secret");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for raw secrets, unsafe changed paths, and inconsistent package signing", async () => {
    const cases = [
      {
        name: "raw secret",
        mutate: async (fixture: Awaited<ReturnType<typeof createExternalAgentEvidenceFixture>>) => {
          const input = JSON.parse(await readFile(fixture.evidencePath, "utf8")) as {
            provider: Record<string, unknown>;
          };
          input.provider.apiKey = "codex-secret-value";
          await writeFile(fixture.evidencePath, JSON.stringify(input), "utf8");
          return /forbidden secret field/;
        }
      },
      {
        name: "unsafe source path",
        mutate: async (fixture: Awaited<ReturnType<typeof createExternalAgentEvidenceFixture>>) => {
          const input = JSON.parse(await readFile(fixture.evidencePath, "utf8")) as {
            successfulRun: Record<string, unknown>;
          };
          input.successfulRun.changedFiles = ["/tmp/outside.html"];
          await writeFile(fixture.evidencePath, JSON.stringify(input), "utf8");
          return /project-relative POSIX path/;
        }
      },
      {
        name: "inconsistent signing",
        mutate: async (fixture: Awaited<ReturnType<typeof createExternalAgentEvidenceFixture>>) => {
          const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as Record<string, unknown>;
          manifest.signing = "developer-id";
          await writeFile(fixture.manifestPath, JSON.stringify(manifest), "utf8");
          return /ad-hoc, non-notarized/;
        }
      }
    ];

    for (const testCase of cases) {
      const fixture = await createExternalAgentEvidenceFixture();
      try {
        const expected = await testCase.mutate(fixture);
        await expect(verifyExternalAgentEvidence([
          "--evidence", fixture.evidencePath,
          "--package-manifest", fixture.manifestPath,
          "--commit", "f570b88",
          "--artifact-url", "https://github.test/actions/artifacts/123",
          "--output", path.join(fixture.root, `${testCase.name}.json`)
        ])).rejects.toThrow(expected);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
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

  it("verifies a completed RC checklist with explicit manual statuses", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-rc-checklist-"));
    const inputPath = path.join(fixtureRoot, "completed.md");
    try {
      await writeFile(inputPath, completeChecklist(), "utf8");

      const result = await verifyChecklist(["--checklist", inputPath]);

      expect(result.status).toBe("passed");
      expect(result.manualSectionCount).toBe(13);
      expect(result.manualItemCount).toBeGreaterThan(0);
      expect(result.statusCounts).toEqual({
        Pass: result.manualItemCount,
        Fail: 0,
        "N/A": 0
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("exposes rc:checklist:verify as a JSON-producing command", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-rc-checklist-cli-"));
    const inputPath = path.join(fixtureRoot, "completed.md");
    try {
      await writeFile(inputPath, completeChecklist(), "utf8");

      const { stdout } = await execFileAsync(process.execPath, [
        path.join(root, "scripts", "release", "verify-rc-checklist.mjs"),
        "--checklist", inputPath,
        "--json"
      ]);

      expect(JSON.parse(stdout)).toMatchObject({
        command: "rc:checklist:verify",
        status: "passed",
        manualSectionCount: 13
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "unknown manual status",
      (text: string) => text.replace("- Status: Pass", "- Status: Unknown"),
      /invalid Status/
    ],
    [
      "Pass without evidence",
      (text: string) => text.replace("- Evidence: https://example.test/evidence", "- Evidence:"),
      /Pass but has no Evidence/
    ],
    [
      "Fail without explanation",
      (text: string) => text.replace("- Status: Pass", "- Status: Fail").replace("- Notes: Manual acceptance record.", "- Notes:"),
      /Fail but has no Notes explanation/
    ],
    [
      "N/A without reason",
      (text: string) => text.replace("- Status: Pass", "- Status: N/A").replace("- Notes: Manual acceptance record.", "- Notes:"),
      /N\/A but has no Notes rationale/
    ],
    [
      "unfinished placeholder",
      (text: string) => text.replace("- Evidence: https://example.test/evidence", "- Evidence: TODO"),
      /no Evidence/
    ]
  ])("rejects %s in an RC checklist", async (_name, mutate, expected) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-rc-checklist-invalid-"));
    const inputPath = path.join(fixtureRoot, "invalid.md");
    try {
      await writeFile(inputPath, mutate(completeChecklist()), "utf8");
      await expect(verifyChecklist(["--checklist", inputPath])).rejects.toThrow(expected);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("writes sanitized run-bound evidence for a valid 8-slide BYOK deck", async () => {
    const fixture = await createByokEvidenceFixture();
    try {
      const outputPath = path.join(fixture.projectPath, ".htmlslide", "reports", "evidence.json");
      await verifyByokEvidence([
        "--project", fixture.projectPath,
        "--provider-validation", fixture.validationPath,
        "--run-id", "run-real-provider",
        "--output", outputPath,
        "--commit", "abc1234",
        "--artifact-url", "https://github.test/artifacts/123"
      ]);

      const evidenceText = await readFile(outputPath, "utf8");
      const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        kind: "htmlslide-byok-acceptance-evidence",
        runId: "run-real-provider",
        status: "passed",
        provider: { provider: "openai", model: "gpt-test" },
        project: { slideCount: 8 }
      });
      expect(evidenceText).not.toContain("sk-evidence-secret-value");
      expect((evidence.artifacts as unknown[])).toHaveLength(10);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects stale artifact fingerprints and secret-bearing validation without leaking the secret", async () => {
    const fixture = await createByokEvidenceFixture();
    const sentinel = "sk-evidence-secret-value";
    try {
      await writeFile(path.join(fixture.projectPath, "exports", "deck.pdf"), "tampered", "utf8");
      await expect(verifyByokEvidence([
        "--project", fixture.projectPath,
        "--provider-validation", fixture.validationPath,
        "--output", path.join(fixture.projectPath, ".htmlslide", "reports", "stale.json")
      ])).rejects.toThrow(/fingerprint mismatch/);

      const validation = JSON.parse(await readFile(fixture.validationPath, "utf8")) as Record<string, unknown>;
      validation.apiKey = sentinel;
      await writeFile(fixture.validationPath, JSON.stringify(validation), "utf8");
      let message = "";
      try {
        await verifyByokEvidence([
          "--project", fixture.projectPath,
          "--provider-validation", fixture.validationPath,
          "--output", path.join(fixture.projectPath, ".htmlslide", "reports", "secret.json")
        ]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/forbidden secret field/);
      expect(message).not.toContain(sentinel);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for wrong run/provider/count, malformed reports, stale sources, missing artifacts, and symlinks", async () => {
    const cases = [
      {
        name: "wrong run",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => ({
          extraArgs: ["--report", fixture.reportPath, "--run-id", "run-other"]
        }),
        message: /does not match requested runId/
      },
      {
        name: "provider mismatch",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const validation = JSON.parse(await readFile(fixture.validationPath, "utf8")) as Record<string, unknown>;
          validation.provider = "anthropic";
          await writeFile(fixture.validationPath, JSON.stringify(validation), "utf8");
          return {};
        },
        message: /provider\/model does not match/
      },
      {
        name: "invalid target count",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as Record<string, unknown>;
          report.targetSlideCount = 7;
          await writeFile(fixture.reportPath, JSON.stringify(report), "utf8");
          return {};
        },
        message: /explicit 8-12 slide target/
      },
      {
        name: "malformed report",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          await writeFile(fixture.reportPath, "{", "utf8");
          return {};
        },
        message: /not valid JSON/
      },
      {
        name: "stale source",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          await writeFile(path.join(fixture.projectPath, "slides", "001-slide.html"), "changed\n", "utf8");
          return {};
        },
        message: /source fingerprint mismatch/
      },
      {
        name: "missing artifact",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          await rm(path.join(fixture.projectPath, "exports", "deck.pdf"));
          return {};
        },
        message: /ENOENT/
      },
      {
        name: "symlinked report",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const outsideReport = path.join(fixture.root, "outside-report.json");
          await writeFile(outsideReport, await readFile(fixture.reportPath));
          await rm(fixture.reportPath);
          await symlink(outsideReport, fixture.reportPath);
          return {};
        },
        message: /must not be a symlink/
      },
      {
        name: "compatible endpoint mismatch",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const validation = JSON.parse(await readFile(fixture.validationPath, "utf8")) as Record<string, unknown>;
          validation.provider = "compatible";
          validation.baseUrl = "https://compatible.example.test/v1";
          await writeFile(fixture.validationPath, JSON.stringify(validation), "utf8");
          const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
            provider: Record<string, unknown>;
          };
          report.provider = {
            provider: "compatible",
            model: "gpt-test",
            baseUrlSha256: "0".repeat(64)
          };
          await writeFile(fixture.reportPath, JSON.stringify(report), "utf8");
          return {};
        },
        message: /compatible endpoint does not match/
      },
      {
        name: "tampered checkpoint snapshot",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          await writeFile(
            path.join(fixture.projectPath, ".htmlslide", "checkpoints", "run-real-provider", "snapshot", "deck.json"),
            "tampered\n",
            "utf8"
          );
          return {};
        },
        message: /Checkpoint snapshot digest mismatch/
      },
      {
        name: "secret-bearing project source",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          await writeFile(
            path.join(fixture.projectPath, "notes", "001-slide.md"),
            "api_key=sk-project-secret-value-123456\n",
            "utf8"
          );
          await refreshFixtureSourceBinding(fixture);
          return {};
        },
        message: /Project source contains common secret-like material/
      },
      {
        name: "invalid export kind",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const manifest = JSON.parse(await readFile(fixture.exportManifestPath, "utf8")) as {
            artifacts: Array<Record<string, unknown>>;
          };
          const pdf = manifest.artifacts.find((artifact) => artifact.kind === "pdf");
          if (pdf) {
            pdf.kind = "deckpkg";
          }
          await writeFile(fixture.exportManifestPath, JSON.stringify(manifest), "utf8");
          await refreshFixtureReportManifestBinding(fixture);
          return {};
        },
        message: /kind\/path metadata is inconsistent/
      },
      {
        name: "empty thumbnail slide id",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const manifest = JSON.parse(await readFile(fixture.exportManifestPath, "utf8")) as {
            artifacts: Array<Record<string, unknown>>;
          };
          const thumbnail = manifest.artifacts.find((artifact) => artifact.kind === "thumbnail");
          if (thumbnail) {
            thumbnail.slideId = "";
          }
          await writeFile(fixture.exportManifestPath, JSON.stringify(manifest), "utf8");
          await refreshFixtureReportManifestBinding(fixture);
          return {};
        },
        message: /kind\/path metadata is inconsistent/
      },
      {
        name: "symlinked output parent",
        mutate: async (fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>) => {
          const outside = path.join(fixture.root, "outside-evidence");
          await mkdir(outside);
          const link = path.join(fixture.projectPath, ".htmlslide", "reports", "link");
          await symlink(outside, link);
          return { outputPath: path.join(link, "evidence.json") };
        },
        message: /Project directory must not contain symlinks/
      }
    ];

    for (const testCase of cases) {
      const fixture = await createByokEvidenceFixture();
      try {
        const mutation = await testCase.mutate(fixture);
        await expect(verifyByokEvidence([
          "--project", fixture.projectPath,
          "--provider-validation", fixture.validationPath,
          "--report", fixture.reportPath,
          "--output", mutation.outputPath ?? path.join(
            fixture.projectPath,
            ".htmlslide",
            "reports",
            `${testCase.name}.json`
          ),
          ...(mutation.extraArgs ?? [])
        ])).rejects.toThrow(testCase.message);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
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

function completeChecklist() {
  const rendered = renderChecklist({
    artifactUrl: "https://example.test/htmlslide-alpha.dmg",
    channel: "alpha",
    ciRunUrl: "https://github.test/ci",
    packageRunUrl: "https://github.test/package",
    version: "0.1.0"
  }).replace(/<[^>\n]+>/gu, "filled-value");
  const manualStart = rendered.indexOf("## Manual Acceptance Script");
  const resultStart = rendered.indexOf("## Result", manualStart);
  const automated = rendered
    .slice(0, manualStart)
    .replace(/\bTODO\b/gu, "Recorded in release tracker")
    .replace(/^- \[ \] /gmu, "- [x] ");
  const manual = rendered
    .slice(manualStart, resultStart)
    .replace(/^- Status: TODO$/gmu, "- Status: Pass")
    .replace(/^- Evidence:\s*$/gmu, "- Evidence: https://example.test/evidence")
    .replace(/^- Notes:\s*$/gmu, "- Notes: Manual acceptance record.");
  const result = rendered
    .slice(resultStart)
    .replace("- Status: TODO", "- Status: Accepted")
    .replace("- [ ] Accepted for release candidate publication.", "- [x] Accepted for release candidate publication.")
    .replace(/\bTODO\b/gu, "None");

  return `${automated}${manual}${result}`;
}

async function createByokEvidenceFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-byok-evidence-"));
  const projectPath = path.join(fixtureRoot, "deck");
  const reportsPath = path.join(projectPath, ".htmlslide", "reports");
  const exportsPath = path.join(projectPath, "exports");
  await Promise.all([
    mkdir(reportsPath, { recursive: true }),
    mkdir(path.join(projectPath, "slides"), { recursive: true }),
    mkdir(path.join(projectPath, "notes"), { recursive: true }),
    mkdir(path.join(exportsPath, "thumbnails"), { recursive: true })
  ]);

  const slides = Array.from({ length: 8 }, (_, index) => {
    const id = `${String(index + 1).padStart(3, "0")}-slide`;
    return { id, title: `Slide ${index + 1}`, source: `slides/${id}.html`, notes: `notes/${id}.md` };
  });
  await Promise.all(slides.flatMap((slide) => [
    writeFile(path.join(projectPath, slide.source), `<section data-slide-id="${slide.id}"></section>\n`, "utf8"),
    writeFile(path.join(projectPath, slide.notes), `# ${slide.title}\n`, "utf8")
  ]));
  await writeFile(path.join(projectPath, "deck.json"), JSON.stringify({
    schemaVersion: "0.1.0",
    id: "real-provider-deck",
    title: "Real Provider Deck",
    language: "en-US",
    aspectRatio: "16:9",
    viewport: { width: 1920, height: 1080 },
    slides
  }, null, 2), "utf8");

  const sourcePaths = ["deck.json", ...slides.flatMap((slide) => [slide.source, slide.notes])];
  const sources = [];
  for (const sourcePath of sourcePaths) {
    const bytes = await readFile(path.join(projectPath, sourcePath));
    sources.push({
      path: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  sources.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const sourceDigest = createHash("sha256").update(JSON.stringify(
    sources.map((source) => ({ path: source.path, sizeBytes: source.sizeBytes, sha256: source.sha256 }))
  )).digest("hex");

  const artifactFixtures = [
    { path: "exports/deck.pdf", kind: "pdf", content: "%PDF-test" },
    { path: "exports/deck.deckpkg", kind: "deckpkg", content: "deckpkg-test" },
    ...slides.map((slide) => ({
      path: `exports/thumbnails/${slide.id}.png`,
      kind: "thumbnail",
      slideId: slide.id,
      content: `png-${slide.id}`
    }))
  ];
  const artifacts = [];
  for (const artifact of artifactFixtures) {
    const bytes = Buffer.from(artifact.content);
    await writeFile(path.join(projectPath, artifact.path), bytes);
    artifacts.push({
      path: artifact.path,
      kind: artifact.kind,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(artifact.slideId ? { slideId: artifact.slideId } : {})
    });
  }
  artifacts.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  await writeFile(path.join(exportsPath, "export-manifest.json"), JSON.stringify({
    schemaVersion: "0.1.0",
    compilerVersion: "0.1.0",
    hashAlgorithm: "sha256",
    sourceDigest,
    sources,
    artifacts
  }, null, 2), "utf8");
  const exportManifestSha256 = createHash("sha256")
    .update(await readFile(path.join(exportsPath, "export-manifest.json")))
    .digest("hex");

  const validationPath = path.join(fixtureRoot, "provider-validation.json");
  await writeFile(validationPath, JSON.stringify({
    status: "passed",
    command: "agent validate-provider",
    provider: "openai",
    model: "gpt-test",
    apiKeyEnv: "OPENAI_API_KEY",
    credential: { ok: true, providerId: "htmlslide-provider-validation" },
    secretRecorded: false,
    exitCode: 0
  }, null, 2), "utf8");

  const thumbnailCachePath = path.join(projectPath, ".htmlslide", "cache", "thumbnails", "001-slide.png");
  await mkdir(path.dirname(thumbnailCachePath), { recursive: true });
  await writeFile(thumbnailCachePath, "cache-only", "utf8");
  const artifactPaths = [
    ...artifacts.map((artifact) => path.join(projectPath, artifact.path)),
    thumbnailCachePath
  ];
  const checkpointRoot = path.join(projectPath, ".htmlslide", "checkpoints", "run-real-provider");
  await mkdir(path.join(checkpointRoot, "snapshot"), { recursive: true });
  const checkpointDeck = "{}\n";
  const checkpointDeckDigest = createHash("sha256").update(checkpointDeck).digest("hex");
  await writeFile(path.join(checkpointRoot, "snapshot", "deck.json"), checkpointDeck, "utf8");
  await writeFile(path.join(checkpointRoot, "manifest.json"), JSON.stringify({
    schemaVersion: "0.1.0",
    id: "checkpoint-run-real-provider",
    runId: "run-real-provider",
    projectRoot: projectPath,
    strategy: "file-copy",
    createdAt: "2026-07-11T00:00:00.000Z",
    label: "Before run",
    sourceRoots: ["deck.json", "slides/", "notes/", "theme/", "assets/"],
    files: [{
      path: "deck.json",
      status: "modified",
      origin: "snapshot",
      snapshotPath: "snapshot/deck.json",
      digest: checkpointDeckDigest,
      originalDigest: checkpointDeckDigest
    }],
    restore: { canRevert: true, notes: "Fixture checkpoint" }
  }, null, 2), "utf8");
  const reportPayload = JSON.stringify({
    schemaVersion: "0.1.0",
    kind: "htmlslide-agent-run-report",
    runId: "run-real-provider",
    providerId: "htmlslide-byok",
    provider: { provider: "openai", model: "gpt-test" },
    targetSlideCount: 8,
    projectPath,
    generatedAt: "2026-07-11T00:00:00.000Z",
    ok: true,
    status: "succeeded",
    stages: [],
    outputs: {
      outline: { title: "Deck", language: "en-US", audience: "reviewers", durationMinutes: 10, slides },
      build: {
        filesChanged: ["deck.json", ...slides.flatMap((slide) => [slide.source, slide.notes])],
        slidesChanged: slides.map((slide) => slide.id),
        notesChanged: slides.map((slide) => slide.id),
        themeChanged: [],
        sourceWriteCount: 17,
        sourceWritePaths: ["deck.json", ...slides.flatMap((slide) => [slide.source, slide.notes])]
      },
      checks: [],
      repairs: []
    },
    applied: { source: "provider-source-writes", filesChanged: ["deck.json"], writeCount: 17 },
    checkpoint: { id: "checkpoint-run-real-provider", strategy: "file-copy", canRevert: true },
    exportManifest: { sourceDigest, artifactCount: artifacts.length, sha256: exportManifestSha256 },
    cli: {
      check: { ok: true, exitCode: 0, status: "passed", summary: { errors: 0, warnings: 0 }, artifactPaths: [] },
      export: { ok: true, exitCode: 0, status: "passed", artifactPaths }
    }
  }, null, 2);
  await Promise.all([
    writeFile(path.join(reportsPath, "latest-agent-run.json"), reportPayload, "utf8"),
    writeFile(path.join(reportsPath, "agent-run-run-real-provider.json"), reportPayload, "utf8")
  ]);

  return {
    root: fixtureRoot,
    projectPath,
    validationPath,
    reportPath: path.join(reportsPath, "agent-run-run-real-provider.json"),
    exportManifestPath: path.join(exportsPath, "export-manifest.json")
  };
}

async function createExternalAgentEvidenceFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-external-agent-evidence-"));
  const evidencePath = path.join(fixtureRoot, "evidence-input.json");
  const manifestPath = path.join(fixtureRoot, "alpha-manifest.json");
  await writeFile(evidencePath, JSON.stringify({
    schemaVersion: 1,
    kind: "htmlslide-external-agent-rc-evidence-input",
    status: "passed",
    provider: { id: "codex-cli", version: "codex-cli 0.144.1" },
    authentication: { status: "passed", command: "codex login status" },
    permissionSummary: {
      sandbox: "workspace-write",
      permissionFlags: ["--ignore-user-config", "--skip-git-repo-check"]
    },
    successfulRun: {
      runId: "run-success-123",
      status: "succeeded",
      edit: "passed",
      changedFiles: ["slides/001-title.html"],
      check: "passed",
      export: "passed",
      diffReview: "passed",
      revert: "passed"
    },
    cancellationRun: {
      runId: "run-cancel-456",
      status: "cancelled",
      postCancelCheckExport: "not-started"
    },
    secretSafety: "passed"
  }, null, 2), "utf8");
  await writeFile(manifestPath, JSON.stringify({
    appName: "HTMLslide",
    channel: "alpha",
    version: "0.1.0",
    arch: "arm64",
    signing: "ad-hoc",
    notarized: false,
    stapled: false,
    artifacts: [
      "/tmp/HTMLslide-0.1.0-unsigned-alpha-arm64.dmg",
      "/tmp/HTMLslide-0.1.0-unsigned-alpha-arm64.zip"
    ],
    artifactMetadata: [
      {
        path: "/tmp/HTMLslide-0.1.0-unsigned-alpha-arm64.dmg",
        fileName: "HTMLslide-0.1.0-unsigned-alpha-arm64.dmg",
        sizeBytes: 123,
        sha256: "a".repeat(64)
      },
      {
        path: "/tmp/HTMLslide-0.1.0-unsigned-alpha-arm64.zip",
        fileName: "HTMLslide-0.1.0-unsigned-alpha-arm64.zip",
        sizeBytes: 456,
        sha256: "b".repeat(64)
      }
    ]
  }, null, 2), "utf8");
  return { root: fixtureRoot, evidencePath, manifestPath };
}

async function refreshFixtureSourceBinding(
  fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>
): Promise<void> {
  const manifest = JSON.parse(await readFile(fixture.exportManifestPath, "utf8")) as {
    sourceDigest: string;
    sources: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
  for (const source of manifest.sources) {
    const bytes = await readFile(path.join(fixture.projectPath, source.path));
    source.sizeBytes = bytes.byteLength;
    source.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  manifest.sources.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  manifest.sourceDigest = createHash("sha256").update(JSON.stringify(
    manifest.sources.map((source) => ({ path: source.path, sizeBytes: source.sizeBytes, sha256: source.sha256 }))
  )).digest("hex");
  await writeFile(fixture.exportManifestPath, JSON.stringify(manifest), "utf8");

  await refreshFixtureReportManifestBinding(fixture);
}

async function refreshFixtureReportManifestBinding(
  fixture: Awaited<ReturnType<typeof createByokEvidenceFixture>>
): Promise<void> {
  const manifest = JSON.parse(await readFile(fixture.exportManifestPath, "utf8")) as {
    artifacts: unknown[];
    sourceDigest: string;
  };
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
    exportManifest: { artifactCount: number; sourceDigest: string; sha256: string };
  };
  report.exportManifest.sourceDigest = manifest.sourceDigest;
  report.exportManifest.artifactCount = manifest.artifacts.length;
  report.exportManifest.sha256 = createHash("sha256")
    .update(await readFile(fixture.exportManifestPath))
    .digest("hex");
  await writeFile(fixture.reportPath, JSON.stringify(report), "utf8");
}
