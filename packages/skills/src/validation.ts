import {
  OFFICIAL_BUNDLE_LICENSES,
  SKILL_INSTALL_TARGETS,
  SKILL_LICENSES,
  SKILL_RISK_KEYS,
  SKILL_RISK_LEVELS,
  type SkillDeckMetadata,
  type SkillInstallTargetKind,
  type SkillLicense,
  type SkillMetadataValidationOptions,
  type SkillRiskLevel,
  type SkillRiskProfile,
  type SkillValidationIssue,
  type SkillValidationResult
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DECK_SCHEMA_PATTERN = /^\d+\.\d+\.\d+$/;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ALLOWED_DECK_TYPES = [
  "planning",
  "visual-direction",
  "design-system",
  "content",
  "data",
  "quality",
  "brand-system"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: SkillValidationIssue["code"], path: string, message: string): SkillValidationIssue {
  return { code, path, message };
}

function readString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: SkillValidationIssue[]
): string | undefined {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(issue("missing-field", path, `${path} must be a non-empty string.`));
    return undefined;
  }
  return value.trim();
}

function readOptionalStringArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: SkillValidationIssue[]
): string[] | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    issues.push(issue("missing-field", path, `${path} must be an array of non-empty strings.`));
    return undefined;
  }
  return value.map((item) => (item as string).trim());
}

function readStringArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: SkillValidationIssue[]
): string[] | undefined {
  const value = readOptionalStringArray(object, key, path, issues);
  if (value === undefined) {
    issues.push(issue("missing-field", path, `${path} is required.`));
    return undefined;
  }
  if (value.length === 0) {
    issues.push(issue("missing-field", path, `${path} must include at least one value.`));
    return undefined;
  }
  return value;
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: SkillValidationIssue[]
): boolean | undefined {
  const value = object[key];
  if (typeof value !== "boolean") {
    issues.push(issue("invalid-risk-profile", path, `${path} must be true or false.`));
    return undefined;
  }
  return value;
}

function isSafeRelativeSkillPath(reference: string, allowedExtensions: readonly string[]): boolean {
  if (!allowedExtensions.some((extension) => reference.endsWith(extension))) {
    return false;
  }
  if (reference.startsWith("/") || reference.includes("\\") || URL_SCHEME_PATTERN.test(reference)) {
    return false;
  }
  const segments = reference.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  return segments[0] !== "exports";
}

export function isSafeSkillEntrypoint(entrypoint: string): boolean {
  return isSafeRelativeSkillPath(entrypoint, [".md"]);
}

function validateRiskProfile(
  riskInput: unknown,
  riskLevel: SkillRiskLevel | undefined,
  issues: SkillValidationIssue[]
): SkillRiskProfile | undefined {
  if (!isRecord(riskInput)) {
    issues.push(issue("invalid-risk-profile", "deck.risk", "deck.risk must be an object."));
    return undefined;
  }

  const riskProfile = {} as SkillRiskProfile;
  let ok = true;
  for (const key of SKILL_RISK_KEYS) {
    const value = readBoolean(riskInput, key, `deck.risk.${key}`, issues);
    if (value === undefined) {
      ok = false;
    } else {
      riskProfile[key] = value;
    }
  }

  if (!ok) {
    return undefined;
  }

  if (riskProfile.writesSecrets) {
    issues.push(issue("forbidden-secret-write", "deck.risk.writesSecrets", "Skills must not write secrets."));
  }
  if (riskProfile.writesExports) {
    issues.push(issue("forbidden-export-write", "deck.risk.writesExports", "Skills must not write generated exports."));
  }
  if (riskLevel === "low" && (riskProfile.scripts || riskProfile.network || riskProfile.remoteAssets)) {
    issues.push(
      issue(
        "risk-level-too-low",
        "riskLevel",
        "Skills that run scripts, request network access, or use remote assets must be medium or high risk."
      )
    );
  }

  return riskProfile;
}

function validateDeckMetadata(
  input: Record<string, unknown>,
  riskLevel: SkillRiskLevel | undefined,
  issues: SkillValidationIssue[]
): SkillDeckMetadata | undefined {
  const deckInput = input.deck;
  if (!isRecord(deckInput)) {
    issues.push(issue("missing-field", "deck", "deck metadata is required."));
    return undefined;
  }

  const type = readString(deckInput, "type", "deck.type", issues);
  if (type !== undefined && !ALLOWED_DECK_TYPES.includes(type as (typeof ALLOWED_DECK_TYPES)[number])) {
    issues.push(issue("missing-field", "deck.type", "deck.type is not supported."));
  }

  const output = readString(deckInput, "output", "deck.output", issues);
  if (output !== undefined && output !== "html-slide") {
    issues.push(issue("missing-field", "deck.output", "deck.output must be html-slide."));
  }

  const viewport = readString(deckInput, "viewport", "deck.viewport", issues);
  if (viewport !== undefined && viewport !== "1920x1080") {
    issues.push(issue("missing-field", "deck.viewport", "deck.viewport must be 1920x1080."));
  }

  const supports = readStringArray(deckInput, "supports", "deck.supports", issues);
  const risk = validateRiskProfile(deckInput.risk, riskLevel, issues);

  let preview;
  if (deckInput.preview !== undefined) {
    if (!isRecord(deckInput.preview)) {
      issues.push(issue("missing-field", "deck.preview", "deck.preview must be an object when present."));
    } else {
      const previewType = readString(deckInput.preview, "type", "deck.preview.type", issues);
      const previewEntry = readString(deckInput.preview, "entry", "deck.preview.entry", issues);
      if (previewType !== undefined && previewType !== "html") {
        issues.push(issue("missing-field", "deck.preview.type", "Only HTML previews are supported."));
      }
      if (previewEntry !== undefined && !isSafeRelativeSkillPath(previewEntry, [".html"])) {
        issues.push(issue("invalid-entrypoint", "deck.preview.entry", "Preview entries must be safe project-relative Markdown or HTML paths."));
      }
      if (previewType === "html" && previewEntry !== undefined) {
        preview = { type: "html" as const, entry: previewEntry };
      }
    }
  }

  if (
    type === undefined ||
    output !== "html-slide" ||
    viewport !== "1920x1080" ||
    supports === undefined ||
    risk === undefined
  ) {
    return undefined;
  }

  return {
    type: type as SkillDeckMetadata["type"],
    output: "html-slide",
    viewport: "1920x1080",
    preview,
    supports,
    risk
  };
}

export function validateSkillMetadata(
  input: unknown,
  options: SkillMetadataValidationOptions = {}
): SkillValidationResult {
  const issues: SkillValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [issue("invalid-frontmatter", "", "Skill frontmatter must be an object.")]
    };
  }

  const name = readString(input, "name", "name", issues);
  if (name !== undefined && !SKILL_NAME_PATTERN.test(name)) {
    issues.push(
      issue("invalid-name", "name", "Skill names must use lowercase letters, numbers, and hyphens.")
    );
  }

  const version = readString(input, "version", "version", issues);
  if (version !== undefined && !SEMVER_PATTERN.test(version)) {
    issues.push(issue("invalid-version", "version", "Skill versions must use semantic versioning."));
  }

  const description = readString(input, "description", "description", issues);

  const license = readString(input, "license", "license", issues);
  if (license !== undefined && !SKILL_LICENSES.includes(license as SkillLicense)) {
    issues.push(issue("invalid-license", "license", `Unsupported skill license: ${license}.`));
  }
  if (
    options.official === true &&
    license !== undefined &&
    !OFFICIAL_BUNDLE_LICENSES.includes(license as (typeof OFFICIAL_BUNDLE_LICENSES)[number])
  ) {
    issues.push(
      issue("official-license-incompatible", "license", "Official bundled skills must use MIT or Apache-2.0.")
    );
  }

  const entrypoint = readString(input, "entrypoint", "entrypoint", issues);
  if (entrypoint !== undefined && !isSafeSkillEntrypoint(entrypoint)) {
    issues.push(issue("invalid-entrypoint", "entrypoint", "Skill entrypoint must be a safe project-relative Markdown path."));
  }

  const supportedDeckSchema = readStringArray(input, "supportedDeckSchema", "supportedDeckSchema", issues);
  if (
    supportedDeckSchema !== undefined &&
    supportedDeckSchema.some((schemaVersion) => !DECK_SCHEMA_PATTERN.test(schemaVersion))
  ) {
    issues.push(
      issue("invalid-supported-schema", "supportedDeckSchema", "Deck schema versions must use semantic versions.")
    );
  }

  const riskLevelValue = readString(input, "riskLevel", "riskLevel", issues);
  let riskLevel: SkillRiskLevel | undefined;
  if (riskLevelValue !== undefined) {
    if (SKILL_RISK_LEVELS.includes(riskLevelValue as SkillRiskLevel)) {
      riskLevel = riskLevelValue as SkillRiskLevel;
    } else {
      issues.push(issue("invalid-risk-level", "riskLevel", `Unsupported risk level: ${riskLevelValue}.`));
    }
  }

  const installTargetsRaw = readStringArray(input, "installTargets", "installTargets", issues);
  let installTargets: SkillInstallTargetKind[] | undefined;
  if (installTargetsRaw !== undefined) {
    const invalidTargets = installTargetsRaw.filter(
      (target) => !SKILL_INSTALL_TARGETS.includes(target as SkillInstallTargetKind)
    );
    if (invalidTargets.length > 0) {
      issues.push(
        issue("invalid-install-target", "installTargets", `Unsupported install targets: ${invalidTargets.join(", ")}.`)
      );
    } else {
      installTargets = installTargetsRaw as SkillInstallTargetKind[];
    }
  }

  const deck = validateDeckMetadata(input, riskLevel, issues);
  const author = typeof input.author === "string" && input.author.trim().length > 0 ? input.author.trim() : undefined;
  const tags = readOptionalStringArray(input, "tags", "tags", issues);

  if (
    issues.length > 0 ||
    name === undefined ||
    version === undefined ||
    description === undefined ||
    license === undefined ||
    entrypoint === undefined ||
    supportedDeckSchema === undefined ||
    riskLevel === undefined ||
    installTargets === undefined ||
    deck === undefined
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    metadata: {
      name,
      version,
      description,
      license: license as SkillLicense,
      entrypoint,
      supportedDeckSchema,
      riskLevel,
      installTargets,
      deck,
      author,
      tags
    },
    issues: []
  };
}
