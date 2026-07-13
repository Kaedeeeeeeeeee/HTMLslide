import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureSchemaVersion = "0.1.0";

export async function createByokEvidenceFixture() {
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
    schemaVersion: fixtureSchemaVersion,
    id: "fixture-byok-deck",
    title: "Fixture BYOK Deck",
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
    { path: "exports/deck.pdf", kind: "pdf", content: "%PDF-fixture" },
    { path: "exports/deck.deckpkg", kind: "deckpkg", content: "deckpkg-fixture" },
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
  const exportManifestPath = path.join(exportsPath, "export-manifest.json");
  await writeFile(exportManifestPath, JSON.stringify({
    schemaVersion: fixtureSchemaVersion,
    compilerVersion: "0.1.0",
    hashAlgorithm: "sha256",
    sourceDigest,
    sources,
    artifacts
  }, null, 2), "utf8");
  const exportManifestSha256 = createHash("sha256")
    .update(await readFile(exportManifestPath))
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
  const checkpointRoot = path.join(projectPath, ".htmlslide", "checkpoints", "run-fixture-provider");
  await mkdir(path.join(checkpointRoot, "snapshot"), { recursive: true });
  const checkpointDeck = "{}\n";
  const checkpointDeckDigest = createHash("sha256").update(checkpointDeck).digest("hex");
  await writeFile(path.join(checkpointRoot, "snapshot", "deck.json"), checkpointDeck, "utf8");
  await writeFile(path.join(checkpointRoot, "manifest.json"), JSON.stringify({
    schemaVersion: fixtureSchemaVersion,
    id: "checkpoint-run-fixture-provider",
    runId: "run-fixture-provider",
    projectRoot: projectPath,
    strategy: "file-copy",
    createdAt: "2026-07-13T00:00:00.000Z",
    label: "Fixture checkpoint",
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

  const reportPath = path.join(reportsPath, "agent-run-run-fixture-provider.json");
  const reportPayload = JSON.stringify({
    schemaVersion: fixtureSchemaVersion,
    kind: "htmlslide-agent-run-report",
    runId: "run-fixture-provider",
    providerId: "htmlslide-byok",
    provider: { provider: "openai", model: "gpt-test" },
    targetSlideCount: 8,
    projectPath,
    generatedAt: "2026-07-13T00:00:00.000Z",
    ok: true,
    status: "succeeded",
    stages: [],
    outputs: {
      outline: { title: "Fixture Deck", language: "en-US", audience: "test", durationMinutes: 10, slides },
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
    checkpoint: { id: "checkpoint-run-fixture-provider", strategy: "file-copy", canRevert: true },
    exportManifest: { sourceDigest, artifactCount: artifacts.length, sha256: exportManifestSha256 },
    cli: {
      check: { ok: true, exitCode: 0, status: "passed", summary: { errors: 0, warnings: 0 }, artifactPaths: [] },
      export: { ok: true, exitCode: 0, status: "passed", artifactPaths }
    }
  }, null, 2);
  await Promise.all([
    writeFile(path.join(reportsPath, "latest-agent-run.json"), reportPayload, "utf8"),
    writeFile(reportPath, reportPayload, "utf8")
  ]);

  return { root: fixtureRoot, projectPath, validationPath, reportPath, exportManifestPath };
}
