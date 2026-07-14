import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const maxJsonBytes = 5 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const allowedProviders = new Set(["openai", "anthropic", "compatible"]);

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function main(args) {
  const options = parseArgs(args);
  const evidence = await verifyByokAcceptance(options);
  const projectInput = path.resolve(options.project);
  const projectRoot = await realpath(projectInput);
  const inputReportsRoot = path.join(projectInput, ".htmlslide", "reports");
  const requestedOutputPath = path.resolve(
    options.output ?? path.join(
      projectInput,
      ".htmlslide",
      "reports",
      `byok-acceptance-${safeRunId(evidence.runId)}.json`
    )
  );
  assertInside(inputReportsRoot, requestedOutputPath, "Evidence output");
  const outputPath = path.join(projectRoot, path.relative(projectInput, requestedOutputPath));
  const outputParent = path.relative(projectRoot, path.dirname(outputPath)).split(path.sep).join("/");
  await ensureSafeProjectDirectory(projectRoot, outputParent);
  await writeJsonAtomic(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({ status: "passed", outputPath, runId: evidence.runId })}\n`);
  return { evidence, outputPath };
}

export function parseArgs(args) {
  const parsed = {};
  const allowed = new Set([
    "project",
    "providerValidation",
    "runId",
    "report",
    "output",
    "commit",
    "artifactUrl",
    "artifactSha256"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: --${rawKey}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (typeof parsed.project !== "string" || parsed.project.trim().length === 0) {
    throw new Error("Missing required --project path.");
  }
  if (typeof parsed.providerValidation !== "string" || parsed.providerValidation.trim().length === 0) {
    throw new Error("Missing required --provider-validation JSON path.");
  }
  return parsed;
}

export async function verifyByokAcceptance(options) {
  const projectInput = path.resolve(options.project);
  const projectInfo = await lstat(projectInput);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
    throw new Error("BYOK evidence project must be a real directory, not a symlink.");
  }
  const projectRoot = await realpath(projectInput);

  const validationPath = path.resolve(options.providerValidation);
  const validation = await readJsonRegularFile(validationPath, "Provider validation");
  assertNoSecrets(validation, "provider validation");
  validateProviderValidation(validation);

  const reportInputPath = path.resolve(
    options.report ?? path.join(
      projectRoot,
      ".htmlslide",
      "reports",
      options.runId ? `agent-run-${safeRunId(options.runId)}.json` : "latest-agent-run.json"
    )
  );
  const reportInputStat = await lstat(reportInputPath);
  if (reportInputStat.isSymbolicLink()) {
    throw new Error("Agent report must not be a symlink.");
  }
  const reportPath = await realpath(reportInputPath);
  assertInside(path.join(projectRoot, ".htmlslide", "reports"), reportPath, "Agent report");
  const safeReportPath = await resolveSafeProjectFile(
    projectRoot,
    path.relative(projectRoot, reportPath).split(path.sep).join("/"),
    "Agent report"
  );
  const report = await readJsonRegularFile(safeReportPath, "Agent report");
  assertNoSecrets(report, "agent report");
  const reportProjectRoot = isRecord(report) && typeof report.projectPath === "string"
    ? await realpath(path.resolve(report.projectPath))
    : undefined;

  const requestedRunId = options.runId?.trim();
  validateAgentReport(report, validation, projectRoot, reportProjectRoot, requestedRunId);
  const runId = report.runId;

  const deck = await readJsonProjectFile(projectRoot, "deck.json", "Deck manifest");
  const deckSlides = validateDeck(deck);
  const outlineSlides = report.outputs.outline.slides;
  const outlineIds = outlineSlides.map((slide, index) => requireString(slide?.id, `outline slide ${index + 1} id`));
  const deckIds = deckSlides.map((slide) => slide.id);
  if (JSON.stringify(outlineIds) !== JSON.stringify(deckIds)) {
    throw new Error("Agent outline slide IDs/order do not match deck.json.");
  }

  for (const slide of deckSlides) {
    await resolveSafeProjectFile(projectRoot, slide.source, `Slide source ${slide.id}`);
    if (slide.notes) {
      await resolveSafeProjectFile(projectRoot, slide.notes, `Slide notes ${slide.id}`);
    }
  }

  const exportManifestPath = await resolveSafeProjectFile(
    projectRoot,
    "exports/export-manifest.json",
    "Export manifest"
  );
  const exportManifest = await readJsonRegularFile(exportManifestPath, "Export manifest");
  const exportManifestSha256 = await sha256File(exportManifestPath);
  const sources = await verifyExportSources(projectRoot, exportManifest);
  if (
    !isRecord(report.exportManifest) ||
    report.exportManifest.sourceDigest !== exportManifest.sourceDigest ||
    report.exportManifest.artifactCount !== exportManifest.artifacts.length ||
    report.exportManifest.sha256 !== exportManifestSha256
  ) {
    throw new Error("Agent report is not bound to the current export manifest.");
  }
  await verifyCheckpoint(projectRoot, report);
  await scanProjectSourcesForCommonSecrets(projectRoot, sources);
  const artifacts = await verifyExportArtifacts(projectRoot, exportManifest);
  const reportArtifacts = await Promise.all(report.cli.export.artifactPaths.map((artifactPath) =>
    toProjectRelativePath(projectRoot, artifactPath, "Agent report export artifact")
  ));
  const manifestArtifactPaths = artifacts.map((artifact) => artifact.path);
  const reportArtifactSet = new Set(reportArtifacts);
  if (manifestArtifactPaths.some((artifactPath) => !reportArtifactSet.has(artifactPath))) {
    throw new Error("Agent report is missing an export-manifest artifact.");
  }
  const unexpectedReportArtifacts = reportArtifacts.filter((artifactPath) =>
    !manifestArtifactPaths.includes(artifactPath) && !artifactPath.startsWith(".htmlslide/cache/")
  );
  if (unexpectedReportArtifacts.length > 0) {
    throw new Error(`Agent report contains unexpected export artifacts: ${unexpectedReportArtifacts.join(", ")}.`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "htmlslide-byok-acceptance-evidence",
    status: "passed",
    generatedAt: new Date().toISOString(),
    runId,
    provider: {
      provider: validation.provider,
      model: validation.model
    },
    project: {
      id: requireString(deck.id, "deck id"),
      schemaVersion: requireString(deck.schemaVersion, "deck schemaVersion"),
      slideCount: deckSlides.length,
      slideIds: deckIds
    },
    candidate: {
      binding: "caller-declared",
      ...(options.commit ? { claimedCommit: cleanMetadata(options.commit, "commit") } : {}),
      ...(options.artifactUrl ? { claimedArtifactUrl: validateArtifactReference(options.artifactUrl) } : {}),
      ...(options.artifactSha256 !== undefined ? { artifactSha256: validateArtifactSha256(options.artifactSha256, "BYOK evidence artifact SHA-256") } : {})
    },
    inputs: {
      providerValidationSha256: await sha256File(validationPath),
      agentReportPath: path.relative(projectRoot, reportPath).split(path.sep).join("/"),
      agentReportSha256: await sha256File(reportPath)
    },
    checks: {
      providerValidation: "passed",
      outlineAndDeck: "passed",
      providerSourceWrites: "passed",
      reversibleCheckpoint: "passed",
      cliCheck: "passed",
      cliExport: "passed",
      exportArtifacts: "passed",
      secretSafety: "passed"
    },
    exportSourceDigest: exportManifest.sourceDigest,
    artifacts
  };
  assertNoSecrets(evidence, "generated evidence");
  return evidence;
}

export function validateByokAcceptanceEvidence(value, options = {}) {
  assertNoSecrets(value, "BYOK acceptance evidence");
  if (isRecord(value) && (value.fixtureOnly === true || value.providerBoundary === "fixture-only")) {
    throw new Error("Fixture-only BYOK evidence cannot be used for release promotion.");
  }
  if (isRecord(value) && value.kind === "htmlslide-rc-byok-acceptance") {
    return validateCliByokAcceptanceEvidence(value, options);
  }
  return validateLegacyByokAcceptanceEvidence(value, options);
}

function validateCliByokAcceptanceEvidence(value, options) {
  if (value.schemaVersion !== 1 || value.status !== "passed" || value.command !== "rc byok") {
    throw new Error("BYOK acceptance evidence does not match the unified CLI evidence contract.");
  }

  const runId = requireString(value.runId, "BYOK evidence runId");
  if (safeRunId(runId) !== runId) {
    throw new Error("BYOK evidence runId is not safe for release binding.");
  }
  if (value.projectPath !== "." || !isSafeEvidencePath(value.evidenceDir) || !isSafeEvidencePath(value.evidencePath) || !isSafeEvidencePath(value.providerValidationPath)) {
    throw new Error("BYOK CLI evidence contains unsafe project-local paths.");
  }
  if (!allowedProviders.has(value.provider) || typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error("BYOK evidence provider metadata is invalid.");
  }
  if (!Number.isInteger(value.targetSlideCount) || value.targetSlideCount < 8 || value.targetSlideCount > 12 || value.slideCount !== value.targetSlideCount) {
    throw new Error("BYOK evidence does not prove an 8-12 slide project with the requested count.");
  }

  if (!isRecord(value.candidate) || value.candidate.binding !== "caller-declared") {
    throw new Error("BYOK evidence is missing caller-declared candidate binding metadata.");
  }
  const claimedCommit = value.candidate.commit === undefined
    ? undefined
    : cleanMetadata(value.candidate.commit, "BYOK evidence commit");
  const claimedArtifactUrl = value.candidate.artifactUrl === undefined
    ? undefined
    : validateCliArtifactReference(value.candidate.artifactUrl);
  const claimedArtifactSha256 = value.candidate.artifactSha256 === undefined
    ? undefined
    : validateArtifactSha256(value.candidate.artifactSha256, "BYOK evidence artifact SHA-256");
  if (options.expectedCommit !== undefined && claimedCommit !== options.expectedCommit) {
    throw new Error("BYOK evidence claimed commit does not match the candidate commit.");
  }
  if (options.expectedArtifactUrl !== undefined && claimedArtifactUrl !== options.expectedArtifactUrl) {
    throw new Error("BYOK evidence claimed artifact does not match the checklist artifact reference.");
  }
  if (options.expectedArtifactSha256 !== undefined && claimedArtifactSha256 !== options.expectedArtifactSha256) {
    throw new Error("BYOK evidence artifact SHA-256 does not match the verified candidate.");
  }

  const requiredChecks = [
    "providerValidation",
    "agentRun",
    "checkpoint",
    "cliCheck",
    "cliExport",
    "exportArtifacts",
    "secretSafety"
  ];
  if (!isRecord(value.checks) || requiredChecks.some((check) => value.checks[check] !== "passed")) {
    throw new Error("BYOK evidence is missing a passed acceptance check.");
  }

  for (const key of ["providerValidation", "agentReport", "exportManifest"]) {
    const input = isRecord(value.inputs) ? value.inputs[key] : undefined;
    if (!isRecord(input) || !isSafeEvidencePath(input.path) || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 0 || !sha256Pattern.test(input.sha256)) {
      throw new Error("BYOK evidence input fingerprints are invalid.");
    }
  }
  if (value.inputs.exportManifest.path !== "exports/export-manifest.json") {
    throw new Error("BYOK evidence export manifest path is invalid.");
  }
  validateExportArtifactEvidence(value.artifacts);

  return {
    runId,
    provider: value.provider,
    model: value.model,
    slideCount: value.slideCount,
    candidate: {
      binding: "caller-declared",
      ...(claimedCommit === undefined ? {} : { claimedCommit }),
      ...(claimedArtifactUrl === undefined ? {} : { claimedArtifactUrl }),
      ...(claimedArtifactSha256 === undefined ? {} : { artifactSha256: claimedArtifactSha256 })
    }
  };
}

function validateLegacyByokAcceptanceEvidence(value, options) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "htmlslide-byok-acceptance-evidence" || value.status !== "passed") {
    throw new Error("BYOK acceptance evidence does not match the generated evidence contract.");
  }

  const runId = requireString(value.runId, "BYOK evidence runId");
  if (safeRunId(runId) !== runId) {
    throw new Error("BYOK evidence runId is not safe for release binding.");
  }

  if (!isRecord(value.provider) || !allowedProviders.has(value.provider.provider) || typeof value.provider.model !== "string" || value.provider.model.trim().length === 0) {
    throw new Error("BYOK evidence provider metadata is invalid.");
  }

  if (!isRecord(value.project) || value.project.schemaVersion !== "0.1.0" || !Number.isInteger(value.project.slideCount) || value.project.slideCount < 8 || value.project.slideCount > 12 || !Array.isArray(value.project.slideIds) || value.project.slideIds.length !== value.project.slideCount || new Set(value.project.slideIds).size !== value.project.slideIds.length) {
    throw new Error("BYOK evidence does not prove an 8-12 slide project with unique slide IDs.");
  }

  if (!isRecord(value.candidate) || value.candidate.binding !== "caller-declared") {
    throw new Error("BYOK evidence is missing caller-declared candidate binding metadata.");
  }
  if (options.expectedCommit !== undefined && value.candidate.claimedCommit !== options.expectedCommit) {
    throw new Error("BYOK evidence claimed commit does not match the candidate commit.");
  }
  if (options.expectedArtifactUrl !== undefined && value.candidate.claimedArtifactUrl !== options.expectedArtifactUrl) {
    throw new Error("BYOK evidence claimed artifact does not match the checklist artifact reference.");
  }
  const claimedArtifactSha256 = value.candidate.artifactSha256 === undefined
    ? undefined
    : validateArtifactSha256(value.candidate.artifactSha256, "BYOK evidence artifact SHA-256");
  if (options.expectedArtifactSha256 !== undefined && claimedArtifactSha256 !== options.expectedArtifactSha256) {
    throw new Error("BYOK evidence artifact SHA-256 does not match the verified candidate.");
  }

  const requiredChecks = [
    "providerValidation",
    "outlineAndDeck",
    "providerSourceWrites",
    "reversibleCheckpoint",
    "cliCheck",
    "cliExport",
    "exportArtifacts",
    "secretSafety"
  ];
  if (!isRecord(value.checks) || requiredChecks.some((check) => value.checks[check] !== "passed")) {
    throw new Error("BYOK evidence is missing a passed acceptance check.");
  }

  if (!isRecord(value.inputs) || !sha256Pattern.test(value.inputs.providerValidationSha256) || !sha256Pattern.test(value.inputs.agentReportSha256) || !isSafeEvidencePath(value.inputs.agentReportPath)) {
    throw new Error("BYOK evidence input fingerprints are invalid.");
  }
  if (!sha256Pattern.test(value.exportSourceDigest)) {
    throw new Error("BYOK evidence export source digest is invalid.");
  }

  validateExportArtifactEvidence(value.artifacts);

  return {
    runId,
    provider: value.provider.provider,
    model: value.provider.model,
    slideCount: value.project.slideCount,
    candidate: value.candidate
  };
}

function validateExportArtifactEvidence(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("BYOK evidence contains no export artifacts.");
  }
  const kinds = new Set();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !isSafeEvidencePath(artifact.path) || !artifact.path.startsWith("exports/") || artifact.path === "exports/export-manifest.json" || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !sha256Pattern.test(artifact.sha256) || typeof artifact.kind !== "string") {
      throw new Error("BYOK evidence contains invalid artifact metadata.");
    }
    kinds.add(artifact.kind);
  }
  if (!kinds.has("pdf") || !kinds.has("deckpkg") || !kinds.has("thumbnail")) {
    throw new Error("BYOK evidence must include PDF, deckpkg, and thumbnail artifacts.");
  }
}

function validateArtifactSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function validateProviderValidation(validation) {
  if (!isRecord(validation)) {
    throw new Error("Provider validation must be a JSON object.");
  }
  if (
    validation.status !== "passed" ||
    validation.command !== "agent validate-provider" ||
    validation.exitCode !== 0 ||
    validation.secretRecorded !== false ||
    !isRecord(validation.credential) ||
    validation.credential.ok !== true
  ) {
    throw new Error("Provider validation did not pass the sanitized CLI contract.");
  }
  if (!allowedProviders.has(validation.provider)) {
    throw new Error("Provider validation contains an unsupported provider.");
  }
  requireString(validation.model, "provider validation model");
}

function validateAgentReport(report, validation, projectRoot, reportProjectRoot, requestedRunId) {
  if (!isRecord(report)) {
    throw new Error("Agent report must be a JSON object.");
  }
  if (
    report.schemaVersion !== "0.1.0" ||
    report.kind !== "htmlslide-agent-run-report" ||
    report.providerId !== "htmlslide-byok" ||
    report.ok !== true ||
    report.status !== "succeeded"
  ) {
    throw new Error("Agent report is not a successful desktop BYOK run.");
  }
  const runId = requireString(report.runId, "agent report runId");
  if (requestedRunId && runId !== requestedRunId) {
    throw new Error(`Agent report runId ${runId} does not match requested runId ${requestedRunId}.`);
  }
  requireString(report.projectPath, "agent report projectPath");
  if (reportProjectRoot !== projectRoot) {
    throw new Error("Agent report projectPath does not match --project.");
  }
  if (
    !isRecord(report.provider) ||
    report.provider.provider !== validation.provider ||
    report.provider.model !== validation.model
  ) {
    throw new Error("Agent report provider/model does not match provider validation.");
  }
  if (!isRecord(report.outputs) || !isRecord(report.outputs.outline) || !Array.isArray(report.outputs.outline.slides)) {
    throw new Error("Agent report is missing its accepted outline.");
  }
  if (
    !isRecord(report.outputs.build) ||
    !Number.isInteger(report.outputs.build.sourceWriteCount) ||
    report.outputs.build.sourceWriteCount < 1 ||
    !Array.isArray(report.outputs.build.sourceWritePaths) ||
    !report.outputs.build.sourceWritePaths.includes("deck.json")
  ) {
    throw new Error("Agent report does not prove provider build source writes.");
  }
  if (
    !isRecord(report.applied) ||
    report.applied.source !== "provider-source-writes" ||
    !Number.isInteger(report.applied.writeCount) ||
    report.applied.writeCount < 1
  ) {
    throw new Error("Agent report does not prove provider source writes were applied.");
  }
  if (
    !Number.isInteger(report.targetSlideCount) ||
    report.targetSlideCount < 8 ||
    report.targetSlideCount > 12 ||
    report.outputs.outline.slides.length !== report.targetSlideCount
  ) {
    throw new Error("Agent report does not prove an explicit 8-12 slide target.");
  }
  if (validation.provider === "compatible") {
    const baseUrl = requireString(validation.baseUrl, "compatible provider validation baseUrl");
    const expectedBaseUrlSha256 = createHash("sha256").update(baseUrl).digest("hex");
    if (report.provider.baseUrlSha256 !== expectedBaseUrlSha256) {
      throw new Error("Agent report compatible endpoint does not match provider validation.");
    }
  }
  if (!isRecord(report.checkpoint) || report.checkpoint.strategy !== "file-copy" || report.checkpoint.canRevert !== true) {
    throw new Error("Agent report does not contain a reversible file-copy checkpoint.");
  }
  if (!isRecord(report.cli) || !successfulCliSummary(report.cli.check, "check") || !successfulCliSummary(report.cli.export, "export")) {
    throw new Error("Agent report does not contain successful authoritative CLI check/export results.");
  }
  if (!Array.isArray(report.cli.export.artifactPaths) || report.cli.export.artifactPaths.length === 0) {
    throw new Error("Agent report CLI export result has no artifact paths.");
  }
}

function successfulCliSummary(value, kind) {
  return isRecord(value) && value.ok === true && value.exitCode === 0 && value.status === "passed" &&
    (kind !== "check" || (isRecord(value.summary) && value.summary.errors === 0));
}

function validateDeck(deck) {
  if (!isRecord(deck) || deck.schemaVersion !== "0.1.0" || !Array.isArray(deck.slides)) {
    throw new Error("deck.json does not match the supported deck manifest contract.");
  }
  if (deck.slides.length < 8 || deck.slides.length > 12) {
    throw new Error(`Real-provider acceptance requires 8-12 slides; deck.json has ${deck.slides.length}.`);
  }
  const slides = deck.slides.map((slide, index) => {
    if (!isRecord(slide)) {
      throw new Error(`deck.json slide ${index + 1} must be an object.`);
    }
    return {
      id: requireString(slide.id, `deck slide ${index + 1} id`),
      source: requireSafeRelativePath(slide.source, `deck slide ${index + 1} source`),
      notes: slide.notes === undefined ? undefined : requireSafeRelativePath(slide.notes, `deck slide ${index + 1} notes`)
    };
  });
  if (new Set(slides.map((slide) => slide.id)).size !== slides.length) {
    throw new Error("deck.json slide IDs must be unique.");
  }
  return slides;
}

async function verifyExportArtifacts(projectRoot, manifest) {
  if (
    !isRecord(manifest) ||
    manifest.hashAlgorithm !== "sha256" ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error("Export manifest is missing valid SHA-256 artifact metadata.");
  }
  const seen = new Set();
  if (manifest.artifacts.length > 10_000) {
    throw new Error("Export manifest contains too many artifacts.");
  }
  const artifacts = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!isRecord(artifact)) {
      throw new Error(`Export artifact ${index + 1} must be an object.`);
    }
    const artifactPath = requireSafeRelativePath(artifact.path, `export artifact ${index + 1} path`);
    if (!artifactPath.startsWith("exports/") || artifactPath === "exports/export-manifest.json" || seen.has(artifactPath)) {
      throw new Error(`Invalid or duplicate export artifact path: ${artifactPath}.`);
    }
    seen.add(artifactPath);
    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !sha256Pattern.test(artifact.sha256)) {
      throw new Error(`Export artifact ${artifactPath} has invalid fingerprint metadata.`);
    }
    const kind = requireString(artifact.kind, `export artifact ${artifactPath} kind`);
    const validKindPath =
      (kind === "notes" && artifactPath === "exports/notes.json") ||
      (kind === "pdf" && artifactPath.endsWith(".pdf")) ||
      (kind === "html" && artifactPath.endsWith(".html")) ||
      (kind === "deckpkg" && artifactPath.endsWith(".deckpkg")) ||
      (kind === "thumbnail" && /^exports\/thumbnails\/[^/]+\.png$/u.test(artifactPath));
    const hasSlideId = typeof artifact.slideId === "string" && artifact.slideId.trim().length > 0;
    if (!validKindPath || (kind === "thumbnail") !== hasSlideId) {
      throw new Error(`Export artifact kind/path metadata is inconsistent: ${artifactPath}.`);
    }
    assertExactKeys(
      artifact,
      kind === "thumbnail" ? ["kind", "path", "sha256", "sizeBytes", "slideId"] : ["kind", "path", "sha256", "sizeBytes"],
      `export artifact ${artifactPath}`
    );
    const absolutePath = await resolveSafeProjectFile(projectRoot, artifactPath, `Export artifact ${artifactPath}`);
    const fileInfo = await stat(absolutePath);
    const digest = await sha256File(absolutePath);
    if (fileInfo.size !== artifact.sizeBytes || digest !== artifact.sha256) {
      throw new Error(`Export artifact fingerprint mismatch: ${artifactPath}.`);
    }
    artifacts.push({
      path: artifactPath,
      kind,
      sizeBytes: fileInfo.size,
      sha256: digest,
      ...(typeof artifact.slideId === "string" ? { slideId: artifact.slideId } : {})
    });
  }
  if (!artifacts.some((artifact) => artifact.kind === "pdf") || !artifacts.some((artifact) => artifact.kind === "deckpkg")) {
    throw new Error("Real-provider acceptance requires PDF and deckpkg export artifacts.");
  }
  return artifacts;
}

async function verifyExportSources(projectRoot, manifest) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== "0.1.0" ||
    typeof manifest.compilerVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.compilerVersion) ||
    manifest.hashAlgorithm !== "sha256" ||
    !Array.isArray(manifest.sources) ||
    manifest.sources.length === 0 ||
    !sha256Pattern.test(manifest.sourceDigest)
  ) {
    throw new Error("Export manifest is missing valid source fingerprint metadata.");
  }
  assertExactKeys(
    manifest,
    ["artifacts", "compilerVersion", "hashAlgorithm", "schemaVersion", "sourceDigest", "sources"],
    "export manifest"
  );
  if (manifest.sources.length > 10_000 || manifest.artifacts.length > 10_000) {
    throw new Error("Export manifest contains too many fingerprint entries.");
  }
  const seen = new Set();
  const sources = [];
  for (const [index, source] of manifest.sources.entries()) {
    if (!isRecord(source)) {
      throw new Error(`Export source ${index + 1} must be an object.`);
    }
    const sourcePath = requireSafeRelativePath(source.path, `export source ${index + 1} path`);
    if (sourcePath.startsWith("exports/") || seen.has(sourcePath)) {
      throw new Error(`Invalid or duplicate export source path: ${sourcePath}.`);
    }
    seen.add(sourcePath);
    if (!Number.isInteger(source.sizeBytes) || source.sizeBytes < 0 || !sha256Pattern.test(source.sha256)) {
      throw new Error(`Export source ${sourcePath} has invalid fingerprint metadata.`);
    }
    assertExactKeys(source, ["path", "sha256", "sizeBytes"], `export source ${sourcePath}`);
    const absolutePath = await resolveSafeProjectFile(projectRoot, sourcePath, `Export source ${sourcePath}`);
    const fileInfo = await stat(absolutePath);
    const digest = await sha256File(absolutePath);
    if (fileInfo.size !== source.sizeBytes || digest !== source.sha256) {
      throw new Error(`Export source fingerprint mismatch: ${sourcePath}.`);
    }
    sources.push({ path: sourcePath, sizeBytes: fileInfo.size, sha256: digest });
  }
  assertByteSorted(sources.map((source) => source.path), "Export manifest sources");
  assertByteSorted(manifest.artifacts.map((artifact) => artifact.path), "Export manifest artifacts");
  assertNoPathCollisions(sources.map((source) => source.path), "Export manifest sources");
  assertNoPathCollisions(manifest.artifacts.map((artifact) => artifact.path), "Export manifest artifacts");
  const sourceDigest = createHash("sha256").update(JSON.stringify(
    [...sources]
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
      .map((source) => ({ path: source.path, sizeBytes: source.sizeBytes, sha256: source.sha256 }))
  )).digest("hex");
  if (sourceDigest !== manifest.sourceDigest) {
    throw new Error("Export manifest sourceDigest does not match its canonical source fingerprints.");
  }
  return sources;
}

async function verifyCheckpoint(projectRoot, report) {
  const runId = safeRunId(report.runId);
  if (runId !== report.runId) {
    throw new Error("Agent runId is not safe for checkpoint lookup.");
  }
  const checkpointPath = `.htmlslide/checkpoints/${runId}/manifest.json`;
  const checkpoint = await readJsonProjectFile(projectRoot, checkpointPath, "Checkpoint manifest");
  if (
    !isRecord(checkpoint) ||
    checkpoint.id !== report.checkpoint.id ||
    checkpoint.runId !== report.runId ||
    checkpoint.strategy !== "file-copy" ||
    !isRecord(checkpoint.restore) ||
    checkpoint.restore.canRevert !== true ||
    !Array.isArray(checkpoint.files)
  ) {
    throw new Error("Checkpoint manifest does not match the reversible run report contract.");
  }
  const checkpointProjectRoot = await realpath(path.resolve(requireString(checkpoint.projectRoot, "checkpoint projectRoot")));
  if (checkpointProjectRoot !== projectRoot) {
    throw new Error("Checkpoint manifest projectRoot does not match --project.");
  }
  const snapshotFiles = checkpoint.files.filter((file) => isRecord(file) && file.origin === "snapshot");
  if (snapshotFiles.length === 0) {
    throw new Error("Checkpoint manifest contains no source snapshots.");
  }
  for (const file of snapshotFiles) {
    const snapshotPath = requireSafeRelativePath(file.snapshotPath, "checkpoint snapshotPath");
    const snapshotFile = await resolveSafeProjectFile(
      projectRoot,
      `.htmlslide/checkpoints/${runId}/${snapshotPath}`,
      "Checkpoint snapshot"
    );
    const expectedDigest = typeof file.originalDigest === "string" ? file.originalDigest : file.digest;
    if (!sha256Pattern.test(expectedDigest) || await sha256File(snapshotFile) !== expectedDigest) {
      throw new Error(`Checkpoint snapshot digest mismatch: ${snapshotPath}.`);
    }
  }
}

async function scanProjectSourcesForCommonSecrets(projectRoot, sources) {
  for (const source of sources) {
    if (source.sizeBytes > 64 * 1024 * 1024) {
      throw new Error(`Project source is too large for the acceptance secret scan: ${source.path}.`);
    }
    const sourcePath = await resolveSafeProjectFile(projectRoot, source.path, `Secret scan source ${source.path}`);
    const text = await readFile(sourcePath, "utf8");
    if (
      /(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/u.test(text) ||
      /AIza[0-9A-Za-z_-]{30,}/u.test(text) ||
      /AKIA[0-9A-Z]{16}/u.test(text) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text) ||
      /(?:bearer|api[_-]?key|authorization|access[_-]?token|password)\s*[:=]\s*\S{8,}/iu.test(text)
    ) {
      throw new Error(`Project source contains common secret-like material: ${source.path}.`);
    }
  }
}

async function readJsonProjectFile(projectRoot, relativePath, label) {
  const absolutePath = await resolveSafeProjectFile(projectRoot, relativePath, label);
  return readJsonRegularFile(absolutePath, label);
}

async function readJsonRegularFile(filePath, label) {
  const fileInfo = await lstat(filePath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > maxJsonBytes) {
    throw new Error(`${label} must be a regular JSON file no larger than ${maxJsonBytes} bytes.`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveSafeProjectFile(projectRoot, relativePath, label) {
  const safePath = requireSafeRelativePath(relativePath, label);
  let current = projectRoot;
  for (const segment of safePath.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks.`);
    }
  }
  const finalInfo = await lstat(current);
  if (!finalInfo.isFile()) {
    throw new Error(`${label} must resolve to a regular file.`);
  }
  return current;
}

async function ensureSafeProjectDirectory(projectRoot, relativePath) {
  const safePath = requireSafeRelativePath(relativePath, "Project directory");
  let current = await realpath(projectRoot);
  for (const segment of safePath.split("/")) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Project directory must not contain symlinks: ${relativePath}.`);
    }
  }
  return current;
}

function requireSafeRelativePath(value, label) {
  const filePath = requireString(value, label);
  if (
    filePath !== filePath.normalize("NFC") ||
    path.posix.isAbsolute(filePath) ||
    filePath.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(filePath) ||
    filePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe POSIX project-relative path.`);
  }
  return filePath;
}

async function toProjectRelativePath(projectRoot, filePath, label) {
  const inputPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  const absolutePath = await realpath(inputPath);
  assertInside(projectRoot, absolutePath, label);
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function assertInside(parentPath, childPath, label) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${parentPath}.`);
  }
}

function assertNoSecrets(value, label, currentPath = "$") {
  if (typeof value === "string") {
    if (
      /(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/u.test(value) ||
      /AIza[0-9A-Za-z_-]{30,}/u.test(value) ||
      /AKIA[0-9A-Z]{16}/u.test(value) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
      /(?:bearer|api[_-]?key|authorization|access[_-]?token|password)\s*[:=]\s*\S{8,}/iu.test(value)
    ) {
      throw new Error(`${label} contains secret-like material at ${currentPath}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, label, `${currentPath}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
    if (
      key !== "apiKeyEnv" &&
      key !== "secretRecorded" &&
      key !== "secretSafety" &&
      /(?:^|_)(?:api_?key|authorization|access_?token|refresh_?token|password|secret|token)(?:_|$)/u.test(normalizedKey)
    ) {
      throw new Error(`${label} contains forbidden secret field ${currentPath}.${key}.`);
    }
    assertNoSecrets(item, label, `${currentPath}.${key}`);
  }
}

function validateArtifactReference(value) {
  const clean = cleanMetadata(value, "artifact URL");
  if (/^htmlslide-(?:signed-notarized-[1-9][0-9]*|unsigned-alpha-[1-9][0-9]*)-[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/u.test(clean)) {
    return clean;
  }

  let url;
  try {
    url = new URL(clean);
  } catch {
    throw new Error("Artifact URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Artifact URL must be HTTPS and must not contain credentials, query parameters, or fragments.");
  }
  return url.href;
}

function validateCliArtifactReference(value) {
  const clean = cleanMetadata(value, "artifact URL");
  if (/^https:\/\//u.test(clean)) {
    return validateArtifactReference(clean);
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(clean)) {
    throw new Error("Artifact URL or label contains unsafe characters.");
  }
  return clean;
}

function cleanMetadata(value, label) {
  const clean = requireString(value, label);
  assertNoSecrets(clean, label);
  if (clean.length > 2_048) {
    throw new Error(`${label} is too long.`);
  }
  return clean;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function isSafeEvidencePath(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC") &&
    !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeJsonAtomic(outputPath, value) {
  const outputInfo = await lstat(outputPath).catch(() => undefined);
  if (outputInfo?.isSymbolicLink() || (outputInfo && !outputInfo.isFile())) {
    throw new Error("Evidence output path must not be a symlink or non-file.");
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, outputPath);
}

function safeRunId(runId) {
  const safe = runId.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 96);
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : "run";
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertByteSorted(paths, label) {
  for (let index = 1; index < paths.length; index += 1) {
    if (Buffer.compare(Buffer.from(paths[index - 1], "utf8"), Buffer.from(paths[index], "utf8")) >= 0) {
      throw new Error(`${label} must be unique and byte-sorted.`);
    }
  }
}

function assertNoPathCollisions(paths, label) {
  const collisionKeys = paths.map((filePath) => filePath.normalize("NFC").toLowerCase());
  if (new Set(collisionKeys).size !== collisionKeys.length) {
    throw new Error(`${label} contains case-insensitive or Unicode-normalized path collisions.`);
  }
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
