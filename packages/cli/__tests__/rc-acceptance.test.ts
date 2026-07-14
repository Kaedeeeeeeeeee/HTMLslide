import { access, lstat, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/index";
import { runRcByokAcceptance } from "../src/rc-acceptance";

const createFakeProvider = (slideCount: number, options: { secretSource?: boolean; validSource?: boolean } = {}) => {
  const validSource = options.validSource ?? true;
  const secretSource = options.secretSource ?? false;
  const events: string[] = [];
  const slides = Array.from({ length: slideCount }, (_, index) => ({
    id: `${String(index + 1).padStart(3, "0")}-slide`,
    title: `Provider slide ${index + 1}`,
    kind: index === 0 ? "title" : index === slideCount - 1 ? "closing" : "content",
    goal: `Show provider slide ${index + 1}`
  }));
  const deck = JSON.stringify({
    schemaVersion: "0.1.0",
    id: "rc-provider-deck",
    title: "RC Provider Deck",
    language: "en-US",
    aspectRatio: "16:9",
    viewport: { width: 1920, height: 1080 },
    slides: slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      source: `slides/${slide.id}.html`,
      notes: `notes/${slide.id}.md`,
      kind: slide.kind,
      status: "ready"
    })),
    export: {
      pdf: true,
      html: false,
      deckpkg: true,
      thumbnails: true,
      speakerNotes: true
    }
  }, null, 2);
  const sourceWrites = [
    { path: "deck.json", content: deck },
    ...slides.flatMap((slide) => [
      {
        path: `slides/${slide.id}.html`,
        content: validSource
          ? secretSource
            ? `<section class="slide" data-slide-id="${slide.id}"><p>api_key=sk-test-secret-long-value</p></section>\n`
            : `<section class="slide" data-slide-id="${slide.id}"><h1>${slide.title}</h1></section>\n`
          : `<section class="slide"><h1>${slide.title}</h1></section>\n`
      },
      {
        path: `notes/${slide.id}.md`,
        content: `# ${slide.title}\n\nSpeaker note.\n`
      }
    ])
  ];

  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/models/")) {
      events.push("provider-validation");
      return new Response(JSON.stringify({ id: "fake-model" }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
    const request = JSON.parse(body.messages?.[1]?.content ?? "{}") as { stage?: string };
    events.push(`stage:${request.stage ?? "unknown"}`);
    const output: Record<string, unknown> = {
      brief: {
        title: "RC Provider Deck",
        brief: "A deterministic release-candidate deck",
        language: "en-US",
        audience: "testers",
        durationMinutes: 8
      },
      outline: {
        title: "RC Provider Deck",
        language: "en-US",
        audience: "testers",
        durationMinutes: 8,
        slides
      },
      "visual-direction": {
        directions: [{
          id: "rc-direction",
          label: "RC Direction",
          rationale: "Deterministic test direction",
          sampleSlideIds: slides.slice(0, 3).map((slide) => slide.id),
          tokens: { background: "#ffffff", text: "#111111", accent: "#2255cc" }
        }],
        selectedDirectionId: "rc-direction"
      },
      build: {
        filesChanged: sourceWrites.map((write) => write.path),
        slidesChanged: slides.map((slide) => slide.id),
        notesChanged: slides.map((slide) => slide.id),
        themeChanged: [],
        sourceWrites
      },
      check: {
        status: "passed",
        summary: { errors: 0, warnings: 0, info: 0 },
        issues: []
      },
      export: { artifacts: [{ type: "pdf", path: "exports/rc-provider.pdf" }] },
      review: {
        summary: "RC provider run is ready for review.",
        filesChanged: sourceWrites.map((write) => write.path),
        issuesRemaining: 0,
        nextActions: []
      }
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output[request.stage ?? ""]) } }] }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  return { fetch, events, sourceWrites };
};

const createFixture = async (): Promise<{ root: string; projectPath: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-rc-acceptance-test-"));
  const projectPath = path.join(root, "deck");
  await createProject(projectPath, "RC Fixture", { templateId: "default" });
  return { root, projectPath };
};

describe("runRcByokAcceptance", { timeout: 120_000 }, () => {
  it("runs provider validation before generation and writes sanitized run-bound evidence", async () => {
    const fixture = await createFixture();
    const provider = createFakeProvider(8);
    try {
      const result = await runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        artifactUrl: "htmlslide-rc-fixture",
        artifactSha256: "a".repeat(64),
        commit: "abc1234",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: provider.fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        targetSlideCount: 8,
        task: "Create a deterministic release-candidate deck."
      });

      expect(result.status).toBe("passed");
      expect(result.slideCount).toBe(8);
      expect(result.targetSlideCount).toBe(8);
      expect(result.evidencePath).toMatch(/^\.htmlslide\/reports\/rc-evidence-[^/]+\/evidence\.json$/u);
      expect(provider.events.indexOf("provider-validation")).toBeGreaterThanOrEqual(0);
      expect(provider.events.some((event) => event.startsWith("stage:brief"))).toBe(true);
      expect(provider.events.indexOf("provider-validation")).toBeLessThan(provider.events.findIndex((event) => event.startsWith("stage:brief")));

      const evidencePath = path.join(fixture.projectPath, result.evidencePath);
      const providerValidationPath = path.join(fixture.projectPath, result.providerValidationPath);
      const evidenceText = await readFile(evidencePath, "utf8");
      const providerValidationText = await readFile(providerValidationPath, "utf8");
      expect(evidenceText).toContain("htmlslide-rc-fixture");
      expect(evidenceText).not.toContain("sk-test-secret");
      expect(evidenceText).not.toContain(fixture.root);
      expect(providerValidationText).not.toContain("sk-test-secret");
      const evidence = JSON.parse(evidenceText) as { artifacts: Array<{ kind: string; path: string }>; candidate: { artifactSha256?: string } };
      expect(evidence).toMatchObject({
        candidate: { artifactSha256: "a".repeat(64) },
        checks: {
          agentRun: "passed",
          checkpoint: "passed",
          cliCheck: "passed",
          cliExport: "passed",
          exportArtifacts: "passed",
          providerValidation: "passed",
          secretSafety: "passed"
        },
        inputs: {
          exportManifest: { path: "exports/export-manifest.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }
        }
      });
      const pdfPath = evidence.artifacts.find((artifact) => artifact.kind === "pdf")?.path;
      expect(pdfPath).toMatch(/^exports\/.*\.pdf$/u);
      await expect(access(path.join(fixture.projectPath, pdfPath as string))).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid candidate artifact SHA-256 before provider work", async () => {
    const fixture = await createFixture();
    const provider = createFakeProvider(8);
    try {
      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        artifactSha256: "not-a-sha256",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: provider.fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        task: "invalid artifact binding"
      })).rejects.toMatchObject({ code: "RC_ARTIFACT_SHA256_INVALID" });
      expect(provider.events).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts the upper target bound and rejects counts outside 8-12 before provider work", async () => {
    const fixture = await createFixture();
    try {
      const upperBound = await runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: createFakeProvider(12).fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        targetSlideCount: 12,
        task: "Create a twelve-slide deterministic release-candidate deck."
      });
      expect(upperBound.slideCount).toBe(12);

      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: createFakeProvider(12).fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        targetSlideCount: 7,
        task: "invalid target"
      })).rejects.toMatchObject({ code: "RC_TARGET_SLIDE_COUNT_INVALID" });
      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: createFakeProvider(12).fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        targetSlideCount: 13,
        task: "invalid target"
      })).rejects.toMatchObject({ code: "RC_TARGET_SLIDE_COUNT_INVALID" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink project root and does not write a false evidence file", async () => {
    const fixture = await createFixture();
    const linkPath = path.join(fixture.root, "linked-deck");
    try {
      await symlink(fixture.projectPath, linkPath, "dir");
      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: createFakeProvider(8).fetch,
        model: "fake-model",
        projectPath: linkPath,
        provider: "openai",
        task: "symlink project"
      })).rejects.toMatchObject({ code: "RC_PROJECT_INVALID" });
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      await expect(readlink(linkPath)).resolves.toBe(fixture.projectPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not claim success or write evidence when the provider source produces an invalid deck", async () => {
    const fixture = await createFixture();
    const provider = createFakeProvider(8, { validSource: false });
    try {
      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "sk-test-secret" },
        fetch: provider.fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        task: "Produce a deck that should fail check."
      })).rejects.toMatchObject({ code: "RC_AGENT_RUN_FAILED" });
      const reportsPath = path.join(fixture.projectPath, ".htmlslide", "reports");
      const reportEntries = await lstat(reportsPath);
      expect(reportEntries.isDirectory()).toBe(true);
      const evidenceCandidates = await readFile(path.join(reportsPath, "latest-agent-run.json"), "utf8");
      expect(evidenceCandidates).toContain("failed");
      await expect(access(path.join(reportsPath, "rc-evidence"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails the source secret scan before writing successful evidence", async () => {
    const fixture = await createFixture();
    const provider = createFakeProvider(8, { secretSource: true });
    try {
      await expect(runRcByokAcceptance({
        apiKeyEnv: "FAKE_API_KEY",
        env: { FAKE_API_KEY: "safe-test-key" },
        fetch: provider.fetch,
        model: "fake-model",
        projectPath: fixture.projectPath,
        provider: "openai",
        task: "Create a deck without secrets."
      })).rejects.toMatchObject({ code: "RC_SECRET_SAFETY_FAILED" });
      await expect(access(path.join(fixture.projectPath, ".htmlslide", "reports", "rc-evidence"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
