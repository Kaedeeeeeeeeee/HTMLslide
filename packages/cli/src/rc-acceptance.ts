import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "@htmlslide/agent";
import { ExportManifestSchema } from "@htmlslide/core";
import {
  exportLoadedProject,
  loadProject,
  runAgentTask,
  validateAgentProviderCredentials,
  type AgentProviderKind,
  type AgentRunCliResult,
  type LoadedProject
} from "./index.js";

const RC_EVIDENCE_SCHEMA_VERSION = 1 as const;
const ACCEPTED_SLIDE_COUNT_MIN = 8;
const ACCEPTED_SLIDE_COUNT_MAX = 12;

export type RcByokAcceptanceOptions = {
  projectPath: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
  task: string;
  baseUrl?: string;
  targetSlideCount?: number;
  speakerNotesMode?: string;
  commit?: string;
  artifactUrl?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
};

type FileEvidence = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

type ArtifactEvidence = FileEvidence & {
  kind: string;
  slideId?: string;
};

export type RcByokAcceptanceResult = {
  schemaVersion: typeof RC_EVIDENCE_SCHEMA_VERSION;
  kind: "htmlslide-rc-byok-acceptance";
  status: "passed";
  command: "rc byok";
  generatedAt: string;
  runId: string;
  projectPath: ".";
  evidenceDir: string;
  evidencePath: string;
  providerValidationPath: string;
  provider: AgentProviderKind;
  model: string;
  targetSlideCount: number;
  slideCount: number;
  candidate: {
    binding: "caller-declared";
    commit?: string;
    artifactUrl?: string;
  };
  checks: {
    providerValidation: "passed";
    agentRun: "passed";
    checkpoint: "passed";
    cliCheck: "passed";
    cliExport: "passed";
    exportArtifacts: "passed";
    secretSafety: "passed";
  };
  inputs: {
    providerValidation: FileEvidence;
    agentReport: FileEvidence;
    exportManifest: FileEvidence;
  };
  artifacts: ArtifactEvidence[];
};

type ProviderValidationEvidence = {
  schemaVersion: typeof RC_EVIDENCE_SCHEMA_VERSION;
  kind: "htmlslide-provider-validation";
  status: "passed";
  command: "agent validate-provider";
  provider: AgentProviderKind;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  credential: {
    ok: true;
    providerId?: string;
  };
  secretRecorded: false;
  exitCode: 0;
};

export async function runRcByokAcceptance(
  options: RcByokAcceptanceOptions
): Promise<RcByokAcceptanceResult> {
  const projectRoot = await resolveProjectRoot(options.projectPath);
  const targetSlideCount = normalizeTargetSlideCount(options.targetSlideCount);
  const env = options.env ?? process.env;
  const providerValidation = await validateAgentProviderCredentials({
    apiKeyEnv: options.apiKeyEnv,
    baseUrl: options.baseUrl,
    env,
    fetch: options.fetch,
    model: options.model,
    provider: options.provider
  });
  if (providerValidation.status !== "passed" || !providerValidation.credential.ok) {
    throw acceptanceError(
      "RC_PROVIDER_VALIDATION_FAILED",
      "The provider validation did not pass; no RC acceptance run was started.",
      "Resolve the provider key, model, or endpoint and rerun htmlslide rc byok."
    );
  }

  const run = await runAgentTask({
    apiKeyEnv: options.apiKeyEnv,
    baseUrl: options.baseUrl,
    engine: "htmlslide-byok",
    env,
    exportProject: (project: LoadedProject) => exportLoadedProject(project, {
      deckpkg: true,
      pdf: true,
      thumbnails: true
    }),
    fetch: options.fetch,
    model: options.model,
    projectPath: projectRoot,
    provider: options.provider,
    speakerNotesMode: options.speakerNotesMode,
    targetSlideCount,
    task: options.task
  });

  const project = await loadProject(projectRoot);
  assertSuccessfulRun(run, project.manifest.slides.length, targetSlideCount);
  const evidence = await buildEvidence({
    project,
    providerValidation,
    run,
    targetSlideCount,
    commit: options.commit,
    artifactUrl: options.artifactUrl,
    secretValue: env[options.apiKeyEnv]
  });
  return evidence;
}

async function buildEvidence({
  project,
  providerValidation,
  run,
  targetSlideCount,
  commit,
  artifactUrl,
  secretValue
}: {
  project: LoadedProject;
  providerValidation: Awaited<ReturnType<typeof validateAgentProviderCredentials>>;
  run: AgentRunCliResult;
  targetSlideCount: number;
  commit?: string;
  artifactUrl?: string;
  secretValue?: string;
}): Promise<RcByokAcceptanceResult> {
  const projectRoot = project.projectPath;
  const runId = requireRunId(run);
  const safeRunIdValue = safeRunId(runId);
  const reportsRoot = await ensureReportsRoot(projectRoot);
  const evidenceDirAbsolute = path.join(reportsRoot, `rc-evidence-${safeRunIdValue}`);
  await ensurePrivateDirectory(evidenceDirAbsolute);

  const providerValidationPayload: ProviderValidationEvidence = {
    schemaVersion: RC_EVIDENCE_SCHEMA_VERSION,
    kind: "htmlslide-provider-validation",
    status: "passed",
    command: "agent validate-provider",
    provider: providerValidation.provider,
    model: providerValidation.model,
    apiKeyEnv: providerValidation.apiKeyEnv,
    ...(providerValidation.baseUrl ? { baseUrl: providerValidation.baseUrl } : {}),
    credential: {
      ok: true,
      ...(providerValidation.credential.providerId
        ? { providerId: providerValidation.credential.providerId }
        : {})
    },
    secretRecorded: false,
    exitCode: 0
  };
  assertNoSecretValue(providerValidationPayload, "Provider validation evidence", secretValue ? [secretValue] : []);
  const providerValidationPathAbsolute = path.join(evidenceDirAbsolute, "provider-validation.json");
  await writeJsonAtomic(providerValidationPathAbsolute, providerValidationPayload);

  const exportManifestPath = await resolveProjectFile(
    projectRoot,
    "exports/export-manifest.json",
    "Export manifest"
  );
  const exportManifestBytes = await readFile(exportManifestPath);
  const exportManifest = ExportManifestSchema.parse(JSON.parse(exportManifestBytes.toString("utf8")));
  const exportManifestFingerprint = fingerprintBytes(exportManifestBytes);
  if (
    !run.exportManifest ||
    run.exportManifest.sourceDigest !== exportManifest.sourceDigest ||
    run.exportManifest.artifactCount !== exportManifest.artifacts.length ||
    run.exportManifest.sha256 !== exportManifestFingerprint.sha256
  ) {
    throw acceptanceError(
      "RC_EXPORT_MANIFEST_MISMATCH",
      "The agent run report is not bound to the current export manifest.",
      "Rerun the acceptance command so Check and Export are produced in the same run."
    );
  }

  await verifyProjectSources(projectRoot, exportManifest);
  const artifacts = await readAndVerifyArtifacts(projectRoot, exportManifest);
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const requiredKind of ["pdf", "deckpkg", "thumbnail"]) {
    if (!artifactKinds.has(requiredKind)) {
      throw acceptanceError(
        "RC_REQUIRED_EXPORT_MISSING",
        `The RC export is missing a required ${requiredKind} artifact.`,
        "Rerun htmlslide rc byok; the command must produce PDF, deckpkg, and thumbnail artifacts."
      );
    }
  }

  const exportedPaths = new Set(collectExportPaths(run));
  for (const artifact of artifacts) {
    if (!exportedPaths.has(artifact.path)) {
      throw acceptanceError(
        "RC_AGENT_EXPORT_MISMATCH",
        `The agent run did not report exported artifact ${artifact.path}.`,
        "Rerun the acceptance command with the shared CLI/compiler path."
      );
    }
  }

  const reportPath = await resolveProjectFile(projectRoot, run.reportPath ?? "", "Agent report");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
  const reportProjectPath = typeof report.projectPath === "string" ? await realpath(report.projectPath).catch(() => "") : "";
  const reportProvider = isRecord(report.provider) ? report.provider : undefined;
  const reportOutputs = isRecord(report.outputs) ? report.outputs : undefined;
  const reportOutline = reportOutputs && isRecord(reportOutputs.outline) ? reportOutputs.outline : undefined;
  const reportCli = isRecord(report.cli) ? report.cli : undefined;
  const reportCheck = reportCli && isRecord(reportCli.check) ? reportCli.check : undefined;
  const reportExport = reportCli && isRecord(reportCli.export) ? reportCli.export : undefined;
  const reportCheckpoint = isRecord(report.checkpoint) ? report.checkpoint : undefined;
  if (
    report.schemaVersion !== "0.1.0" ||
    report.kind !== "htmlslide-agent-run-report" ||
    report.providerId !== "htmlslide-byok" ||
    report.runId !== runId ||
    reportProjectPath !== projectRoot ||
    report.ok !== true ||
    report.status !== "succeeded" ||
    reportProvider?.provider !== providerValidation.provider ||
    reportProvider?.model !== providerValidation.model ||
    report.targetSlideCount !== targetSlideCount ||
    !Array.isArray(reportOutline?.slides) ||
    reportOutline.slides.length !== targetSlideCount ||
    reportCheckpoint?.strategy !== "file-copy" ||
    reportCheckpoint?.canRevert !== true ||
    reportCheck?.ok !== true ||
    reportCheck?.exitCode !== 0 ||
    reportCheck?.status !== "passed" ||
    reportExport?.ok !== true ||
    reportExport?.exitCode !== 0 ||
    reportExport?.status !== "passed" ||
    !Array.isArray(reportExport.artifactPaths) ||
    reportExport.artifactPaths.length === 0
  ) {
    throw acceptanceError(
      "RC_AGENT_REPORT_INVALID",
      "The generated agent report is not a successful report for this run.",
      "Rerun htmlslide rc byok and keep the project-local report intact until evidence is written."
    );
  }

  const candidate = {
    binding: "caller-declared" as const,
    ...(commit === undefined ? {} : { commit: normalizeCommit(commit) }),
    ...(artifactUrl === undefined ? {} : { artifactUrl: normalizeArtifactLabel(artifactUrl) })
  };
  const evidencePathAbsolute = path.join(evidenceDirAbsolute, "evidence.json");
  const result: RcByokAcceptanceResult = {
    schemaVersion: RC_EVIDENCE_SCHEMA_VERSION,
    kind: "htmlslide-rc-byok-acceptance",
    status: "passed",
    command: "rc byok",
    generatedAt: new Date().toISOString(),
    runId,
    projectPath: ".",
    evidenceDir: relativeProjectPath(projectRoot, evidenceDirAbsolute),
    evidencePath: relativeProjectPath(projectRoot, evidencePathAbsolute),
    providerValidationPath: relativeProjectPath(projectRoot, providerValidationPathAbsolute),
    provider: providerValidation.provider,
    model: providerValidation.model,
    targetSlideCount,
    slideCount: project.manifest.slides.length,
    candidate,
    checks: {
      providerValidation: "passed",
      agentRun: "passed",
      checkpoint: "passed",
      cliCheck: "passed",
      cliExport: "passed",
      exportArtifacts: "passed",
      secretSafety: "passed"
    },
    inputs: {
      providerValidation: await fileEvidence(projectRoot, providerValidationPathAbsolute),
      agentReport: await fileEvidence(projectRoot, reportPath),
      exportManifest: {
        ...exportManifestFingerprint,
        path: relativeProjectPath(projectRoot, exportManifestPath)
      }
    },
    artifacts
  };
  assertNoSecretValue(result, "RC acceptance evidence", secretValue ? [secretValue] : []);
  await writeJsonAtomic(evidencePathAbsolute, result);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSuccessfulRun(run: AgentRunCliResult, slideCount: number, targetSlideCount: number): void {
  if (!run.ok) {
    throw acceptanceError(
      "RC_AGENT_RUN_FAILED",
      `The provider-backed agent run failed at ${run.error.stage}: ${run.error.message}`,
      "Resolve the reported provider or deck issue and rerun htmlslide rc byok."
    );
  }
  if (slideCount !== targetSlideCount) {
    throw acceptanceError(
      "RC_SLIDE_COUNT_MISMATCH",
      `The generated deck has ${slideCount} slides; the requested target was ${targetSlideCount}.`,
      "Rerun with a task that produces the exact requested slide count."
    );
  }
  if (!run.check || run.check.status !== "passed" || run.check.summary.errors !== 0) {
    throw acceptanceError(
      "RC_CHECK_FAILED",
      "The authoritative CLI Check did not pass with zero errors.",
      "Fix the reported deck issues and rerun htmlslide rc byok."
    );
  }
  if (!run.exportManifest || !run.export || collectExportPaths(run).length === 0) {
    throw acceptanceError(
      "RC_EXPORT_FAILED",
      "The provider-backed run did not produce a verifiable export manifest and artifacts.",
      "Ensure the packaged Chromium runtime is available, then rerun htmlslide rc byok."
    );
  }
  if (!run.checkpoint || run.checkpoint.strategy !== "file-copy" || !run.checkpoint.restore.canRevert) {
    throw acceptanceError(
      "RC_CHECKPOINT_INVALID",
      "The provider-backed run did not produce a reversible file-copy checkpoint.",
      "Rerun the command from a writable local deck project."
    );
  }
}

async function readAndVerifyArtifacts(projectRoot: string, manifest: ReturnType<typeof ExportManifestSchema.parse>): Promise<ArtifactEvidence[]> {
  const artifacts: ArtifactEvidence[] = [];
  for (const artifact of manifest.artifacts) {
    const artifactPath = await resolveProjectFile(projectRoot, artifact.path, `Export artifact ${artifact.path}`);
    const metadata = await fileEvidence(projectRoot, artifactPath);
    if (metadata.sizeBytes !== artifact.sizeBytes || metadata.sha256 !== artifact.sha256) {
      throw acceptanceError(
        "RC_ARTIFACT_FINGERPRINT_MISMATCH",
        `Export artifact fingerprint mismatch: ${artifact.path}.`,
        "Rerun htmlslide export through the shared compiler before generating RC evidence."
      );
    }
    artifacts.push({
      ...metadata,
      kind: artifact.kind,
      ...(artifact.slideId ? { slideId: artifact.slideId } : {})
    });
  }
  return artifacts;
}

async function verifyProjectSources(
  projectRoot: string,
  manifest: ReturnType<typeof ExportManifestSchema.parse>
): Promise<void> {
  for (const source of manifest.sources) {
    const sourcePath = await resolveProjectFile(projectRoot, source.path, `Project source ${source.path}`);
    const bytes = await readFile(sourcePath);
    const fingerprint = fingerprintBytes(bytes);
    if (fingerprint.sizeBytes !== source.sizeBytes || fingerprint.sha256 !== source.sha256) {
      throw acceptanceError(
        "RC_SOURCE_FINGERPRINT_MISMATCH",
        `Project source fingerprint mismatch: ${source.path}.`,
        "Rerun the shared Check and Export path before generating RC evidence."
      );
    }
    if (source.sizeBytes > 64 * 1024 * 1024) {
      throw acceptanceError(
        "RC_SOURCE_TOO_LARGE",
        `Project source is too large for the acceptance secret scan: ${source.path}.`,
        "Remove the oversized source from the acceptance run or validate it separately."
      );
    }
    const text = bytes.toString();
    if (
      /(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/u.test(text) ||
      /AIza[0-9A-Za-z_-]{30,}/u.test(text) ||
      /AKIA[0-9A-Z]{16}/u.test(text) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text) ||
      /(?:bearer|api[_-]?key|authorization|access[_-]?token|password)\s*[:=]\s*\S{8,}/iu.test(text)
    ) {
      throw acceptanceError(
        "RC_SECRET_SAFETY_FAILED",
        `Project source contains common secret-like material: ${source.path}.`,
        "Remove secret material from the deck source and rerun the acceptance command."
      );
    }
  }
}

function collectExportPaths(run: AgentRunCliResult): string[] {
  if (!run.export) {
    return [];
  }
  const paths: string[] = [];
  for (const value of Object.values(run.export.artifacts)) {
    if (typeof value === "string") {
      paths.push(relativeProjectPath(run.projectPath ?? "", path.resolve(run.projectPath ?? "", value)));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          paths.push(relativeProjectPath(run.projectPath ?? "", path.resolve(run.projectPath ?? "", item)));
        }
      }
    }
  }
  return paths;
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
    throw acceptanceError("RC_PROJECT_REQUIRED", "A deck project path is required.", "Pass --project <deck-path>.");
  }
  const inputPath = path.resolve(projectPath);
  const entry = await lstat(inputPath).catch(() => undefined);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw acceptanceError(
      "RC_PROJECT_INVALID",
      "The RC acceptance project must be a real directory, not a symlink.",
      "Pass a local deck project directory containing deck.json."
    );
  }
  return realpath(inputPath);
}

async function ensureReportsRoot(projectRoot: string): Promise<string> {
  const htmlslideRoot = path.join(projectRoot, ".htmlslide");
  const reportsRoot = path.join(htmlslideRoot, "reports");
  await ensurePrivateDirectory(htmlslideRoot);
  await ensurePrivateDirectory(reportsRoot);
  return reportsRoot;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw acceptanceError(
      "RC_EVIDENCE_DIRECTORY_INVALID",
      `RC evidence directory is not a regular directory: ${directory}.`,
      "Remove the conflicting symlink or file and rerun the acceptance command."
    );
  }
  await chmod(directory, 0o700);
}

async function resolveProjectFile(projectRoot: string, relativeOrAbsolutePath: string, label: string): Promise<string> {
  if (typeof relativeOrAbsolutePath !== "string" || relativeOrAbsolutePath.trim().length === 0) {
    throw acceptanceError("RC_FILE_MISSING", `${label} path is missing.`, "Rerun the acceptance command from a complete deck project.");
  }
  const normalized = relativeOrAbsolutePath.replaceAll("\\", "/");
  const candidate = path.isAbsolute(relativeOrAbsolutePath)
    ? path.resolve(relativeOrAbsolutePath)
    : path.resolve(projectRoot, normalized);
  const relative = path.relative(projectRoot, candidate).split(path.sep).join("/");
  if (relative.length === 0 || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw acceptanceError("RC_PATH_ESCAPE", `${label} escapes the project boundary.`, "Use only project-local files for RC evidence.");
  }
  const entry = await lstat(candidate).catch(() => undefined);
  if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
    throw acceptanceError("RC_FILE_INVALID", `${label} must be a regular, non-symlink file.`, "Rerun the shared Check and Export path.");
  }
  const resolved = await realpath(candidate);
  if (relativeProjectPath(projectRoot, resolved) !== relative) {
    throw acceptanceError("RC_PATH_ESCAPE", `${label} resolves through a symlink.`, "Remove symlinked project artifacts and rerun.");
  }
  return resolved;
}

async function fileEvidence(projectRoot: string, filePath: string): Promise<FileEvidence> {
  const resolved = await resolveProjectFile(projectRoot, filePath, "Evidence input");
  const bytes = await readFile(resolved);
  const info = await stat(resolved);
  const fingerprint = fingerprintBytes(bytes);
  if (info.size !== fingerprint.sizeBytes) {
    throw acceptanceError("RC_FILE_CHANGED", `Evidence input changed while it was read: ${filePath}.`, "Rerun the acceptance command.");
  }
  return {
    path: relativeProjectPath(projectRoot, resolved),
    ...fingerprint
  };
}

function fingerprintBytes(bytes: Uint8Array): Omit<FileEvidence, "path"> {
  return {
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function relativeProjectPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath)).split(path.sep).join("/");
  if (relative.length === 0 || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw acceptanceError("RC_PATH_ESCAPE", "RC evidence cannot contain an absolute or escaping path.", "Keep all evidence inside the deck project.");
  }
  return relative;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, filePath);
}

function normalizeTargetSlideCount(value: number | undefined): number {
  const target = value ?? ACCEPTED_SLIDE_COUNT_MIN;
  if (!Number.isSafeInteger(target) || target < ACCEPTED_SLIDE_COUNT_MIN || target > ACCEPTED_SLIDE_COUNT_MAX) {
    throw acceptanceError(
      "RC_TARGET_SLIDE_COUNT_INVALID",
      "RC acceptance requires an integer target slide count from 8 through 12.",
      "Rerun with --target-slide-count set to a value from 8 through 12."
    );
  }
  return target;
}

function normalizeCommit(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/-]{1,160}$/u.test(normalized) || normalized.includes("..")) {
    throw acceptanceError("RC_COMMIT_INVALID", "The caller-declared commit label is invalid.", "Pass a commit SHA or a short ref without spaces or absolute paths.");
  }
  return normalized;
}

function normalizeArtifactLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw acceptanceError("RC_ARTIFACT_LABEL_INVALID", "The caller-declared artifact label is empty or too long.", "Pass an HTTPS artifact URL or a short local artifact label.");
  }
  if (/^https:\/\//u.test(normalized)) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw acceptanceError("RC_ARTIFACT_LABEL_INVALID", "The caller-declared artifact URL is invalid.", "Pass a valid HTTPS artifact URL or a short local artifact label.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw acceptanceError("RC_ARTIFACT_LABEL_INVALID", "Artifact URLs must not contain credentials, query parameters, or fragments.", "Pass a clean HTTPS artifact URL or a local label.");
    }
    return parsed.toString();
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw acceptanceError("RC_ARTIFACT_LABEL_INVALID", "Local artifact labels may contain only letters, numbers, dot, underscore, and hyphen.", "Pass an HTTPS URL or a short local label.");
  }
  return normalized;
}

function requireRunId(run: AgentRunCliResult): string {
  if (typeof run.runId !== "string" || run.runId.trim().length === 0) {
    throw acceptanceError("RC_RUN_ID_MISSING", "The provider-backed run did not return a run id.", "Rerun the acceptance command.");
  }
  return run.runId;
}

function safeRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : "run";
}

function assertNoSecretValue(value: unknown, label: string, secrets: readonly string[] = []): void {
  const serialized = JSON.stringify(value);
  if (
    serialized.includes("sk-") ||
    serialized.includes("Bearer ") ||
    serialized.includes("api_key") ||
    secrets.some((secret) => secret.length > 0 && serialized.includes(secret))
  ) {
    throw acceptanceError("RC_SECRET_SAFETY_FAILED", `${label} contains a likely credential marker.`, "Remove secret material from the task or provider response and rerun.");
  }
}

function acceptanceError(code: string, message: string, suggestedFix: string): Error {
  return Object.assign(new Error(message), {
    code,
    exitCode: 6,
    suggestedFix
  });
}
