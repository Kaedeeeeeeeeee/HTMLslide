import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readPackageManifestProvenance, validateCommit } from "./rc-provenance.mjs";
import { verifyChecklist } from "./verify-rc-checklist.mjs";
import { verifyReleaseBundle } from "./verify-release-bundle.mjs";

const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const runIdPattern = /^[1-9]\d*$/u;

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function main(args) {
  const options = parseArgs(args);
  const releaseTag = validateReleaseTag(options.releaseTag);
  const candidateRunId = validateRunId(options.candidateRunId);
  const expectedCommit = validateCommit(options.commit, "Expected tag commit");
  const bundleResult = await verifyReleaseBundle({
    bundleDir: options.bundleDir,
    expectedArch: options.expectedArch ?? "arm64",
    expectedTeamIdentifier: options.teamId
  });
  const manifestPath = path.join(path.resolve(options.bundleDir), bundleResult.manifest.fileName);
  const provenance = await readPackageManifestProvenance(manifestPath, { requireSourceCommit: true });
  if (`v${provenance.version}` !== releaseTag) {
    throw new Error(`Release tag ${releaseTag} does not match package manifest version ${provenance.version}.`);
  }
  if (provenance.sourceCommit !== expectedCommit) {
    throw new Error("Candidate package sourceCommit does not match the selected release tag commit.");
  }

  const checklistPath = path.resolve(options.checklist);
  const checklistStats = await stat(checklistPath);
  if (!checklistStats.isFile()) {
    throw new Error(`RC checklist is not a regular file: ${checklistPath}`);
  }
  const checklistMarkdown = await readFile(checklistPath, "utf8");
  const checklistTag = metadataFieldValue(checklistMarkdown, "Release tag");
  if (checklistTag !== releaseTag) {
    throw new Error(`RC checklist Release tag ${checklistTag || "<empty>"} does not match ${releaseTag}.`);
  }
  const checklistRunId = metadataFieldValue(checklistMarkdown, "Candidate run ID");
  if (checklistRunId !== candidateRunId) {
    throw new Error(`RC checklist Candidate run ID ${checklistRunId || "<empty>"} does not match ${candidateRunId}.`);
  }
  const packageRunUrl = metadataFieldValue(checklistMarkdown, "Package workflow run");
  if (!new RegExp(`/actions/runs/${candidateRunId}(?:[/?#]|$)`, "u").test(packageRunUrl)) {
    throw new Error(`RC checklist Package workflow run does not identify candidate run ${candidateRunId}.`);
  }

  const checklistResult = await verifyChecklist(checklistMarkdown, {
    checklistPath,
    expectedCommit,
    packageManifestPath: manifestPath
  });
  const checklistSha256 = createHash("sha256").update(checklistMarkdown).digest("hex");
  const result = {
    status: "passed",
    command: "release:promote:verify",
    releaseTag,
    candidateRunId,
    sourceCommit: expectedCommit,
    bundle: {
      manifest: bundleResult.manifest,
      dmg: bundleResult.dmg,
      securityEvidence: bundleResult.securityEvidence
    },
    checklist: {
      fileName: path.basename(checklistPath),
      sizeBytes: checklistStats.size,
      sha256: checklistSha256,
      result: checklistResult.result
    },
    provenance: checklistResult.provenance
  };

  if (options.output) {
    await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `Release promotion evidence verified: ${releaseTag} from candidate run ${candidateRunId} (${bundleResult.dmg.fileName}).\n`
  );
  return result;
}

export function parseArgs(args) {
  const parsed = {};
  const allowed = new Set([
    "bundleDir",
    "checklist",
    "releaseTag",
    "candidateRunId",
    "commit",
    "expectedArch",
    "teamId",
    "output"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
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
    if (inlineValue === undefined) index += 1;
  }

  for (const key of ["bundleDir", "checklist", "releaseTag", "candidateRunId", "commit"]) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      throw new Error(`Missing required --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} value.`);
    }
  }
  return parsed;
}

export function validateReleaseTag(value) {
  const tag = String(value ?? "").trim();
  if (!releaseTagPattern.test(tag)) {
    throw new Error(`Release tag must be a v-prefixed SemVer tag: ${tag || "<empty>"}.`);
  }
  return tag;
}

export function validateRunId(value) {
  const runId = String(value ?? "").trim();
  if (!runIdPattern.test(runId)) {
    throw new Error(`Candidate run ID must be a positive numeric GitHub Actions run ID: ${runId || "<empty>"}.`);
  }
  return runId;
}

function metadataFieldValue(markdown, field) {
  const metadataStart = markdown.indexOf("## Metadata");
  const automatedStart = markdown.indexOf("## Automated Gates", metadataStart);
  if (metadataStart < 0 || automatedStart < 0) {
    throw new Error("RC checklist is missing its Metadata section.");
  }
  const section = markdown.slice(metadataStart, automatedStart);
  const match = section.match(new RegExp(`^\\|[ \\t]*${field}[ \\t]*\\|[ \\t]*([^|]*?)[ \\t]*\\|$`, "mu"));
  return match?.[1]?.trim() ?? "";
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
