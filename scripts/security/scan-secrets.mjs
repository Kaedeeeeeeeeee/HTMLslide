import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const detectors = [
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,})\b/g
  },
  {
    name: "Anthropic API key",
    pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    name: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g
  },
  {
    name: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g
  },
  {
    name: "Private key",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g
  }
];

const ignoredPathPatterns = [
  /^pnpm-lock\.yaml$/u,
  /^package-lock\.json$/u,
  /^yarn\.lock$/u
];

const trackedFiles = await listTrackedFiles();
const findings = [];

for (const filePath of trackedFiles) {
  if (ignoredPathPatterns.some((pattern) => pattern.test(filePath))) {
    continue;
  }

  const absolutePath = path.join(root, filePath);
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
    continue;
  }

  const text = bytes.toString("utf8");
  for (const detector of detectors) {
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0] ?? "";
      if (isAllowedExample(value)) {
        continue;
      }
      findings.push({
        detector: detector.name,
        filePath,
        line: lineNumberAt(text, match.index ?? 0),
        preview: redact(value)
      });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.filePath}:${finding.line}: ${finding.detector} candidate ${finding.preview}\n`
    );
  }
  process.stderr.write(`Secret scan failed with ${findings.length} candidate(s).\n`);
  process.exit(1);
}

process.stdout.write(`Secret scan passed (${trackedFiles.length} source files scanned).\n`);

async function listTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) {
      line += 1;
    }
  }
  return line;
}

function redact(value) {
  if (value.length <= 12) {
    return "[redacted]";
  }
  return `${value.slice(0, 6)}...[redacted]...${value.slice(-4)}`;
}

function isAllowedExample(value) {
  const normalized = value.toLowerCase();
  return normalized.includes("example")
    || normalized.includes("fake")
    || normalized.includes("fixture")
    || normalized.includes("redacted")
    || normalized.includes("test");
}
