import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "dist");
const version = process.env.npm_package_version ?? "0.1.0";
const outFile = path.join(dist, `HTMLslide-${version}-unsigned-alpha.tar.gz`);

await mkdir(dist, { recursive: true });

const inputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "AGENTS.md",
  "docs",
  "apps/desktop/dist",
  "packages/cli/dist",
  "packages/core/dist",
  "packages/compiler/dist",
  "packages/linter/dist",
  "packages/renderer/dist",
  "packages/agent/dist",
  "packages/mcp-server/dist"
];

const result = spawnSync("tar", ["-czf", outFile, ...inputs], {
  cwd: root,
  encoding: "utf8"
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

process.stdout.write(`${outFile}\n`);

