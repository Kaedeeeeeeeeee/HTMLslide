import path from "node:path";
import {
  OFFICIAL_BUNDLE_LICENSES,
  PERMISSIVE_SKILL_LICENSES,
  PROJECT_SKILL_INSTALL_LOCATIONS,
  type ProjectSkillInstallLocation,
  type SkillInstallFile,
  type SkillInstallPlan,
  type SkillInstallPlanOptions,
  type SkillInstallWarning,
  type SkillLicense,
  type SkillLicenseCompatibilityReport
} from "./types.js";

const PROJECT_LOCATION_DIRS: Record<ProjectSkillInstallLocation, string[]> = {
  project: ["skills", "project"],
  codex: [".agents", "skills", "htmlslide"],
  claude: [".claude", "skills", "htmlslide"]
};

export function evaluateLicenseCompatibility(
  license: SkillLicense,
  usage: "project-install" | "official-bundle" = "project-install"
): SkillLicenseCompatibilityReport {
  if (
    usage === "official-bundle" &&
    !OFFICIAL_BUNDLE_LICENSES.includes(license as (typeof OFFICIAL_BUNDLE_LICENSES)[number])
  ) {
    return {
      license,
      compatibility: "incompatible",
      message: `${license} is not compatible with official bundled skills without legal review.`
    };
  }

  if (PERMISSIVE_SKILL_LICENSES.includes(license as (typeof PERMISSIVE_SKILL_LICENSES)[number])) {
    return {
      license,
      compatibility: "compatible",
      message: `${license} is compatible with normal HTMLslide skill installation.`
    };
  }

  if (license === "Unknown") {
    return {
      license,
      compatibility: "unknown",
      message: "Unknown licenses require user review before installation."
    };
  }

  return {
    license,
    compatibility: "review-required",
    message: `${license} requires explicit user review before installation.`
  };
}

function riskWarnings(options: SkillInstallPlanOptions): SkillInstallWarning[] {
  const warnings: SkillInstallWarning[] = [];
  const risk = options.metadata.deck.risk;

  if (risk.scripts) {
    warnings.push({
      code: "contains-scripts",
      severity: "warning",
      message: "This skill declares scripts and requires explicit user permission before use."
    });
  }
  if (risk.network) {
    warnings.push({
      code: "uses-network",
      severity: "warning",
      message: "This skill declares network access."
    });
  }
  if (risk.remoteAssets) {
    warnings.push({
      code: "remote-assets",
      severity: "warning",
      message: "This skill declares remote assets."
    });
  }
  if (risk.writesExports) {
    warnings.push({
      code: "writes-exports",
      severity: "error",
      message: "Skills must not write generated exports."
    });
  }
  if (risk.writesSecrets) {
    warnings.push({
      code: "writes-secrets",
      severity: "error",
      message: "Skills must not write secrets."
    });
  }
  if (options.metadata.riskLevel === "high") {
    warnings.push({
      code: "high-risk",
      severity: "warning",
      message: "This skill is marked high risk and should be inspected before installation."
    });
  }

  const license = evaluateLicenseCompatibility(options.metadata.license);
  if (license.compatibility === "unknown") {
    warnings.push({
      code: "license-unknown",
      severity: "warning",
      message: license.message
    });
  } else if (license.compatibility === "review-required") {
    warnings.push({
      code: "license-review-required",
      severity: "warning",
      message: license.message
    });
  } else if (license.compatibility === "incompatible") {
    warnings.push({
      code: "license-incompatible",
      severity: "error",
      message: license.message
    });
  }

  return warnings;
}

function entrypointFile(filePath: string, content: string): SkillInstallFile {
  return {
    path: filePath,
    content,
    kind: "entrypoint",
    overwrite: "replace"
  };
}

function projectLocations(
  locations: readonly ProjectSkillInstallLocation[] | undefined
): readonly ProjectSkillInstallLocation[] {
  return locations ?? ["project"];
}

export function planSkillInstall(options: SkillInstallPlanOptions): SkillInstallPlan {
  const filesToWrite: SkillInstallFile[] = [];

  if (options.target.kind === "global") {
    filesToWrite.push(
      entrypointFile(
        path.join(options.target.homeDir, ".htmlslide", "skills", options.metadata.name, options.metadata.entrypoint),
        options.markdown
      )
    );
  } else {
    for (const location of projectLocations(options.target.locations)) {
      if (!PROJECT_SKILL_INSTALL_LOCATIONS.includes(location)) {
        continue;
      }
      filesToWrite.push(
        entrypointFile(
          path.join(
            options.target.projectRoot,
            ...PROJECT_LOCATION_DIRS[location],
            options.metadata.name,
            options.metadata.entrypoint
          ),
          options.markdown
        )
      );
    }
  }

  const license = evaluateLicenseCompatibility(options.metadata.license);
  const warnings = riskWarnings(options);

  return {
    skillName: options.metadata.name,
    target: options.target.kind,
    filesToWrite,
    warnings,
    license,
    installable: warnings.every((warning) => warning.severity !== "error")
  };
}
