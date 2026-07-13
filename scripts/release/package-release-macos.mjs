import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateReleaseEnvironment } from "./validate-release-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageScript = path.join(scriptDir, "package-alpha.mjs");
const releaseConfig = path.resolve(scriptDir, "..", "..", "build", "package", "release-macos.json");
const root = path.resolve(scriptDir, "..", "..");

const [packageJson, config] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(releaseConfig, "utf8").then(JSON.parse)
]);

try {
  validateReleaseEnvironment({ packageJson, config, expectedChannel: "release" });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [packageScript], {
  cwd: path.resolve(scriptDir, "..", ".."),
  env: {
    ...process.env,
    HTMLSLIDE_PACKAGE_CONFIG: releaseConfig,
    HTMLSLIDE_RELEASE_CHANNEL: "release"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
