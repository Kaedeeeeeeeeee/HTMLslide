import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256Pattern = /^[a-f0-9]{64}$/u;
const releaseArtifactName = "HTMLslide-${version}-signed-notarized-${arch}";
export const RELEASE_ARCHITECTURES = Object.freeze(["arm64", "x64"]);
export const REQUIRED_RELEASE_SECURITY_CHECKS = Object.freeze([
  "codesign.app.verify",
  "codesign.app.display",
  "spctl.app.execute",
  "codesign.dmg.verify",
  "codesign.dmg.display",
  "xcrun.stapler.validate",
  "spctl.dmg.open"
]);

export const REQUIRED_RELEASE_SCRIPTS = Object.freeze([
  "docs:check",
  "docs:build",
  "version:check",
  "lint",
  "typecheck",
  "test",
  "test:coverage",
  "test:visual:browser",
  "perf:smoke",
  "security:check",
  "build",
  "e2e:desktop",
  "e2e:desktop:a11y",
  "package:release:macos",
  "release:security:verify",
  "release:bundle:verify",
  "release:promote:verify",
  "smoke:package:alpha",
  "release:contract:check",
  "rc:checklist",
  "rc:checklist:verify",
  "rc:byok-evidence",
  "rc:byok-fixture-smoke",
  "rc:external-agent-evidence",
  "release:notes"
]);

export const REQUIRED_RELEASE_SECRETS = Object.freeze([
  "APPLE_DEVELOPER_ID_APPLICATION",
  "APPLE_DEVELOPER_ID_CERTIFICATE_BASE64",
  "APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "KEYCHAIN_PASSWORD"
]);

export function validateReleaseArchitecture(value, label = "Release architecture") {
  if (!RELEASE_ARCHITECTURES.includes(value)) {
    throw new Error(`${label} must be one of ${RELEASE_ARCHITECTURES.join(" or ")}; got ${String(value)}.`);
  }
  return value;
}

export function validateReleasePackageConfig(config, { expectedChannel = "release" } = {}) {
  const errors = [];
  const requireString = (value, label) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${label} must be a non-empty string.`);
    }
  };

  if (!isRecord(config)) {
    throw new Error("Invalid release package config: expected a JSON object.");
  }

  if (config.appName !== "HTMLslide") {
    errors.push(`appName must be HTMLslide, got ${String(config.appName)}.`);
  }
  if (config.bundleIdentifier !== "app.htmlslide") {
    errors.push(`bundleIdentifier must be app.htmlslide, got ${String(config.bundleIdentifier)}.`);
  }
  if (config.channel !== expectedChannel) {
    errors.push(`channel must be ${expectedChannel}, got ${String(config.channel)}.`);
  }
  if (config.artifactName !== releaseArtifactName) {
    errors.push(`artifactName must be ${releaseArtifactName}.`);
  }
  if (config.outputDirectory !== "dist/release") {
    errors.push("outputDirectory must be dist/release.");
  }
  if (config.signing !== "developer-id") {
    errors.push("signing must be developer-id.");
  }
  if (config.signDmg !== true) {
    errors.push("signDmg must be true.");
  }
  if (config.notarize !== true) {
    errors.push("notarize must be true.");
  }
  if (config.staple !== true) {
    errors.push("staple must be true.");
  }
  if (config.createZip !== false) {
    errors.push("createZip must be false for the release DMG-only artifact contract.");
  }

  requireString(config.volumeName, "volumeName");
  requireString(config.minimumSystemVersion, "minimumSystemVersion");

  if (!isRecord(config.deckPackageDocumentType)) {
    errors.push("deckPackageDocumentType must be an object.");
  } else {
    requireString(config.deckPackageDocumentType.name, "deckPackageDocumentType.name");
    requireString(config.deckPackageDocumentType.mimeType, "deckPackageDocumentType.mimeType");
    if (config.deckPackageDocumentType.extension !== "deckpkg") {
      errors.push("deckPackageDocumentType.extension must be deckpkg.");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid release package config:\n- ${errors.join("\n- ")}`);
  }

  return {
    appName: config.appName,
    bundleIdentifier: config.bundleIdentifier,
    channel: config.channel,
    artifactName: config.artifactName,
    outputDirectory: config.outputDirectory,
    signing: config.signing,
    notarize: config.notarize,
    stapled: config.staple
  };
}

export function validateReleaseEnvironment({ packageJson, config, env = process.env, expectedChannel = "release" }) {
  const errors = [];
  const scripts = packageJson?.scripts ?? {};
  const missingScripts = REQUIRED_RELEASE_SCRIPTS.filter((name) => !scripts[name]);
  if (missingScripts.length > 0) {
    errors.push(`package.json is missing release scripts: ${missingScripts.join(", ")}.`);
  }

  const missingSecrets = REQUIRED_RELEASE_SECRETS.filter((name) => !hasText(env[name]));
  if (missingSecrets.length > 0) {
    errors.push(`Missing signing secrets: ${missingSecrets.join(", ")}.`);
  }

  if (hasText(env.APPLE_DEVELOPER_ID_CERTIFICATE_BASE64) &&
      !looksLikeBase64Der(env.APPLE_DEVELOPER_ID_CERTIFICATE_BASE64)) {
    errors.push("APPLE_DEVELOPER_ID_CERTIFICATE_BASE64 must contain a base64-encoded DER PKCS#12 payload.");
  }

  try {
    validateReleasePackageConfig(config, { expectedChannel });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return {
    channel: expectedChannel,
    requiredScriptCount: REQUIRED_RELEASE_SCRIPTS.length,
    requiredSecretCount: REQUIRED_RELEASE_SECRETS.length
  };
}

export async function validateReleaseManifest(
  manifestPath,
  { expectedArch = "arm64", expectedTeamIdentifier } = {}
) {
  validateReleaseArchitecture(expectedArch, "Expected release architecture");
  const resolvedManifestPath = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Release manifest is missing or invalid JSON: ${resolvedManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const errors = [];
  if (!isRecord(manifest)) {
    throw new Error("Invalid release manifest: expected a JSON object.");
  }
  if (manifest.appName !== "HTMLslide") errors.push("appName must be HTMLslide.");
  if (manifest.channel !== "release") errors.push("channel must be release.");
  if (!RELEASE_ARCHITECTURES.includes(manifest.arch)) {
    errors.push(`arch must be one of ${RELEASE_ARCHITECTURES.join(" or ")}.`);
  }
  if (manifest.arch !== expectedArch) errors.push(`arch must be ${expectedArch}.`);
  if (manifest.signing !== "developer-id") errors.push("signing must be developer-id.");
  if (manifest.notarized !== true) errors.push("notarized must be true.");
  if (manifest.stapled !== true) errors.push("stapled must be true.");
  if (manifest.bundleIdentifier !== "app.htmlslide") errors.push("bundleIdentifier must be app.htmlslide.");
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) errors.push("version must be a non-empty string.");
  if (!Array.isArray(manifest.documentTypes) || !manifest.documentTypes.includes("deckpkg")) {
    errors.push("documentTypes must include deckpkg.");
  }
  if (
    !isRecord(manifest.browserRuntime) ||
    manifest.browserRuntime.kind !== "chromium-headless-shell" ||
    typeof manifest.browserRuntime.revision !== "string" ||
    manifest.browserRuntime.revision.length === 0 ||
    typeof manifest.browserRuntime.version !== "string" ||
    manifest.browserRuntime.version.length === 0
  ) {
    errors.push("browserRuntime must declare a Chromium headless-shell revision and version.");
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (artifacts.length !== 1 || typeof artifacts[0] !== "string" || !artifacts[0].endsWith(".dmg")) {
    errors.push("release artifacts must contain exactly one DMG.");
  }
  const artifactMetadata = Array.isArray(manifest.artifactMetadata) ? manifest.artifactMetadata : [];
  if (artifactMetadata.length !== artifacts.length) {
    errors.push("artifactMetadata must cover every release artifact.");
  }

  const artifactDirectory = path.dirname(resolvedManifestPath);
  if (!path.basename(resolvedManifestPath).endsWith(`-${expectedArch}.json`)) {
    errors.push(`release manifest filename must end with -${expectedArch}.json.`);
  }
  const resolvedReleaseArtifactPath = typeof artifacts[0] === "string"
    ? resolveManifestReference(artifacts[0], artifactDirectory)
    : "";
  for (const artifact of artifacts) {
    if (typeof artifact !== "string" || artifact.length === 0) {
      errors.push("every release artifact must be a non-empty path string.");
      continue;
    }

    if (!isBasenameReference(artifact)) {
      errors.push(`release artifact must be a basename-only path: ${artifact}.`);
      continue;
    }

    const resolvedArtifactPath = resolveManifestReference(artifact, artifactDirectory);
    if (path.dirname(resolvedArtifactPath) !== artifactDirectory) {
      errors.push(`release artifact must be beside the manifest: ${artifact}.`);
      continue;
    }

    let artifactStats;
    try {
      artifactStats = await lstat(resolvedArtifactPath);
    } catch {
      errors.push(`release artifact is missing: ${artifact}.`);
      continue;
    }
    if (!artifactStats.isFile()) {
      errors.push(`release artifact must be a regular file: ${artifact}.`);
      continue;
    }
    if (!path.basename(resolvedArtifactPath).endsWith(`-${expectedArch}.dmg`)) {
      errors.push(`release DMG filename must end with -${expectedArch}.dmg.`);
    }

    const metadata = artifactMetadata.find((entry) =>
      isRecord(entry) && resolveManifestReference(String(entry.path), artifactDirectory) === resolvedArtifactPath
    );
    if (!metadata) {
      errors.push(`artifactMetadata is missing ${artifact}.`);
      continue;
    }
    if (metadata.fileName !== path.basename(resolvedArtifactPath)) {
      errors.push(`artifact metadata filename mismatch for ${artifact}.`);
    }
    if (metadata.sizeBytes !== artifactStats.size) {
      errors.push(`artifact metadata size mismatch for ${artifact}.`);
    }
    if (!sha256Pattern.test(String(metadata.sha256 ?? ""))) {
      errors.push(`artifact metadata SHA-256 is invalid for ${artifact}.`);
    } else if (metadata.sha256 !== await sha256File(resolvedArtifactPath)) {
      errors.push(`artifact metadata SHA-256 mismatch for ${artifact}.`);
    }
  }

  if (
    !isRecord(manifest.securityEvidence) ||
    typeof manifest.securityEvidence.fileName !== "string" ||
    manifest.securityEvidence.fileName.trim().length === 0 ||
    path.basename(manifest.securityEvidence.fileName) !== manifest.securityEvidence.fileName
  ) {
    errors.push("securityEvidence must reference a beside-the-manifest evidence file.");
  } else {
    const securityEvidencePath = path.join(artifactDirectory, manifest.securityEvidence.fileName);
    try {
      const securityEvidenceStats = await lstat(securityEvidencePath);
      if (!securityEvidenceStats.isFile()) {
        errors.push("securityEvidence must be a regular file.");
      } else {
        const securityEvidence = JSON.parse(await readFile(securityEvidencePath, "utf8"));
        const checks = Array.isArray(securityEvidence.checks) ? securityEvidence.checks : [];
        const manifestEvidence = securityEvidence.artifacts?.manifest;
        const signature = securityEvidence.signature;
        const dmgSignature = securityEvidence.dmgSignature;
        const architecture = securityEvidence.architecture;
        const appEvidence = securityEvidence.artifacts?.app;
        const dmgEvidence = securityEvidence.artifacts?.dmg;
        const checkTools = checks.map((check) => isRecord(check) ? check.tool : undefined);
        const evidenceArtifactMetadataValid =
          isReleaseArtifactMetadata(appEvidence, "HTMLslide.app") &&
          isReleaseArtifactMetadata(dmgEvidence, path.basename(resolvedReleaseArtifactPath)) &&
          isReleaseArtifactMetadata(manifestEvidence, path.basename(resolvedManifestPath));
        const manifestArtifact = artifactMetadata.find(
          (entry) => isRecord(entry) && entry.fileName === path.basename(resolvedReleaseArtifactPath)
        );
        if (
          securityEvidence.schemaVersion !== "1" ||
          checks.length !== REQUIRED_RELEASE_SECURITY_CHECKS.length ||
          new Set(checkTools).size !== REQUIRED_RELEASE_SECURITY_CHECKS.length ||
          !REQUIRED_RELEASE_SECURITY_CHECKS.every((tool) => checkTools.includes(tool)) ||
          checks.some((check) => !isRecord(check) || check.status !== "passed") ||
          !isRecord(signature) ||
          typeof signature.identity !== "string" ||
          !signature.identity.startsWith("Developer ID Application:") ||
          signature.bundleIdentifier !== "app.htmlslide" ||
          typeof signature.teamIdentifier !== "string" ||
          signature.teamIdentifier.trim().length === 0 ||
          (expectedTeamIdentifier !== undefined && signature.teamIdentifier !== expectedTeamIdentifier) ||
          signature.hardenedRuntime !== true ||
          !isRecord(dmgSignature) ||
          typeof dmgSignature.identity !== "string" ||
          !dmgSignature.identity.startsWith("Developer ID Application:") ||
          typeof dmgSignature.teamIdentifier !== "string" ||
          dmgSignature.teamIdentifier.trim().length === 0 ||
          (expectedTeamIdentifier !== undefined && dmgSignature.teamIdentifier !== expectedTeamIdentifier) ||
          !isRecord(architecture) ||
          typeof architecture.executable !== "string" ||
          architecture.executable.trim().length === 0 ||
          !Array.isArray(architecture.architectures) ||
          architecture.architectures.length !== 1 ||
          architecture.architectures[0] !== expectedArch ||
          !evidenceArtifactMetadataValid ||
          !isRecord(manifestArtifact) ||
          dmgEvidence.fileName !== manifestArtifact.fileName ||
          dmgEvidence.sizeBytes !== manifestArtifact.sizeBytes ||
          dmgEvidence.sha256 !== manifestArtifact.sha256 ||
          manifestEvidence.fileName !== path.basename(resolvedManifestPath) ||
          manifestEvidence.sha256 !== await sha256File(resolvedManifestPath)
        ) {
          errors.push("securityEvidence does not prove the signed release checks and manifest hash.");
        }
      }
    } catch {
      errors.push(`securityEvidence is missing or invalid: ${manifest.securityEvidence.fileName}.`);
    }
  }

  if (artifacts[0] && typeof artifacts[0] === "string" && !path.basename(artifacts[0]).includes("signed-notarized")) {
    errors.push("release DMG name must include signed-notarized.");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid release manifest:\n- ${errors.join("\n- ")}`);
  }

  return {
    manifestPath: resolvedManifestPath,
    artifactPath: resolvedReleaseArtifactPath,
    arch: expectedArch,
    channel: "release"
  };
}

export function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--check-env") {
      parsed.checkEnv = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    parsed[key] = value;
    if (inlineValue === undefined) index += 1;
  }
  if (!parsed.config && !parsed.manifest) throw new Error("Provide --config and/or --manifest.");
  return parsed;
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.config) {
    const [packageJson, config] = await Promise.all([
      readJson(path.join(root, "package.json")),
      readJson(path.resolve(root, options.config))
    ]);
    if (options.checkEnv) {
      validateReleaseEnvironment({
        packageJson,
        config,
        expectedChannel: options.expectedChannel ?? "release"
      });
    } else {
      validateReleasePackageConfig(config, { expectedChannel: options.expectedChannel ?? "release" });
    }
    process.stdout.write("Release package configuration contract passed.\n");
  }
  if (options.manifest) {
    await validateReleaseManifest(options.manifest, {
      expectedArch: options.expectedArch ?? "arm64",
      expectedTeamIdentifier: options.teamId
    });
    process.stdout.write("Release manifest contract passed.\n");
  }
}

function isReleaseArtifactMetadata(value, expectedFileName) {
  return isRecord(value) &&
    value.fileName === expectedFileName &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    sha256Pattern.test(String(value.sha256 ?? ""));
}

function resolveManifestReference(reference, manifestDirectory) {
  return path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(manifestDirectory, reference);
}

function isBasenameReference(reference) {
  const normalized = reference.replaceAll("\\", "/");
  return !path.posix.isAbsolute(normalized) &&
    !path.win32.isAbsolute(reference) &&
    !normalized.includes("/") &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.includes("../") &&
    !normalized.includes("./");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function looksLikeBase64Der(value) {
  if (!hasText(value) || value !== value.trim() || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded[0] === 0x30;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
