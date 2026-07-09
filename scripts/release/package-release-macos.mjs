import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageScript = path.join(scriptDir, "package-alpha.mjs");
const releaseConfig = path.resolve(scriptDir, "..", "..", "build", "package", "release-macos.json");

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
