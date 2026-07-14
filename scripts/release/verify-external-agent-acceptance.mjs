import { createHash } from "node:crypto";
import { basename } from "node:path";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const maxJsonBytes = 5 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{7,64}$/u;
const allowedProviders = new Map([
  ["claude-code", "claude auth status"],
  ["codex-cli", "codex login status"]
]);

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function main(args) {
  const options = parseArgs(args);
  const evidenceInputPath = path.resolve(options.evidence);
  const manifestPath = path.resolve(options.packageManifest);
  const input = await readJsonRegularFile(evidenceInputPath, "External agent evidence");
  const manifest = await readJsonRegularFile(manifestPath, "Package manifest");
  const evidence = await verifyExternalAgentAcceptance({
    artifactUrl: options.artifactUrl,
    commit: options.commit,
    evidence: input,
    evidencePath: evidenceInputPath,
    fixtureOnly: options.fixtureOnly === true,
    manifest,
    manifestPath
  });

  const outputPath = path.resolve(
    options.output ?? path.join("dist", "acceptance", `htmlslide-${evidence.provider.id}-rc-evidence.json`)
  );
  await writeJsonAtomic(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({ status: "passed", outputPath, runId: evidence.runs.successful.runId })}\n`);
  return { evidence, outputPath };
}

export function parseArgs(args) {
  const parsed = {};
  const allowed = new Set(["evidence", "packageManifest", "commit", "artifactUrl", "output"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--fixture-only") {
      parsed.fixtureOnly = true;
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

  for (const required of ["evidence", "packageManifest", "commit", "artifactUrl"]) {
    if (typeof parsed[required] !== "string" || parsed[required].trim().length === 0) {
      throw new Error(`Missing required --${required.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} value.`);
    }
  }
  return parsed;
}

export async function verifyExternalAgentAcceptance(options) {
  assertNoSecrets(options.evidence, "external agent evidence");
  const inputEvidence = normalizeExternalAgentEvidence(options.evidence);
  assertNoSecrets(inputEvidence, "normalized external agent evidence");
  validateInputEvidence(inputEvidence);

  const commit = String(options.commit).trim();
  if (!commitPattern.test(commit)) {
    throw new Error("Candidate commit must be a 7-64 character lowercase hexadecimal SHA.");
  }
  const artifactUrl = validateArtifactUrl(options.artifactUrl);
  const candidate = validatePackageManifest(options.manifest);

  const evidence = {
    schemaVersion: 1,
    kind: "htmlslide-external-agent-acceptance-evidence",
    status: "passed",
    generatedAt: new Date().toISOString(),
    ...(options.fixtureOnly ? { fixtureOnly: true, providerBoundary: "fixture-only" } : {}),
    provider: {
      id: inputEvidence.provider.id,
      version: inputEvidence.provider.version
    },
    candidate: {
      binding: "caller-declared",
      commit,
      artifactUrl,
      packageManifestSha256: await sha256File(options.manifestPath),
      ...candidate
    },
    authentication: {
      status: "passed",
      command: inputEvidence.authentication.command
    },
    permissionSummary: {
      sandbox: inputEvidence.permissionSummary.sandbox,
      permissionFlags: [...inputEvidence.permissionSummary.permissionFlags]
    },
    runs: {
      successful: {
        runId: inputEvidence.successfulRun.runId,
        status: "succeeded",
        changedFiles: [...inputEvidence.successfulRun.changedFiles].sort(byteCompare),
        check: "passed",
        export: "passed",
        diffReview: "passed",
        revert: "passed"
      },
      cancellation: {
        runId: inputEvidence.cancellationRun.runId,
        status: "cancelled",
        postCancelCheckExport: "not-started"
      }
    },
    checks: {
      evidenceSchema: "passed",
      candidateBinding: "passed",
      packageManifest: "passed",
      authenticatedProvider: "passed",
      permissionSummary: "passed",
      completedEdit: "passed",
      cancellation: "passed",
      diffReview: "passed",
      cliCheck: "passed",
      cliExport: "passed",
      reversibleRevert: "passed",
      secretSafety: "passed"
    },
    inputs: {
      evidenceSha256: await sha256File(options.evidencePath),
      packageManifestSha256: await sha256File(options.manifestPath)
    }
  };
  assertNoSecrets(evidence, "generated external agent evidence");
  return evidence;
}

function normalizeExternalAgentEvidence(value) {
  if (!isRecord(value) || value.kind !== "htmlslide-agent-run-report" || value.providerId !== "external-agent") {
    return value;
  }
  validateProductExternalAgentReport(value);
  return {
    schemaVersion: 1,
    kind: "htmlslide-external-agent-rc-evidence-input",
    status: "passed",
    provider: value.provider,
    authentication: value.authentication,
    permissionSummary: value.permissionSummary,
    successfulRun: value.acceptance.successfulRun,
    cancellationRun: value.acceptance.cancellationRun,
    secretSafety: value.secretSafety
  };
}

function validateProductExternalAgentReport(value) {
  const allowedKeys = new Set([
    "schemaVersion", "kind", "runId", "providerId", "generatedAt", "ok", "status", "stages", "outputs",
    "provider", "authentication", "permissionSummary", "acceptance", "checkpoint", "cli", "externalCli", "secretSafety"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Product external-agent report contains unsupported fields.");
    }
  }
  if (value.schemaVersion !== "0.1.0" || value.providerId !== "external-agent" ||
      (value.status !== "succeeded" && value.status !== "failed" && value.status !== "cancelled") ||
      typeof value.ok !== "boolean") {
    throw new Error("Product external-agent report does not match the desktop report contract.");
  }
  requireSafeRunId(value.runId, "product external-agent runId");
  requireSafeMetadataString(value.generatedAt, "product external-agent generatedAt", 128);
  if (!Array.isArray(value.stages) || value.stages.length !== 0 || !isRecord(value.outputs)) {
    throw new Error("Product external-agent report must omit agent output and live stage details.");
  }
  assertExactKeys(value.outputs, ["checks", "repairs"], "product external-agent report outputs");
  if (!Array.isArray(value.outputs.checks) || value.outputs.checks.length !== 0 ||
      !Array.isArray(value.outputs.repairs) || value.outputs.repairs.length !== 0) {
    throw new Error("Product external-agent report must not contain raw agent output.");
  }
  if (!isRecord(value.provider)) {
    throw new Error("Product external-agent report is missing provider metadata.");
  }
  assertExactKeys(value.provider, ["id", "version"], "product external-agent provider");
  const providerId = requireSafeMetadataString(value.provider.id, "product external-agent provider id", 64);
  if (!allowedProviders.has(providerId)) {
    throw new Error(`Unsupported real external agent provider: ${providerId}.`);
  }
  const providerVersion = requireSafeMetadataString(value.provider.version, "product external-agent provider version", 128);
  if (providerVersion.includes("/")) {
    throw new Error("Provider version must not contain paths.");
  }
  if (!isRecord(value.authentication)) {
    throw new Error("Product external-agent report is missing authentication metadata.");
  }
  assertExactKeys(value.authentication, ["status", "command"], "product external-agent authentication");
  if (value.authentication.status !== "passed" || value.authentication.command !== allowedProviders.get(providerId)) {
    throw new Error("Product external-agent authentication evidence does not match the selected provider.");
  }
  validateGeneratedPermissionSummary(value.permissionSummary);
  if (!isRecord(value.acceptance)) {
    throw new Error("Product external-agent report is missing acceptance metadata.");
  }
  assertAllowedOptionalKeys(value.acceptance, ["successfulRun", "cancellationRun"], "product external-agent acceptance");
  if (value.acceptance.successfulRun === undefined && value.acceptance.cancellationRun === undefined) {
    throw new Error("Product external-agent report must include a successful or cancelled run.");
  }
  if (value.checkpoint !== undefined) {
    if (!isRecord(value.checkpoint)) {
      throw new Error("Product external-agent checkpoint metadata is malformed.");
    }
    assertExactKeys(value.checkpoint, ["id", "strategy", "canRevert"], "product external-agent checkpoint");
    requireSafeMetadataString(value.checkpoint.id, "product external-agent checkpoint id", 128);
    requireSafeMetadataString(value.checkpoint.strategy, "product external-agent checkpoint strategy", 64);
    if (typeof value.checkpoint.canRevert !== "boolean") {
      throw new Error("Product external-agent checkpoint revert metadata is invalid.");
    }
  }
  if (!isRecord(value.cli)) {
    throw new Error("Product external-agent report is missing CLI metadata.");
  }
  assertExactKeys(value.cli, [], "product external-agent CLI metadata");
  if (!isRecord(value.externalCli)) {
    throw new Error("Product external-agent report is missing Check/Export metadata.");
  }
  assertExactKeys(value.externalCli, ["check", "export"], "product external-agent Check/Export metadata");
  for (const key of ["check", "export"]) {
    if (!["passed", "available", "failed", "not-started", "not-available"].includes(value.externalCli[key])) {
      throw new Error(`Product external-agent ${key} status is invalid.`);
    }
  }
  if (value.secretSafety !== "passed") {
    throw new Error("Product external-agent report must record secretSafety as passed.");
  }
}

function assertAllowedOptionalKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

export function validateExternalAgentAcceptanceEvidence(value, options = {}) {
  assertNoSecrets(value, "external agent acceptance evidence");
  if (!isRecord(value)) {
    throw new Error("External agent acceptance evidence must be a JSON object.");
  }
  if (value.fixtureOnly === true || value.providerBoundary === "fixture-only") {
    throw new Error("Fixture-only external-agent evidence cannot be used for release promotion.");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "status", "generatedAt", "provider", "candidate", "authentication", "permissionSummary", "runs", "checks", "inputs"],
    "external agent acceptance evidence"
  );
  if (value.schemaVersion !== 1 || value.kind !== "htmlslide-external-agent-acceptance-evidence" || value.status !== "passed") {
    throw new Error("External-agent acceptance evidence does not match the generated evidence contract.");
  }
  requireSafeMetadataString(value.generatedAt, "generatedAt", 128);

  if (!isRecord(value.provider)) {
    throw new Error("External-agent acceptance evidence is missing provider metadata.");
  }
  assertExactKeys(value.provider, ["id", "version"], "external-agent provider metadata");
  const providerId = requireSafeMetadataString(value.provider.id, "provider id", 64);
  if (!allowedProviders.has(providerId)) {
    throw new Error(`Unsupported real external agent provider: ${providerId}.`);
  }
  requireSafeMetadataString(value.provider.version, "provider version", 128);

  if (!isRecord(value.candidate)) {
    throw new Error("External-agent acceptance evidence is missing candidate metadata.");
  }
  assertExactKeys(
    value.candidate,
    ["binding", "commit", "artifactUrl", "packageManifestSha256", "channel", "version", "arch", "signing", "notarized", "stapled"],
    "external-agent candidate metadata"
  );
  if (value.candidate.binding !== "caller-declared") {
    throw new Error("External-agent evidence must use caller-declared candidate binding metadata.");
  }
  const candidateCommit = validateCandidateCommit(value.candidate.commit);
  const candidateArtifactUrl = validateArtifactUrl(value.candidate.artifactUrl);
  if (options.expectedCommit !== undefined && candidateCommit !== options.expectedCommit) {
    throw new Error("External-agent evidence claimed commit does not match the candidate commit.");
  }
  if (options.expectedArtifactUrl !== undefined && candidateArtifactUrl !== options.expectedArtifactUrl) {
    throw new Error("External-agent evidence claimed artifact does not match the candidate artifact reference.");
  }
  if (!sha256Pattern.test(String(value.candidate.packageManifestSha256))) {
    throw new Error("External-agent evidence package manifest SHA-256 is invalid.");
  }
  if (options.expectedPackageManifestSha256 !== undefined && value.candidate.packageManifestSha256 !== options.expectedPackageManifestSha256) {
    throw new Error("External-agent evidence package manifest SHA-256 does not match the candidate manifest.");
  }
  validateGeneratedPackageMetadata(value.candidate);
  const expectedPackageMetadata = options.expectedPackageMetadata;
  if (expectedPackageMetadata !== undefined) {
    for (const field of ["version", "arch", "channel", "signing", "notarized", "stapled"]) {
      if (expectedPackageMetadata[field] !== undefined && value.candidate[field] !== expectedPackageMetadata[field]) {
        throw new Error(`External-agent evidence candidate ${field} does not match the verified package manifest.`);
      }
    }
  }

  if (!isRecord(value.authentication)) {
    throw new Error("External-agent acceptance evidence is missing authentication metadata.");
  }
  assertExactKeys(value.authentication, ["status", "command"], "external-agent authentication metadata");
  if (value.authentication.status !== "passed" || value.authentication.command !== allowedProviders.get(providerId)) {
    throw new Error("External-agent authentication evidence does not match the selected provider.");
  }

  validateGeneratedPermissionSummary(value.permissionSummary);
  validateGeneratedRuns(value.runs);
  validateGeneratedChecks(value.checks);

  if (!isRecord(value.inputs)) {
    throw new Error("External-agent acceptance evidence is missing input digests.");
  }
  assertExactKeys(value.inputs, ["evidenceSha256", "packageManifestSha256"], "external-agent evidence inputs");
  if (!sha256Pattern.test(String(value.inputs.evidenceSha256)) || !sha256Pattern.test(String(value.inputs.packageManifestSha256))) {
    throw new Error("External-agent evidence input SHA-256 values are invalid.");
  }
  if (value.inputs.packageManifestSha256 !== value.candidate.packageManifestSha256) {
    throw new Error("External-agent evidence input and candidate manifest SHA-256 values do not match.");
  }

  return {
    provider: value.provider,
    candidate: value.candidate,
    runs: value.runs,
    checks: value.checks
  };
}

function validateInputEvidence(value) {
  if (!isRecord(value)) {
    throw new Error("External agent evidence must be a JSON object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "status",
      "provider",
      "authentication",
      "permissionSummary",
      "successfulRun",
      "cancellationRun",
      "secretSafety"
    ],
    "external agent evidence"
  );
  if (value.schemaVersion !== 1 || value.kind !== "htmlslide-external-agent-rc-evidence-input" || value.status !== "passed") {
    throw new Error("External agent evidence must use schemaVersion 1, the RC input kind, and passed status.");
  }
  if (value.secretSafety !== "passed") {
    throw new Error("External agent evidence must record secretSafety as passed.");
  }

  if (!isRecord(value.provider)) {
    throw new Error("External agent evidence is missing provider metadata.");
  }
  assertExactKeys(value.provider, ["id", "version"], "provider metadata");
  const providerId = requireSafeMetadataString(value.provider.id, "provider id", 64);
  if (!allowedProviders.has(providerId)) {
    throw new Error(`Unsupported real external agent provider: ${providerId}.`);
  }
  const providerVersion = requireSafeMetadataString(value.provider.version, "provider version", 128);
  if (providerVersion.includes("/")) {
    throw new Error("Provider version must not contain paths.");
  }

  if (!isRecord(value.authentication)) {
    throw new Error("External agent evidence is missing authentication metadata.");
  }
  assertExactKeys(value.authentication, ["status", "command"], "authentication metadata");
  if (value.authentication.status !== "passed" || value.authentication.command !== allowedProviders.get(providerId)) {
    throw new Error("Authentication evidence does not match the selected provider's status command.");
  }

  if (!isRecord(value.permissionSummary)) {
    throw new Error("External agent evidence is missing permission summary.");
  }
  assertExactKeys(value.permissionSummary, ["sandbox", "permissionFlags"], "permission summary");
  requireSafeMetadataString(value.permissionSummary.sandbox, "sandbox mode", 128);
  if (!Array.isArray(value.permissionSummary.permissionFlags) || value.permissionSummary.permissionFlags.length === 0) {
    throw new Error("Permission summary must include at least one sanitized permission flag.");
  }
  value.permissionSummary.permissionFlags.forEach((flag, index) => {
    requireSafeMetadataString(flag, `permission flag ${index + 1}`, 256);
  });

  validateSuccessfulRun(value.successfulRun);
  validateCancellationRun(value.cancellationRun, value.successfulRun.runId);
}

function validateSuccessfulRun(value) {
  if (!isRecord(value)) {
    throw new Error("External agent evidence is missing the successful run.");
  }
  assertExactKeys(
    value,
    ["runId", "status", "edit", "changedFiles", "check", "export", "diffReview", "revert"],
    "successful external agent run"
  );
  requireSafeRunId(value.runId, "successful runId");
  if (value.status !== "succeeded" || value.edit !== "passed" || value.check !== "passed" || value.export !== "passed" ||
      value.diffReview !== "passed" || value.revert !== "passed") {
    throw new Error("Successful external agent run must prove edit, Check, Export, diff review, and revert passed.");
  }
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length === 0 || value.changedFiles.length > 128) {
    throw new Error("Successful external agent run must list one to 128 changed source files.");
  }
  const changedFiles = value.changedFiles.map((file, index) => validateSourcePath(file, `changed file ${index + 1}`));
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new Error("Successful external agent changedFiles must be unique.");
  }
}

function validateCancellationRun(value, successfulRunId) {
  if (!isRecord(value)) {
    throw new Error("External agent evidence is missing the cancellation run.");
  }
  assertExactKeys(value, ["runId", "status", "postCancelCheckExport"], "cancelled external agent run");
  requireSafeRunId(value.runId, "cancellation runId");
  if (value.runId === successfulRunId || value.status !== "cancelled" || value.postCancelCheckExport !== "not-started") {
    throw new Error("Cancellation evidence must use a distinct cancelled run with no post-cancel Check or Export.");
  }
}

function validatePackageManifest(value) {
  if (!isRecord(value)) {
    throw new Error("Package manifest must be a JSON object.");
  }
  assertNoSecrets(value, "package manifest");
  if (value.appName !== "HTMLslide" || (value.channel !== "alpha" && value.channel !== "release")) {
    throw new Error("Package manifest must declare appName HTMLslide and an alpha or release channel.");
  }
  const version = requireSafeMetadataString(value.version, "package version", 64);
  const arch = requireSafeMetadataString(value.arch, "package architecture", 32);
  const signing = requireSafeMetadataString(value.signing, "package signing", 32);
  if (value.channel === "alpha" && (signing !== "ad-hoc" || value.notarized !== false)) {
    throw new Error("Alpha package manifest must describe an ad-hoc, non-notarized artifact.");
  }
  if (value.channel === "release" && (signing !== "developer-id" || value.notarized !== true || value.stapled !== true)) {
    throw new Error("Release package manifest must describe a signed, notarized, stapled artifact.");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || !value.artifacts.some((artifact) => String(artifact).endsWith(".dmg"))) {
    throw new Error("Package manifest must list a DMG artifact.");
  }
  if (!Array.isArray(value.artifactMetadata) || value.artifactMetadata.length !== value.artifacts.length) {
    throw new Error("Package manifest artifact metadata must cover every artifact.");
  }

  const artifactNames = new Set(value.artifacts.map((artifact, index) => {
    if (typeof artifact !== "string" || artifact.length === 0) {
      throw new Error(`Package artifact ${index + 1} must be a non-empty path string.`);
    }
    return basename(artifact);
  }));
  const metadataNames = new Set(value.artifactMetadata.map((metadata, index) => {
    if (!isRecord(metadata)) {
      throw new Error(`Package artifact metadata ${index + 1} must be an object.`);
    }
    const fileName = requireSafeMetadataString(metadata.fileName, `artifact metadata ${index + 1} fileName`, 256);
    if (!Number.isInteger(metadata.sizeBytes) || metadata.sizeBytes < 0 || !sha256Pattern.test(String(metadata.sha256))) {
      throw new Error(`Package artifact metadata ${fileName} has invalid size or SHA-256.`);
    }
    if (fileName !== basename(String(metadata.path))) {
      throw new Error(`Package artifact metadata ${fileName} path does not match its filename.`);
    }
    return fileName;
  }));
  if (JSON.stringify([...artifactNames].sort()) !== JSON.stringify([...metadataNames].sort())) {
    throw new Error("Package artifact metadata filenames do not match the manifest artifacts.");
  }

  return {
    channel: value.channel,
    version,
    arch,
    signing,
    notarized: value.notarized === true,
    stapled: value.stapled === true
  };
}

function validateSourcePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\\") || value.startsWith("/") ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a project-relative POSIX path.`);
  }
  const root = value.split("/", 1)[0];
  if (!["deck.json", "slides", "notes", "theme", "assets"].includes(root) && value !== "deck.json") {
    throw new Error(`${label} must stay inside deck.json, slides/, notes/, theme/, or assets/.`);
  }
  return value;
}

function validateArtifactUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("Candidate artifact reference must be a short http(s) URL or safe asset name.");
  }
  if (/^https?:\/\//u.test(value)) {
    return value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) {
    throw new Error("Candidate artifact reference must be an http(s) URL or safe asset name.");
  }
  return value;
}

function validateCandidateCommit(value) {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new Error("External-agent evidence candidate commit must be a 7-64 character lowercase hexadecimal SHA.");
  }
  return value;
}

function validateGeneratedPackageMetadata(candidate) {
  if (candidate.channel !== "alpha" && candidate.channel !== "release") {
    throw new Error("External-agent evidence candidate channel is unsupported.");
  }
  requireSafeMetadataString(candidate.version, "candidate package version", 64);
  requireSafeMetadataString(candidate.arch, "candidate package architecture", 32);
  requireSafeMetadataString(candidate.signing, "candidate package signing", 32);
  if (typeof candidate.notarized !== "boolean" || typeof candidate.stapled !== "boolean") {
    throw new Error("External-agent evidence candidate notarization metadata is invalid.");
  }
  if (candidate.channel === "alpha" && (candidate.signing !== "ad-hoc" || candidate.notarized || candidate.stapled)) {
    throw new Error("Alpha external-agent evidence must describe an ad-hoc, non-notarized package.");
  }
  if (candidate.channel === "release" && (candidate.signing !== "developer-id" || !candidate.notarized || !candidate.stapled)) {
    throw new Error("Release external-agent evidence must describe a signed, notarized, stapled package.");
  }
}

function validateGeneratedPermissionSummary(value) {
  if (!isRecord(value)) {
    throw new Error("External-agent acceptance evidence is missing permission summary.");
  }
  assertExactKeys(value, ["sandbox", "permissionFlags"], "external-agent permission summary");
  requireSafeMetadataString(value.sandbox, "sandbox mode", 128);
  if (!Array.isArray(value.permissionFlags) || value.permissionFlags.length === 0) {
    throw new Error("External-agent permission summary must include at least one permission flag.");
  }
  value.permissionFlags.forEach((flag, index) => requireSafeMetadataString(flag, `permission flag ${index + 1}`, 256));
}

function validateGeneratedRuns(value) {
  if (!isRecord(value)) {
    throw new Error("External-agent acceptance evidence is missing run metadata.");
  }
  assertExactKeys(value, ["successful", "cancellation"], "external-agent runs");
  if (!isRecord(value.successful) || !isRecord(value.cancellation)) {
    throw new Error("External-agent run metadata is malformed.");
  }
  assertExactKeys(value.successful, ["runId", "status", "changedFiles", "check", "export", "diffReview", "revert"], "successful external-agent run");
  assertExactKeys(value.cancellation, ["runId", "status", "postCancelCheckExport"], "cancelled external-agent run");
  requireSafeRunId(value.successful.runId, "successful runId");
  requireSafeRunId(value.cancellation.runId, "cancellation runId");
  if (value.successful.status !== "succeeded" || value.successful.check !== "passed" || value.successful.export !== "passed" ||
      value.successful.diffReview !== "passed" || value.successful.revert !== "passed") {
    throw new Error("Successful external-agent evidence must prove Check, Export, diff review, and revert.");
  }
  if (!Array.isArray(value.successful.changedFiles) || value.successful.changedFiles.length === 0) {
    throw new Error("Successful external-agent evidence must include changed source files.");
  }
  value.successful.changedFiles.forEach((file, index) => validateSourcePath(file, `changed file ${index + 1}`));
  if (value.cancellation.runId === value.successful.runId || value.cancellation.status !== "cancelled" || value.cancellation.postCancelCheckExport !== "not-started") {
    throw new Error("External-agent cancellation evidence must use a distinct cancelled run with no post-cancel Check or Export.");
  }
}

function validateGeneratedChecks(value) {
  if (!isRecord(value)) {
    throw new Error("External-agent acceptance evidence is missing check metadata.");
  }
  const expectedChecks = [
    "evidenceSchema", "candidateBinding", "packageManifest", "authenticatedProvider", "permissionSummary", "completedEdit",
    "cancellation", "diffReview", "cliCheck", "cliExport", "reversibleRevert", "secretSafety"
  ];
  assertExactKeys(value, expectedChecks, "external-agent checks");
  for (const check of expectedChecks) {
    if (value[check] !== "passed") {
      throw new Error(`External-agent acceptance check did not pass: ${check}.`);
    }
  }
}

function requireSafeRunId(value, label) {
  const runId = requireSafeMetadataString(value, label, 128);
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return runId;
}

function requireSafeMetadataString(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error(`${label} must be a short sanitized string.`);
  }
  return value;
}

async function readJsonRegularFile(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if (info.size > maxJsonBytes) {
    throw new Error(`${label} exceeds the ${maxJsonBytes} byte limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function assertNoSecrets(value, label, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, label, [...pathParts, String(index)]));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|authorization|private[-_]?key|credential)/iu.test(key)) {
        throw new Error(`${label} contains a forbidden secret field.`);
      }
      assertNoSecrets(entry, label, [...pathParts, key]);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  if (
    /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [^-]+ PRIVATE KEY-----)/iu.test(value)
  ) {
    throw new Error(`${label} contains secret-like material.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported or missing fields.`);
  }
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
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, outputPath);
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
