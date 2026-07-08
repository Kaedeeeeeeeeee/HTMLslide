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
  | {
      kind: "global";
      homeDir: string;
    }
  | {
      kind: "project";
      projectRoot: string;
      locations?: readonly ProjectSkillInstallLocation[];
    };

export interface SkillInstallFile {
  path: string;
  content: string;
  kind: "entrypoint";
  overwrite: "replace";
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
    | "license-incompatible";
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
