export const SKILL_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "Unlicense",
  "MPL-2.0",
  "LGPL-3.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "Proprietary",
  "Unknown"
] as const;

export type SkillLicense = (typeof SKILL_LICENSES)[number];

export const OFFICIAL_BUNDLE_LICENSES = ["MIT", "Apache-2.0"] as const;
export type OfficialBundleLicense = (typeof OFFICIAL_BUNDLE_LICENSES)[number];

export const PERMISSIVE_SKILL_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "Unlicense"
] as const;

export const REVIEW_REQUIRED_SKILL_LICENSES = [
  "MPL-2.0",
  "LGPL-3.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "Proprietary",
  "Unknown"
] as const;

export const SKILL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type SkillRiskLevel = (typeof SKILL_RISK_LEVELS)[number];

export const SKILL_INSTALL_TARGETS = ["global", "project"] as const;
export type SkillInstallTargetKind = (typeof SKILL_INSTALL_TARGETS)[number];

export const PROJECT_SKILL_INSTALL_LOCATIONS = ["project", "codex", "claude"] as const;
export type ProjectSkillInstallLocation = (typeof PROJECT_SKILL_INSTALL_LOCATIONS)[number];

export const SKILL_RISK_KEYS = [
  "scripts",
  "network",
  "remoteAssets",
  "writesExports",
  "writesSecrets",
  "modifiesSource"
] as const;

export type SkillRiskKey = (typeof SKILL_RISK_KEYS)[number];

export interface SkillRiskProfile {
  scripts: boolean;
  network: boolean;
  remoteAssets: boolean;
  writesExports: boolean;
  writesSecrets: boolean;
  modifiesSource: boolean;
}

export interface SkillPreviewMetadata {
  type: "html";
  entry: string;
}

export interface SkillDeckMetadata {
  type:
    | "planning"
    | "visual-direction"
    | "design-system"
    | "content"
    | "data"
    | "quality"
    | "brand-system";
  output: "html-slide";
  viewport: "1920x1080";
  preview?: SkillPreviewMetadata;
  supports: string[];
  risk: SkillRiskProfile;
}

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  license: SkillLicense;
  entrypoint: string;
  supportedDeckSchema: string[];
  riskLevel: SkillRiskLevel;
  installTargets: SkillInstallTargetKind[];
  deck: SkillDeckMetadata;
  author?: string;
  tags?: string[];
}

export interface SkillValidationIssue {
  code:
    | "missing-frontmatter"
    | "invalid-frontmatter"
    | "missing-field"
    | "invalid-name"
    | "invalid-version"
    | "invalid-license"
    | "invalid-entrypoint"
    | "invalid-supported-schema"
    | "invalid-risk-level"
    | "invalid-risk-profile"
    | "invalid-install-target"
    | "official-license-incompatible"
    | "forbidden-secret-write"
    | "forbidden-export-write"
    | "risk-level-too-low";
  path: string;
  message: string;
}

export type SkillValidationResult =
  | {
      ok: true;
      metadata: SkillMetadata;
      issues: [];
    }
  | {
      ok: false;
      issues: SkillValidationIssue[];
    };

export interface SkillMetadataValidationOptions {
  official?: boolean;
}

export interface SkillMarkdownDocument {
  metadata: SkillMetadata;
  body: string;
  frontmatter: Record<string, unknown>;
  rawFrontmatter: string;
}

export type SkillMarkdownParseResult =
  | {
      ok: true;
      document: SkillMarkdownDocument;
      issues: [];
    }
  | {
      ok: false;
      issues: SkillValidationIssue[];
      body?: string;
      frontmatter?: Record<string, unknown>;
      rawFrontmatter?: string;
    };

export interface OfficialSkillDefinition {
  official: true;
  metadata: SkillMetadata;
  markdown: string;
}

export type SkillLicenseCompatibility = "compatible" | "review-required" | "unknown" | "incompatible";

export interface SkillLicenseCompatibilityReport {
  license: SkillLicense;
  compatibility: SkillLicenseCompatibility;
  message: string;
}

export type SkillInstallTarget =
  | ({ kind: "global" } & (
      | {
          homeDir: string;
          htmlslideHomeDir?: never;
        }
      | {
          htmlslideHomeDir: string;
          homeDir?: never;
        }
    ))
  | {
      kind: "project";
      projectRoot: string;
      locations?: readonly ProjectSkillInstallLocation[];
    };

export interface SkillInstallFile {
  path: string;
  content: string;
  kind: "entrypoint" | "support" | "management";
  overwrite: "replace";
  encoding?: "utf8" | "base64";
  mode?: number;
  sha256?: string;
  sizeBytes?: number;
}

export interface SkillInstallWarning {
  code:
    | "contains-scripts"
    | "uses-network"
    | "remote-assets"
    | "writes-exports"
    | "writes-secrets"
    | "high-risk"
    | "license-review-required"
    | "license-unknown"
    | "license-incompatible"
    | "unsupported-install-target"
    | "invalid-project-location";
  severity: "warning" | "error";
  message: string;
}

export interface SkillInstallPlan {
  skillName: string;
  target: SkillInstallTargetKind;
  filesToWrite: SkillInstallFile[];
  warnings: SkillInstallWarning[];
  license: SkillLicenseCompatibilityReport;
  installable: boolean;
}

export interface SkillInstallPlanOptions {
  metadata: SkillMetadata;
  markdown: string;
  target: SkillInstallTarget;
}

export const SKILL_SOURCE_KINDS = ["official", "local-file", "local-directory", "url"] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export type SkillSourceReference =
  | string
  | { kind: "official"; name: string }
  | { kind: "local"; path: string }
  | { kind: "url"; url: string };

export interface SkillSourceFile {
  relativePath: string;
  content: string;
  encoding: "utf8" | "base64";
  mode: 0o644 | 0o755;
  sha256: string;
  sizeBytes: number;
}

export interface ResolvedSkillSource {
  kind: SkillSourceKind;
  reference: string;
  metadata: SkillMetadata;
  markdown: string;
  files: SkillSourceFile[];
}

export interface ManagedSkillFileRecord {
  path: string;
  sha256: string;
  sizeBytes: number;
  mode: 0o644 | 0o755;
}

export interface ManagedSkillRecord {
  schemaVersion: 1;
  manager: "htmlslide";
  name: string;
  version: string;
  entrypoint: string;
  sourceKind: SkillSourceKind;
  files: ManagedSkillFileRecord[];
}

export interface SkillStoreInstallPlan extends SkillInstallPlan {
  managed: true;
  source: {
    kind: SkillSourceKind;
    reference: string;
  };
  confirmationRequired: boolean;
}

export type SkillStoreErrorCode =
  | "SKILL_SOURCE_NOT_FOUND"
  | "SKILL_SOURCE_UNSUPPORTED"
  | "SKILL_SOURCE_URL_INSECURE"
  | "SKILL_SOURCE_URL_INVALID"
  | "SKILL_SOURCE_URL_UNSAFE"
  | "SKILL_SOURCE_DNS_FAILED"
  | "SKILL_SOURCE_FETCH_FAILED"
  | "SKILL_SOURCE_HTTP_ERROR"
  | "SKILL_SOURCE_REDIRECT_INVALID"
  | "SKILL_SOURCE_REDIRECT_LIMIT"
  | "SKILL_SOURCE_CONTENT_TYPE_UNSAFE"
  | "SKILL_SOURCE_TOO_LARGE"
  | "SKILL_SOURCE_TOO_MANY_FILES"
  | "SKILL_SOURCE_INVALID_UTF8"
  | "SKILL_SOURCE_INVALID"
  | "SKILL_SOURCE_SYMLINK"
  | "SKILL_SOURCE_UNSAFE_FILE"
  | "SKILL_PLAN_NOT_INSTALLABLE"
  | "SKILL_CONFIRMATION_REQUIRED"
  | "SKILL_TARGET_UNSAFE"
  | "SKILL_TARGET_CONFLICT"
  | "SKILL_TARGET_UNMANAGED"
  | "SKILL_TARGET_INVALID"
  | "SKILL_TARGET_MODIFIED"
  | "SKILL_LEGACY_ADOPTION_NOT_ALLOWED"
  | "SKILL_LEGACY_ADOPTION_UNSAFE"
  | "SKILL_NOT_FOUND"
  | "SKILL_NAME_INVALID"
  | "SKILL_INSTALL_FAILED"
  | "SKILL_REMOVE_FAILED";

export type SkillStoreLocation = "global" | ProjectSkillInstallLocation;
export type SkillStoreIntegrity = "verified" | "modified" | "unmanaged" | "invalid";

export interface InstalledSkillSummary {
  name: string;
  version: string;
  description: string;
  license: SkillLicense;
  riskLevel: SkillRiskLevel;
  location: SkillStoreLocation;
  directoryPath: string;
  entrypointPath: string;
  managed: boolean;
  integrity: SkillStoreIntegrity;
}

export interface InstalledSkillInspection extends InstalledSkillSummary {
  metadata: SkillMetadata;
  markdown: string;
  record?: ManagedSkillRecord;
}

export interface InvalidInstalledSkill {
  name: string;
  location: SkillStoreLocation;
  directoryPath: string;
  code: SkillStoreErrorCode;
  message: string;
}

export interface ListInstalledSkillsResult {
  target: SkillInstallTargetKind;
  skills: InstalledSkillSummary[];
  invalid: InvalidInstalledSkill[];
}

export interface SkillInstallLocationResult {
  location: SkillStoreLocation;
  directoryPath: string;
  action: "installed" | "updated" | "adopted" | "unchanged";
}

export interface SkillInstallResult {
  action: "installed" | "updated" | "adopted" | "unchanged";
  skillName: string;
  version: string;
  source: {
    kind: SkillSourceKind;
    reference: string;
  };
  locations: SkillInstallLocationResult[];
  warnings: SkillInstallWarning[];
}

export interface SkillRemoveResult {
  action: "removed";
  skillName: string;
  removed: Array<{
    location: SkillStoreLocation;
    directoryPath: string;
  }>;
  missing: SkillStoreLocation[];
}
