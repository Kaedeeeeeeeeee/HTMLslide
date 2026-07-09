import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const requiredFiles = {
  "README.md": ["HTMLslide", "Quick start", "Current alpha status", "docs/index.md", "docs:build", "version:check", "CODE_OF_CONDUCT.md"],
  "CONTRIBUTING.md": ["Contributing", "docs:check", "version:check", "security:check", "Code of Conduct"],
  "CODE_OF_CONDUCT.md": ["Code of Conduct", "Expected Behavior", "Unacceptable Behavior", "Reporting"],
  "SECURITY.md": ["Security Policy", "Reporting a Vulnerability", "Security Requirements"],
  "docs/index.md": ["HTMLslide Documentation", "Install", "No AI", "BYOK", "External agents"],
  "docs/install.md": ["Install HTMLslide", "unsigned alpha", "not Developer ID signed", "not notarized", "CLI shim"],
  "docs/getting-started.md": ["Getting Started", "No AI", "Local Mock", "Export"],
  "docs/create-your-first-deck.md": ["Create Your First Deck", "New Deck", "Local Mock", "Check", "Export"],
  "docs/ai-engines.md": ["AI Engines", "No AI", "HTMLslide Agent", "External agent"],
  "docs/byok.md": ["BYOK", "provider", "API key", "Keychain", "You pay your provider directly"],
  "docs/connect-claude-code.md": ["Claude Code", "detection", "Generic", "manual validation"],
  "docs/connect-codex.md": ["Codex", "detection", "Generic", "manual validation"],
  "docs/project-structure.md": ["Project Structure", "deck.json", "slides/", "exports/"],
  "docs/cli.md": ["CLI", "htmlslide new", "htmlslide check", "htmlslide export", "htmlslide doctor"],
  "docs/mcp.md": ["MCP", "project boundary", "path traversal", "alpha"],
  "docs/skills.md": ["Skills", "official skills", "SKILL.md", "license"],
  "docs/design-skills.md": ["Design Skills", "fixed 1920x1080", "swiss-editorial", "data-report"],
  "docs/presenter-mode.md": ["Presenter Mode", "Rehearsal", "Audience window", "dual-screen"],
  "docs/exporting.md": ["Exporting", "PDF", "deckpkg", "thumbnails", "notes.json"],
  "docs/troubleshooting.md": ["Troubleshooting", "Gatekeeper", "CLI", "provider", "deckpkg"],
  "docs/contributing.md": ["Contributing", "development contract", "no secrets", "conduct", "tests", "docs:build", "version:check"],
  "docs/code-of-conduct.md": ["Code of Conduct", "expected behavior", "unacceptable behavior", "reporting"],
  "docs/testing.md": ["Testing", "pnpm lint", "pnpm test", "pnpm e2e:desktop", "package smoke", "docs:build", "version:check"],
  "docs/release.md": ["Release", "unsigned alpha", "signed", "notarized", "GitHub Actions", "GitHub Pages", "docs:build", "version:check"],
  "docs/security.md": ["Security", "API keys", "project boundary", "vulnerability"]
};

const forbiddenClaims = [
  {
    file: "docs/install.md",
    patterns: [/Gatekeeper will not warn/iu, /notarized DMG is available/iu]
  },
  {
    file: "docs/connect-claude-code.md",
    patterns: [/Claude Code headless runs are fully supported/iu]
  },
  {
    file: "docs/connect-codex.md",
    patterns: [/Codex headless runs are fully supported/iu]
  }
];

const failures = [];

async function readRequiredFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing required public doc: ${relativePath}`);
    return "";
  }
  return readFile(absolutePath, "utf8");
}

function checkNeedles(relativePath, contents, needles) {
  for (const needle of needles) {
    if (!contents.includes(needle)) {
      failures.push(`${relativePath} must include: ${needle}`);
    }
  }
}

function checkForbiddenClaims(relativePath, contents) {
  const rule = forbiddenClaims.find((item) => item.file === relativePath);
  if (!rule) {
    return;
  }
  for (const pattern of rule.patterns) {
    if (pattern.test(contents)) {
      failures.push(`${relativePath} contains over-promising claim: ${pattern}`);
    }
  }
}

async function markdownFiles(dir) {
  const ignoredDirs = new Set([".git", "dist", "node_modules", "tmp"]);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        continue;
      }
      files.push(...await markdownFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function checkMarkdownLinks() {
  const files = await markdownFiles(root);
  const linkPattern = /\[[^\]]+\]\(([^)#][^)]+?)(?:#[^)]+)?\)/gu;
  for (const filePath of files) {
    const contents = await readFile(filePath, "utf8");
    for (const match of contents.matchAll(linkPattern)) {
      const link = match[1]?.trim();
      if (!link || /^[a-z][a-z0-9+.-]*:/iu.test(link) || link.startsWith("mailto:")) {
        continue;
      }
      const withoutQuery = link.split("?")[0] ?? link;
      const targetPath = path.resolve(path.dirname(filePath), withoutQuery);
      if (!targetPath.startsWith(root)) {
        failures.push(`${path.relative(root, filePath)} links outside repo: ${link}`);
        continue;
      }
      if (!existsSync(targetPath)) {
        failures.push(`${path.relative(root, filePath)} has broken link: ${link}`);
        continue;
      }
      const targetStat = await stat(targetPath);
      if (targetStat.isDirectory() && !existsSync(path.join(targetPath, "index.md"))) {
        failures.push(`${path.relative(root, filePath)} links to directory without index.md: ${link}`);
      }
    }
  }
}

for (const [relativePath, needles] of Object.entries(requiredFiles)) {
  const contents = await readRequiredFile(relativePath);
  checkNeedles(relativePath, contents, needles);
  checkForbiddenClaims(relativePath, contents);
}

await checkMarkdownLinks();

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public alpha docs contract passed (${Object.keys(requiredFiles).length} required files).\n`);
}
