import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readPackageManifestProvenance, validateCommit } from "./rc-provenance.mjs";
import { validateByokAcceptanceEvidence } from "./verify-byok-acceptance.mjs";
import { validateExternalAgentAcceptanceEvidence } from "./verify-external-agent-acceptance.mjs";

const maxChecklistBytes = 2 * 1024 * 1024;
const expectedManualItems = 13;
const expectedManualTitles = [
  "Clean macOS User Account",
  "Install DMG",
  "First Launch Setup",
  "Create Deck With Mock Or Local Provider",
  "Create Deck With BYOK Provider If Key Available",
  "Connect Fake External Agents",
  "Validate Real Claude/Codex Compatibility And Gemini Boundary",
  "Export PDF And Deckpkg",
  "Present On External Monitor",
  "Reopen Project",
  "Revert An Agent Run",
  "Uninstall CLI",
  "Delete App And Check System Files"
];
const allowedManualStatuses = new Set(["pass", "fail", "n/a"]);
const requiredAutomatedGates = ["pnpm test:coverage", "pnpm test:visual:browser"];

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function main(args) {
  const options = parseArgs(args);
  const checklistPath = path.resolve(options.checklist);
  const fileStats = await stat(checklistPath);
  if (!fileStats.isFile()) {
    throw new Error(`RC checklist is not a regular file: ${checklistPath}`);
  }
  if (fileStats.size > maxChecklistBytes) {
    throw new Error(`RC checklist exceeds the ${maxChecklistBytes}-byte limit.`);
  }

  const markdown = await readFile(checklistPath, "utf8");
  const result = await verifyChecklist(markdown, {
    checklistPath,
    expectedCommit: options.commit,
    packageManifestPath: options.packageManifest,
    byokEvidencePath: options.byokEvidence,
    externalAgentEvidencePath: options.externalAgentEvidence
  });
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${formatHumanResult(result)}\n`);
  return result;
}

export function parseArgs(args) {
  const parsed = { json: false };
  const allowed = new Set(["checklist", "input", "json", "packageManifest", "commit", "byokEvidence", "externalAgentEvidence"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (!allowed.has(key) || key === "json") {
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

  if (typeof parsed.checklist !== "string" && typeof parsed.input === "string") {
    parsed.checklist = parsed.input;
  }
  if (typeof parsed.checklist !== "string" || parsed.checklist.trim().length === 0) {
    throw new Error("Missing required --checklist value.");
  }
  if (Boolean(parsed.packageManifest) !== Boolean(parsed.commit)) {
    throw new Error("--package-manifest and --commit must be provided together for RC provenance binding.");
  }
  return parsed;
}

export async function verifyChecklist(markdown, metadata = {}) {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new Error("RC checklist must be a non-empty Markdown document.");
  }

  const metadataSection = sectionBetween(markdown, "## Metadata", "## Automated Gates");
  const channel = metadataFieldValue(metadataSection, "Channel").toLowerCase();
  if (channel !== "alpha" && channel !== "release") {
    throw new Error(`RC checklist has unsupported Channel: ${channel || "empty"}.`);
  }

  const automatedSection = sectionBetween(markdown, "## Automated Gates", "## Manual Acceptance Script");
  const automatedItems = automatedSection.split("\n").filter((line) => /^- \[[ xX]\] /u.test(line));
  if (automatedItems.length === 0) {
    throw new Error("RC checklist has no automated gate entries.");
  }
  const missingRequiredAutomatedGates = requiredAutomatedGates.filter(
    (command) => !automatedItems.some((line) => line.includes(command))
  );
  if (missingRequiredAutomatedGates.length > 0) {
    throw new Error(`RC checklist is missing required automated gates: ${missingRequiredAutomatedGates.join(", ")}.`);
  }
  const uncheckedAutomated = automatedItems.filter((line) => /^- \[ \] /u.test(line));
  if (uncheckedAutomated.length > 0) {
    throw new Error(`Automated gates are incomplete: ${uncheckedAutomated.map((line) => line.slice(6)).join("; ")}`);
  }

  const manualSection = sectionBetween(markdown, "## Manual Acceptance Script", "## Result");
  const headings = [...manualSection.matchAll(/^### (\d+)\. (.+)$/gmu)];
  if (headings.length !== expectedManualItems) {
    throw new Error(`Expected ${expectedManualItems} manual acceptance items, found ${headings.length}.`);
  }

  const items = headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? manualSection.length;
    const section = manualSection.slice(start, end);
    const number = Number(heading[1]);
    if (number !== index + 1) {
      throw new Error(`Manual acceptance items must be numbered sequentially; found ${number}.`);
    }
    if (heading[2].trim() !== expectedManualTitles[index]) {
      throw new Error(`Manual item ${number} has an unexpected title: ${heading[2].trim()}.`);
    }

    const status = fieldValue(section, "Status");
    const normalizedStatus = status.toLowerCase();
    if (!allowedManualStatuses.has(normalizedStatus)) {
      throw new Error(`Manual item ${number} has invalid Status: ${status || "empty"}.`);
    }

    const evidence = fieldValue(section, "Evidence");
    const notes = fieldValue(section, "Notes");
    if (normalizedStatus === "pass" && isEmptyEvidence(evidence)) {
      throw new Error(`Manual item ${number} is Pass but has no Evidence.`);
    }
    const uncheckedSteps = section.match(/^- \[ \] /gmu) ?? [];
    if (normalizedStatus === "pass" && uncheckedSteps.length > 0) {
      throw new Error(`Manual item ${number} is Pass but has ${uncheckedSteps.length} unchecked acceptance step(s).`);
    }
    if (normalizedStatus === "fail" && isEmptyEvidence(notes)) {
      throw new Error(`Manual item ${number} is Fail but has no Notes explanation.`);
    }
    if (normalizedStatus === "n/a" && isEmptyEvidence(notes)) {
      throw new Error(`Manual item ${number} is N/A but has no Notes rationale.`);
    }

    return {
      number,
      title: heading[2].trim(),
      status: normalizedStatus === "n/a" ? "N/A" : normalizedStatus[0].toUpperCase() + normalizedStatus.slice(1),
      hasEvidence: !isEmptyEvidence(evidence),
      hasNotes: !isEmptyEvidence(notes)
    };
  });

  const resultSection = sectionAfter(markdown, "## Result");
  const resultStatus = fieldValue(resultSection, "Status");
  if (resultStatus !== "Accepted" && resultStatus !== "Rejected") {
    throw new Error(`Result has invalid Status: ${resultStatus || "empty"}.`);
  }
  const acceptedChecked = /^- \[[xX]\] Accepted for release candidate publication\./mu.test(resultSection);
  const rejectedChecked = /^- \[[xX]\] Rejected; blocking issues are filed and linked below\./mu.test(resultSection);
  if (acceptedChecked === rejectedChecked) {
    throw new Error("Result must check exactly one of Accepted or Rejected.");
  }

  if (resultStatus !== "Accepted") {
    throw new Error("RC checklist result is Rejected; promotion requires Accepted.");
  }

  const hasFailure = items.some((item) => item.status === "Fail");
  const expectedResult = hasFailure ? "Rejected" : "Accepted";
  if (resultStatus !== expectedResult || (hasFailure ? !rejectedChecked : !acceptedChecked)) {
    throw new Error(`Result Status ${resultStatus} does not match manual acceptance outcome ${expectedResult}.`);
  }

  const incompleteItems = items.filter((item) => item.status !== "Pass");
  if (incompleteItems.length > 0) {
    throw new Error(
      `Accepted ${channel} RC checklists require Pass for every manual acceptance item; incomplete items: ${incompleteItems
        .map((item) => `${item.number}. ${item.title} (${item.status})`)
        .join("; ")}`
    );
  }

  if (/\bTODO\b/gu.test(markdown)) {
    throw new Error("RC checklist still contains unresolved TODO placeholders.");
  }

  const provenance = metadata.packageManifestPath
    ? await verifyProvenance(markdown, metadata)
    : undefined;
  const byokEvidence = metadata.byokEvidencePath
    ? await verifyByokEvidencePath(metadata.byokEvidencePath, markdown, metadata)
    : undefined;
  const externalAgentEvidence = metadata.externalAgentEvidencePath
    ? await verifyExternalAgentEvidencePath(metadata.externalAgentEvidencePath, markdown, metadata, provenance)
    : undefined;

  const statusCounts = Object.fromEntries(["Pass", "Fail", "N/A"].map((status) => [
    status,
    items.filter((item) => item.status === status).length
  ]));
  return {
    status: "passed",
    command: "rc:checklist:verify",
    checklistPath: metadata.checklistPath ?? "<inline>",
    automatedGates: automatedItems.length,
    manualItems: items.length,
    manualSectionCount: items.length,
    manualItemCount: items.length,
    manualStatuses: statusCounts,
    statusCounts,
    result: resultStatus,
    ...(byokEvidence ? { byokEvidence } : {}),
    ...(externalAgentEvidence ? { externalAgentEvidence } : {}),
    ...(provenance ? { provenance } : {})
  };
}

async function verifyExternalAgentEvidencePath(evidencePathInput, markdown, metadata, provenance) {
  const evidencePath = path.resolve(evidencePathInput);
  const info = await lstat(evidencePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxChecklistBytes) {
    throw new Error(`External-agent evidence must be a regular JSON file no larger than ${maxChecklistBytes} bytes.`);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    throw new Error(`External-agent evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const metadataSection = sectionBetween(markdown, "## Metadata", "## Automated Gates");
  const checklistCommit = metadataFieldValue(metadataSection, "Commit");
  const checklistArtifact = metadataFieldValue(metadataSection, "DMG / artifact URL");
  const expectedCommit = metadata.expectedCommit ?? (isEmptyEvidence(checklistCommit) ? undefined : checklistCommit);
  const expectedArtifactUrl = isEmptyEvidence(checklistArtifact) ? undefined : checklistArtifact;
  const summary = validateExternalAgentAcceptanceEvidence(evidence, {
    ...(expectedCommit ? { expectedCommit } : {}),
    ...(expectedArtifactUrl ? { expectedArtifactUrl } : {}),
    ...(provenance ? {
      expectedPackageManifestSha256: provenance.manifestSha256,
      expectedPackageMetadata: {
        version: provenance.version,
        channel: provenance.channel,
        arch: provenance.arch,
        signing: provenance.signing,
        notarized: provenance.notarized,
        stapled: provenance.stapled
      }
    } : {})
  });

  return {
    path: evidencePath,
    sizeBytes: info.size,
    sha256: createHash("sha256").update(await readFile(evidencePath)).digest("hex"),
    ...summary
  };
}

async function verifyByokEvidencePath(evidencePathInput, markdown, metadata) {
  const evidencePath = path.resolve(evidencePathInput);
  const info = await lstat(evidencePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxChecklistBytes) {
    throw new Error(`BYOK evidence must be a regular JSON file no larger than ${maxChecklistBytes} bytes.`);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    throw new Error(`BYOK evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const metadataSection = sectionBetween(markdown, "## Metadata", "## Automated Gates");
  const checklistCommit = metadataFieldValue(metadataSection, "Commit");
  const checklistArtifact = metadataFieldValue(metadataSection, "DMG / artifact URL");
  const expectedCommit = metadata.expectedCommit ?? (isEmptyEvidence(checklistCommit) ? undefined : checklistCommit);
  const expectedArtifactUrl = isEmptyEvidence(checklistArtifact) ? undefined : checklistArtifact;
  const summary = validateByokAcceptanceEvidence(evidence, {
    ...(expectedCommit ? { expectedCommit } : {}),
    ...(expectedArtifactUrl ? { expectedArtifactUrl } : {}),
    ...(metadata.expectedArtifactSha256 ? { expectedArtifactSha256: metadata.expectedArtifactSha256 } : {})
  });

  return {
    path: evidencePath,
    sizeBytes: info.size,
    sha256: createHash("sha256").update(await readFile(evidencePath)).digest("hex"),
    ...summary
  };
}

async function verifyProvenance(markdown, metadata) {
  const expectedCommit = validateCommit(metadata.expectedCommit, "Expected commit");
  const provenance = await readPackageManifestProvenance(metadata.packageManifestPath, { requireSourceCommit: true });
  if (provenance.sourceCommit !== expectedCommit) {
    throw new Error("Package manifest sourceCommit does not match the expected commit.");
  }

  const metadataSection = sectionBetween(markdown, "## Metadata", "## Automated Gates");
  const checklistVersion = metadataFieldValue(metadataSection, "Version");
  const checklistChannel = metadataFieldValue(metadataSection, "Channel").toLowerCase();
  const checklistCommit = metadataFieldValue(metadataSection, "Commit");
  const checklistManifestSha256 = metadataFieldValue(metadataSection, "Package manifest SHA256");
  const checklistArtifactSha256 = metadataFieldValue(metadataSection, "Primary DMG SHA256");

  if (checklistVersion !== provenance.version) {
    throw new Error("RC checklist Version does not match the package manifest.");
  }
  if (checklistChannel !== provenance.channel) {
    throw new Error("RC checklist Channel does not match the package manifest.");
  }
  if (checklistCommit !== expectedCommit || checklistCommit !== provenance.sourceCommit) {
    throw new Error("RC checklist Commit does not match the package manifest and expected commit.");
  }
  if (checklistManifestSha256 !== provenance.manifestSha256) {
    throw new Error("RC checklist Package manifest SHA256 does not match the supplied package manifest.");
  }
  if (checklistArtifactSha256 !== provenance.primaryArtifactSha256) {
    throw new Error("RC checklist Primary DMG SHA256 does not match the supplied package manifest.");
  }

  return {
    commit: expectedCommit,
    packageManifestSha256: provenance.manifestSha256,
    primaryArtifactSha256: provenance.primaryArtifactSha256,
    version: provenance.version,
    channel: provenance.channel,
    arch: provenance.manifest.arch,
    signing: provenance.manifest.signing,
    notarized: provenance.manifest.notarized,
    stapled: provenance.manifest.stapled
  };
}

function sectionBetween(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  if (start < 0) {
    throw new Error(`RC checklist is missing ${startHeading}.`);
  }
  const contentStart = start + startHeading.length;
  const end = markdown.indexOf(endHeading, contentStart);
  if (end < 0) {
    throw new Error(`RC checklist is missing ${endHeading}.`);
  }
  return markdown.slice(contentStart, end);
}

function sectionAfter(markdown, startHeading) {
  const start = markdown.indexOf(startHeading);
  if (start < 0) {
    throw new Error(`RC checklist is missing ${startHeading}.`);
  }
  return markdown.slice(start + startHeading.length);
}

function fieldValue(section, field) {
  const match = section.match(new RegExp(`^- ${field}:[ \\t]*(.*)$`, "mu"));
  return match?.[1]?.trim() ?? "";
}

function metadataFieldValue(section, field) {
  const match = section.match(new RegExp(`^\\|[ \\t]*${field}[ \\t]*\\|[ \\t]*([^|]*?)[ \\t]*\\|$`, "mu"));
  return match?.[1]?.trim() ?? "";
}

function isEmptyEvidence(value) {
  return value.length === 0 || /^(?:TODO|TBD|none|n\/a)$/iu.test(value);
}

function formatHumanResult(result) {
  return `RC checklist passed: ${result.manualItems} manual items, ${result.automatedGates} automated gates, result ${result.result}.`;
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
