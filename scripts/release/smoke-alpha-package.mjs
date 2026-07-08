import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..");
const alphaDir = path.join(root, "dist", "alpha");
const appName = "HTMLslide.app";

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env
    },
    stdio: options.stdio ?? "pipe"
  });

  if (result.status !== 0) {
    fail([
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }

  return result;
}

async function latestManifestPath() {
  const entries = await readdir(alphaDir).catch(() => []);
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(alphaDir, entry);
        return {
          filePath,
          modifiedMs: (await stat(filePath)).mtimeMs
        };
      })
  );

  manifests.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!manifests[0]) {
    fail(`No alpha package manifest found under ${alphaDir}. Run pnpm package:alpha first.`);
  }

  return manifests[0].filePath;
}

async function readLatestManifest() {
  const manifestPath = await latestManifestPath();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts.map(String) : [];
  const dmgPath = artifacts.find((artifact) => artifact.endsWith(".dmg"));
  const zipPath = artifacts.find((artifact) => artifact.endsWith(".zip"));

  if (!dmgPath || !existsSync(dmgPath)) {
    fail(`Alpha manifest does not point to an existing DMG: ${manifestPath}`);
  }

  if (!zipPath || !existsSync(zipPath)) {
    fail(`Alpha manifest does not point to an existing ZIP: ${manifestPath}`);
  }

  return {
    dmgPath,
    manifestPath,
    zipPath
  };
}

function plistValue(plistPath, key) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]).stdout.trim();
}

async function mountDmg(dmgPath, mountPoint) {
  await rm(mountPoint, { recursive: true, force: true });
  await mkdir(mountPoint, { recursive: true });
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
}

function detachDmg(mountPoint) {
  spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], {
    encoding: "utf8",
    stdio: "ignore"
  });
}

async function launchAppOnce(appPath, smokeRoot) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const executableName = plistValue(plistPath, "CFBundleExecutable");
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const smokeReadyFile = path.join(smokeRoot, "startup", "ready.json");

  if (!existsSync(executablePath)) {
    fail(`Packaged app executable is missing: ${executablePath}`);
  }

  await Promise.all([
    mkdir(path.join(smokeRoot, "home"), { recursive: true }),
    mkdir(path.join(smokeRoot, "workspace"), { recursive: true }),
    mkdir(path.join(smokeRoot, "user-data"), { recursive: true })
  ]);

  const child = spawn(executablePath, [], {
    cwd: path.dirname(appPath),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HOME: path.join(smokeRoot, "home"),
      HTMLSLIDE_DEFAULT_WORKSPACE: path.join(smokeRoot, "workspace"),
      HTMLSLIDE_SMOKE_QUIT_AFTER_READY: "1",
      HTMLSLIDE_SMOKE_READY_FILE: smokeReadyFile,
      HTMLSLIDE_USER_DATA_DIR: path.join(smokeRoot, "user-data")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("timeout");
    }, 20_000);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? `signal:${signal}` : code ?? 1);
    });
  });

  if (exitCode !== 0) {
    const marker = existsSync(smokeReadyFile) ? await readFile(smokeReadyFile, "utf8") : "";
    fail([
      `Packaged app did not complete startup smoke successfully: ${String(exitCode)}`,
      marker ? `Smoke marker: ${marker.trim()}` : "",
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : ""
    ].filter(Boolean).join("\n"));
  }

  const marker = JSON.parse(await readFile(smokeReadyFile, "utf8"));
  if (marker.status !== "passed") {
    fail(`Packaged app startup smoke marker did not pass: ${JSON.stringify(marker)}`);
  }
}

function readJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not print valid JSON.\n${result.stdout}\n${result.stderr}`);
  }
}

async function smokeCliShim(appPath, smokeRoot) {
  const cliPath = path.join(appPath, "Contents", "Resources", "app", "cli-runtime", "dist", "bin", "htmlslide.js");
  if (!existsSync(cliPath)) {
    fail(`Packaged CLI runtime is missing: ${cliPath}`);
  }

  const htmlslideHome = path.join(smokeRoot, "htmlslide-home");
  const shimPath = path.join(htmlslideHome, "bin", "htmlslide");
  const env = {
    HTMLSLIDE_HOME: htmlslideHome,
    PATH: `${path.dirname(shimPath)}${path.delimiter}${process.env.PATH ?? ""}`
  };

  const install = readJsonOutput(
    run(process.execPath, [cliPath, "setup", "install-cli", "--target-path", shimPath, "--app-path", appPath, "--json"], {
      env
    }),
    "setup install-cli"
  );
  if (install.status !== "passed" || !existsSync(shimPath)) {
    fail(`CLI shim install did not pass: ${JSON.stringify(install)}`);
  }

  const doctor = readJsonOutput(run(shimPath, ["doctor", "--json"], { env }), "htmlslide doctor");
  const cliShim = doctor.checks?.find((check) => check.id === "cli-shim");
  if (doctor.status !== "passed" || cliShim?.status !== "passed") {
    fail(`htmlslide doctor did not pass through the installed shim: ${JSON.stringify(doctor, null, 2)}`);
  }

  const uninstall = readJsonOutput(
    run(process.execPath, [cliPath, "setup", "uninstall-cli", "--target-path", shimPath, "--json"], { env }),
    "setup uninstall-cli"
  );
  if (uninstall.status !== "passed" || uninstall.action !== "removed" || existsSync(shimPath)) {
    fail(`CLI shim uninstall did not remove the managed shim: ${JSON.stringify(uninstall)}`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    fail("Alpha package smoke must run on macOS because it mounts DMG artifacts and launches a .app bundle.");
  }

  const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-alpha-smoke-"));
  const mountPoint = path.join(smokeRoot, "mount");
  const installRoot = path.join(smokeRoot, "Applications");
  const installedAppPath = path.join(installRoot, appName);

  try {
    const { dmgPath, manifestPath, zipPath } = await readLatestManifest();
    process.stdout.write(`Using alpha manifest: ${manifestPath}\n`);
    process.stdout.write(`Checking ZIP artifact: ${zipPath}\n`);

    await mountDmg(dmgPath, mountPoint);
    const mountedAppPath = path.join(mountPoint, appName);
    if (!existsSync(mountedAppPath)) {
      fail(`Mounted DMG does not contain ${appName}.`);
    }
    const applicationsLink = path.join(mountPoint, "Applications");
    if (!existsSync(applicationsLink) || !(await lstat(applicationsLink)).isSymbolicLink()) {
      fail("Mounted DMG does not contain an Applications symlink.");
    }

    await mkdir(installRoot, { recursive: true });
    await cp(mountedAppPath, installedAppPath, {
      recursive: true,
      verbatimSymlinks: true
    });
    detachDmg(mountPoint);

    await launchAppOnce(installedAppPath, smokeRoot);
    await smokeCliShim(installedAppPath, smokeRoot);

    process.stdout.write("Alpha package smoke passed.\n");
  } finally {
    detachDmg(mountPoint);
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
