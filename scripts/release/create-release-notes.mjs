import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const versionConstants = await readVersionConstants();
const options = parseArgs(process.argv.slice(2));
const tag = options.tag ?? process.env.GITHUB_REF_NAME ?? `v${packageJson.version ?? "0.0.0"}`;
const currentRef = options.ref ?? tag;
const previousTag = options.previousTag ?? await findPreviousTag(currentRef);
const outputPath = path.resolve(root, options.output ?? path.join("dist", "release", `HTMLslide-${tag}-release-notes.md`));
const commits = await collectCommits(previousTag, currentRef);
const notes = renderReleaseNotes({
  commits,
  currentRef,
  deckSchemaVersion: versionConstants.DECK_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  packageVersion: packageJson.version ?? "0.0.0",
  previousTag,
  tag
});

if (options.stdout) {
  process.stdout.write(notes);
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, notes, "utf8");
  process.stdout.write(`Release notes written to ${outputPath}\n`);
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--stdout") {
      parsed.stdout = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = toCamelCase(rawKey);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

async function readVersionConstants() {
  const source = await readFile(path.join(root, "packages", "core", "src", "version.ts"), "utf8");
  return {
    DECK_SCHEMA_VERSION: readExportedString(source, "DECK_SCHEMA_VERSION"),
    HTMLSLIDE_APP_VERSION: readExportedString(source, "HTMLSLIDE_APP_VERSION")
  };
}

function readExportedString(source, name) {
  const match = source.match(new RegExp(`export const ${name} = "([^"]+)";`, "u"));
  if (!match?.[1]) {
    throw new Error(`Missing ${name} in packages/core/src/version.ts.`);
  }
  return match[1];
}

async function findPreviousTag(currentRef) {
  await fetchTagsBestEffort();

  const candidates = [
    ["describe", "--tags", "--abbrev=0", `${currentRef}^`],
    ["describe", "--tags", "--abbrev=0", "HEAD^"]
  ];

  for (const args of candidates) {
    const result = await git(args, { allowFailure: true });
    const tagName = result.trim();
    if (tagName.length > 0 && tagName !== currentRef) {
      return tagName;
    }
  }

  return undefined;
}

async function fetchTagsBestEffort() {
  await git(["fetch", "--tags", "--force", "--quiet"], { allowFailure: true });
}

async function collectCommits(previousTag, currentRef) {
  const range = previousTag ? `${previousTag}..${currentRef}` : currentRef;
  const format = "%H%x1f%h%x1f%an%x1f%ad%x1f%s";
  const stdout = await git(["log", "--date=short", `--format=${format}`, range], { allowFailure: true });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", author = "", date = "", subject = ""] = line.split("\x1f");
      return {
        author,
        date,
        sha,
        shortSha,
        subject
      };
    });
}

async function git(args, options = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    throw error;
  }
}

function renderReleaseNotes(metadata) {
  const compareRange = metadata.previousTag
    ? `${metadata.previousTag}...${metadata.tag}`
    : `initial history through ${metadata.tag}`;
  const commitLines = metadata.commits.length > 0
    ? metadata.commits.map((commit) => `- ${commit.shortSha} ${commit.subject} (${commit.date}, ${commit.author})`).join("\n")
    : "- No commits found in the release range. Verify checkout fetch depth and tag history.";

  return `# HTMLslide ${metadata.tag}

Generated at: ${metadata.generatedAt}

Package version: ${metadata.packageVersion}
Deck schema version: ${metadata.deckSchemaVersion}
Range: ${compareRange}

## Release Summary

- Signed and notarized macOS artifacts are attached to this GitHub Release when the Release macOS workflow succeeds.
- The release workflow must pass docs, lint, typecheck, tests, performance smoke, security check, build, Electron E2E, signing, notarization, stapling, and manifest validation.
- A completed release-candidate acceptance checklist must be attached or linked separately before public distribution.

## Changes

${commitLines}

## Validation

- CI workflow: required.
- Release macOS workflow: required for signed/notarized artifacts.
- Manual RC acceptance: required for clean account install, BYOK when available, fake external agent, real Claude/Codex/Gemini claim validation or explicit no-claim N/A, external monitor presenter test, reopen, revert, CLI uninstall, and cleanup evidence.

## Known Limitations

- Unsigned alpha artifacts are tester-only and may trigger Gatekeeper warnings.
- Real provider keys, physical display behavior, and real Claude/Codex/Gemini support claims require manual validation before being described as supported.
`;
}
