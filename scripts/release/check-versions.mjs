import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const expectedTag = process.argv.includes("--tag")
  ? process.argv[process.argv.indexOf("--tag") + 1]
  : process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
const failures = [];

const rootPackage = await readJson("package.json");
const versionConstants = await readVersionConstants();
const packagePaths = await collectPackageJsonPaths();

checkSemver("package.json version", rootPackage.version);
for (const [name, value] of Object.entries(versionConstants)) {
  checkSemver(name, value);
}

if (versionConstants.HTMLSLIDE_APP_VERSION !== rootPackage.version) {
  failures.push(
    `packages/core/src/version.ts HTMLSLIDE_APP_VERSION (${versionConstants.HTMLSLIDE_APP_VERSION}) must match package.json version (${rootPackage.version}).`
  );
}

if (expectedTag !== undefined) {
  const expectedVersionTag = `v${rootPackage.version}`;
  if (expectedTag !== expectedVersionTag) {
    failures.push(`Release tag (${expectedTag}) must match package.json version (${rootPackage.version}) as ${expectedVersionTag}.`);
  }
}

for (const packagePath of packagePaths) {
  const packageJson = await readJson(packagePath);
  if (packageJson.version !== rootPackage.version) {
    failures.push(`${packagePath} version (${packageJson.version ?? "missing"}) must match package.json version (${rootPackage.version}).`);
  }
}

await checkRiskyVersionLiterals();

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Version contract passed: app ${versionConstants.HTMLSLIDE_APP_VERSION}, deck schema ${versionConstants.DECK_SCHEMA_VERSION}, ${packagePaths.length + 1} package manifests.\n`
  );
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function readVersionConstants() {
  const source = await readFile(path.join(root, "packages", "core", "src", "version.ts"), "utf8");
  return {
    AGENT_RUN_REPORT_SCHEMA_VERSION: readExportedString(source, "AGENT_RUN_REPORT_SCHEMA_VERSION"),
    CHECKPOINT_SCHEMA_VERSION: readExportedString(source, "CHECKPOINT_SCHEMA_VERSION"),
    CHECK_REPORT_SCHEMA_VERSION: readExportedString(source, "CHECK_REPORT_SCHEMA_VERSION"),
    DECK_PACKAGE_SCHEMA_VERSION: readExportedString(source, "DECK_PACKAGE_SCHEMA_VERSION"),
    DECK_SCHEMA_VERSION: readExportedString(source, "DECK_SCHEMA_VERSION"),
    HTMLSLIDE_APP_VERSION: readExportedString(source, "HTMLSLIDE_APP_VERSION")
  };
}

function readExportedString(source, name) {
  const match = source.match(new RegExp(`export const ${name} = "([^"]+)";`, "u"));
  if (!match?.[1]) {
    failures.push(`Missing ${name} in packages/core/src/version.ts.`);
    return "";
  }
  return match[1];
}

function checkSemver(label, value) {
  if (typeof value !== "string" || !semverPattern.test(value)) {
    failures.push(`${label} must be a semantic version, got ${value ?? "missing"}.`);
  }
}

async function collectPackageJsonPaths() {
  const paths = [];
  for (const workspaceDir of ["apps", "packages"]) {
    const workspacePath = path.join(root, workspaceDir);
    for (const entry of await readdir(workspacePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = path.join(workspaceDir, entry.name, "package.json");
      try {
        await stat(path.join(root, packagePath));
        paths.push(packagePath);
      } catch {
        // Not every workspace-adjacent folder needs a package manifest.
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

async function checkRiskyVersionLiterals() {
  const files = await collectSourceFiles(["apps", "packages", "scripts"]);
  const riskyPatterns = [
    {
      label: "schemaVersion literal",
      pattern: /schemaVersion:\s*["']0\.1\.0["']/u
    },
    {
      label: "appVersion literal",
      pattern: /appVersion:\s*["']0\.1\.0["']/u
    },
    {
      label: "runtime version literal",
      pattern: /\bversion:\s*["']0\.1\.0["']/u
    },
    {
      label: "commander version literal",
      pattern: /\.version\(["']0\.1\.0["']\)/u
    },
    {
      label: "supportedDeckSchema literal",
      pattern: /supportedDeckSchema:\s*\[\s*["']0\.1\.0["']\s*\]/u
    }
  ];

  for (const absolutePath of files) {
    const relativePath = path.relative(root, absolutePath);
    const source = await readFile(absolutePath, "utf8");
    for (const { label, pattern } of riskyPatterns) {
      if (pattern.test(source)) {
        failures.push(`${relativePath} contains ${label}; use packages/core/src/version.ts constants or document an explicit fixture exception.`);
      }
    }
  }
}

async function collectSourceFiles(topLevelDirs) {
  const files = [];
  for (const dir of topLevelDirs) {
    files.push(...await collectSourceFilesInDir(path.join(root, dir)));
  }
  return files;
}

async function collectSourceFilesInDir(directory) {
  const ignoredDirs = new Set(["dist", "node_modules", "test", "test-fixtures", "__tests__"]);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...await collectSourceFilesInDir(absolutePath));
      }
      continue;
    }

    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) {
      continue;
    }

    if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx") ||
      entry.name.endsWith(".spec.ts") ||
      entry.name === "check-versions.mjs"
    ) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}
