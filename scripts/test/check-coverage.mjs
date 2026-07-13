import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vitestEntry = path.join(root, "node_modules/vitest/vitest.mjs");

const COVERAGE_SCOPES = [
  { name: "core", threshold: 85, include: "packages/core/src/**/*.ts", tests: [] },
  {
    name: "linter",
    threshold: 80,
    include: "packages/linter/src/**/*.ts",
    tests: ["packages/linter/test/checker.test.ts"]
  },
  {
    name: "agent-adapters",
    threshold: 80,
    include: "packages/agent-adapters/src/**/*.ts",
    tests: ["packages/agent-adapters/test/agent-adapters.test.ts"]
  }
];

export async function runCoverageGates({
  runCommand = runVitest,
  temporaryRoot,
  readSummary = readCoverageSummary
} = {}) {
  const ownedTemporaryRoot = temporaryRoot ? undefined : await mkdtemp(path.join(os.tmpdir(), "htmlslide-coverage-"));
  const reportRoot = temporaryRoot ?? ownedTemporaryRoot;
  const results = [];

  try {
    for (const scope of COVERAGE_SCOPES) {
      const reportDirectory = path.join(reportRoot, scope.name);
      const result = runCommand([
        "run",
        "--testTimeout=15000",
        "--coverage",
        "--coverage.reporter=text",
        "--coverage.reporter=json-summary",
        "--coverage.reportsDirectory",
        reportDirectory,
        `--coverage.include=${scope.include}`,
        ...scope.tests
      ]);
      if (result.status !== 0) {
        throw new Error(`Coverage test run failed for ${scope.name} with exit code ${result.status ?? 1}.`);
      }

      const summary = await readSummary(reportDirectory);
      const lines = Number(summary.total?.lines?.pct);
      if (!Number.isFinite(lines) || lines < scope.threshold) {
        throw new Error(
          `${scope.name} line coverage is ${Number.isFinite(lines) ? `${lines}%` : "unavailable"}; required at least ${scope.threshold}%.`
        );
      }
      results.push({ name: scope.name, lines, threshold: scope.threshold });
      process.stdout.write(`Coverage gate passed: ${scope.name} ${lines}% (minimum ${scope.threshold}%).\n`);
    }
  } finally {
    if (ownedTemporaryRoot) {
      await rm(ownedTemporaryRoot, { recursive: true, force: true });
    }
  }

  return results;
}

function runVitest(args) {
  return spawnSync(process.execPath, [vitestEntry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit"
  });
}

async function readCoverageSummary(reportDirectory) {
  return JSON.parse(await readFile(path.join(reportDirectory, "coverage-summary.json"), "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCoverageGates().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
