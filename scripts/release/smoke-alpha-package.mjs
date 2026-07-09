import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..");
const alphaDir = path.join(root, "dist", "alpha");
const appName = "HTMLslide.app";
const validFullFixturePath = path.join(root, "packages", "test-fixtures", "decks", "valid-full");

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

  if (
    manifest.appName !== "HTMLslide" ||
    manifest.channel !== "alpha" ||
    manifest.notarized !== false ||
    !String(manifest.bundleIdentifier ?? "").includes("htmlslide") ||
    !Array.isArray(manifest.documentTypes) ||
    !manifest.documentTypes.includes("deckpkg")
  ) {
    fail(`Alpha manifest does not match the unsigned alpha package contract: ${JSON.stringify(manifest, null, 2)}`);
  }

  for (const artifactPath of [dmgPath, zipPath]) {
    if (!path.basename(artifactPath).includes("unsigned-alpha")) {
      fail(`Alpha artifact name must include unsigned-alpha: ${artifactPath}`);
    }
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

function packagedAppExecutablePath(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const executableName = plistValue(plistPath, "CFBundleExecutable");
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);

  if (!existsSync(executablePath)) {
    fail(`Packaged app executable is missing: ${executablePath}`);
  }

  return executablePath;
}

function packagedCliPath(appPath) {
  const cliPath = path.join(appPath, "Contents", "Resources", "app", "cli-runtime", "dist", "bin", "htmlslide.js");
  if (!existsSync(cliPath)) {
    fail(`Packaged CLI runtime is missing: ${cliPath}`);
  }
  return cliPath;
}

function assertDeckPackageDocumentType(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const bundleIdentifier = plistValue(plistPath, "CFBundleIdentifier");
  const expectedUti = `${bundleIdentifier}.deckpkg`;
  const documentExtension = plistValue(plistPath, "CFBundleDocumentTypes:0:CFBundleTypeExtensions:0");
  const documentUti = plistValue(plistPath, "CFBundleDocumentTypes:0:LSItemContentTypes:0");
  const exportedUti = plistValue(plistPath, "UTExportedTypeDeclarations:0:UTTypeIdentifier");
  const exportedExtension = plistValue(
    plistPath,
    "UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0"
  );
  const exportedConformance = plistValue(plistPath, "UTExportedTypeDeclarations:0:UTTypeConformsTo:0");

  if (documentExtension !== "deckpkg" || documentUti !== expectedUti) {
    fail(
      `Packaged app does not register .deckpkg as a document type.\n` +
      `extension: ${documentExtension}\n` +
      `uti: ${documentUti}\n` +
      `expected uti: ${expectedUti}`
    );
  }

  if (exportedUti !== expectedUti || exportedExtension !== "deckpkg" || exportedConformance !== "com.pkware.zip-archive") {
    fail(
      `Packaged app does not export the .deckpkg UTI.\n` +
      `exported uti: ${exportedUti}\n` +
      `exported extension: ${exportedExtension}\n` +
      `exported conformance: ${exportedConformance}\n` +
      `expected uti: ${expectedUti}`
    );
  }
}

async function mountDmg(dmgPath, mountPoint) {
  await rm(mountPoint, { recursive: true, force: true });
  await mkdir(mountPoint, { recursive: true });
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
}

async function smokeZipArtifact(zipPath, smokeRoot) {
  const zipRoot = path.join(smokeRoot, "zip-artifact");
  await rm(zipRoot, { recursive: true, force: true });
  await mkdir(zipRoot, { recursive: true });
  run("ditto", ["-x", "-k", zipPath, zipRoot]);

  const zipAppPath = path.join(zipRoot, appName);
  if (!existsSync(zipAppPath)) {
    const entries = await readdir(zipRoot).catch(() => []);
    fail(`ZIP artifact did not extract ${appName} at its root.\nentries: ${entries.join(", ")}`);
  }

  const appStats = await lstat(zipAppPath);
  if (!appStats.isDirectory()) {
    fail(`ZIP artifact extracted ${appName}, but it is not an app bundle directory: ${zipAppPath}`);
  }

  assertDeckPackageDocumentType(zipAppPath);
  packagedAppExecutablePath(zipAppPath);
  packagedCliPath(zipAppPath);
  await smokeCliShim(zipAppPath, path.join(smokeRoot, "zip-cli"));
}

function detachDmg(mountPoint) {
  spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], {
    encoding: "utf8",
    stdio: "ignore"
  });
}

async function launchPackagedAppForStartup(appPath, smokeRoot, options) {
  const executablePath = packagedAppExecutablePath(appPath);
  const smokeReadyFile = path.join(smokeRoot, options.name, "ready.json");

  await Promise.all([
    mkdir(path.join(smokeRoot, options.name, "home"), { recursive: true }),
    mkdir(path.join(smokeRoot, options.name, "workspace"), { recursive: true }),
    mkdir(path.join(smokeRoot, options.name, "user-data"), { recursive: true })
  ]);

  const child = spawn(executablePath, [], {
    cwd: path.dirname(appPath),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HOME: path.join(smokeRoot, options.name, "home"),
      HTMLSLIDE_CLI_TARGET_DIR: options.cliTargetDir,
      HTMLSLIDE_DEFAULT_WORKSPACE: path.join(smokeRoot, options.name, "workspace"),
      HTMLSLIDE_HOME: options.htmlslideHome,
      HTMLSLIDE_SMOKE_QUIT_AFTER_READY: "1",
      HTMLSLIDE_SMOKE_READY_FILE: smokeReadyFile,
      HTMLSLIDE_USER_DATA_DIR: path.join(smokeRoot, options.name, "user-data")
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

async function launchAppOnce(appPath, smokeRoot) {
  const firstRunHtmlslideHome = path.join(smokeRoot, "first-run-home");
  const firstRunCliTargetDir = path.join(firstRunHtmlslideHome, "bin");

  await launchPackagedAppForStartup(appPath, smokeRoot, {
    cliTargetDir: firstRunCliTargetDir,
    htmlslideHome: firstRunHtmlslideHome,
    name: "startup"
  });

  await smokeFirstRunCliProvisioning(appPath, firstRunCliTargetDir, firstRunHtmlslideHome);
  await smokeFirstRunOfficialSkills(firstRunHtmlslideHome);

  return {
    cliTargetDir: firstRunCliTargetDir,
    htmlslideHome: firstRunHtmlslideHome
  };
}

async function exportFixtureDeckPackageWithPackagedCli(appPath, smokeRoot) {
  const projectPath = path.join(smokeRoot, "deckpkg-source", "valid-full");
  await mkdir(path.dirname(projectPath), { recursive: true });
  await cp(validFullFixturePath, projectPath, {
    recursive: true,
    verbatimSymlinks: true
  });

  const cliPath = packagedCliPath(appPath);
  const result = run(process.execPath, [cliPath, "export", projectPath, "--json"], {
    env: {
      HTMLSLIDE_HOME: path.join(smokeRoot, "deckpkg-cli-home")
    }
  });
  const exported = readJsonOutput(result, "packaged htmlslide export");
  const deckpkgPath =
    typeof exported.artifacts?.deckpkg === "string"
      ? exported.artifacts.deckpkg
      : path.join(projectPath, "exports", "valid-full-deck.deckpkg");

  if (!existsSync(deckpkgPath)) {
    fail(`Packaged CLI export did not create a deckpkg artifact: ${deckpkgPath}`);
  }

  return deckpkgPath;
}

async function launchAppWithDeckPackage(appPath, smokeRoot) {
  const executablePath = packagedAppExecutablePath(appPath);
  const deckpkgPath = await exportFixtureDeckPackageWithPackagedCli(appPath, smokeRoot);
  const smokeReadyFile = path.join(smokeRoot, "deckpkg-open", "ready.json");
  const smokeHome = path.join(smokeRoot, "deckpkg-home");
  const smokeWorkspace = path.join(smokeRoot, "deckpkg-workspace");
  const smokeUserData = path.join(smokeRoot, "deckpkg-user-data");

  await Promise.all([
    mkdir(smokeHome, { recursive: true }),
    mkdir(smokeWorkspace, { recursive: true }),
    mkdir(smokeUserData, { recursive: true })
  ]);

  const child = spawn(executablePath, [deckpkgPath], {
    cwd: path.dirname(appPath),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HOME: smokeHome,
      HTMLSLIDE_CLI_TARGET_DIR: path.join(smokeRoot, "deckpkg-first-run-bin"),
      HTMLSLIDE_DEFAULT_WORKSPACE: smokeWorkspace,
      HTMLSLIDE_HOME: path.join(smokeRoot, "deckpkg-first-run-home"),
      HTMLSLIDE_SMOKE_EXPECT_OPEN_DECKPKG_PATH: deckpkgPath,
      HTMLSLIDE_SMOKE_QUIT_AFTER_READY: "1",
      HTMLSLIDE_SMOKE_READY_FILE: smokeReadyFile,
      HTMLSLIDE_USER_DATA_DIR: smokeUserData
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
    }, 25_000);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? `signal:${signal}` : code ?? 1);
    });
  });

  const marker = existsSync(smokeReadyFile) ? JSON.parse(await readFile(smokeReadyFile, "utf8")) : undefined;
  if (exitCode !== 0 || marker?.status !== "passed") {
    fail([
      `Packaged app did not open a deckpkg argument successfully: ${String(exitCode)}`,
      marker ? `Smoke marker: ${JSON.stringify(marker)}` : "",
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : ""
    ].filter(Boolean).join("\n"));
  }

  const expectedDeckpkgPath = await realpath(deckpkgPath);
  const actualDeckpkgPath = await realpath(String(marker.deckpkgPath));
  const actualExpectedDeckpkgPath = await realpath(String(marker.expectedDeckpkgPath));
  if (
    marker.kind !== "deckpkg-open" ||
    actualDeckpkgPath !== expectedDeckpkgPath ||
    actualExpectedDeckpkgPath !== expectedDeckpkgPath ||
    marker.title !== "Valid Full Deck" ||
    marker.slideCount !== 2
  ) {
    fail(`Packaged deckpkg smoke marker did not match the expected deck: ${JSON.stringify(marker)}`);
  }
}

async function smokeFirstRunCliProvisioning(appPath, targetDir, htmlslideHome) {
  const shimPath = path.join(targetDir, "htmlslide");
  const appPathJson = path.join(htmlslideHome, "app-path.json");
  if (!existsSync(shimPath)) {
    fail(`Packaged app first-run setup did not install CLI shim: ${shimPath}`);
  }

  const shimSource = await readFile(shimPath, "utf8");
  if (!shimSource.includes("HTMLslide managed CLI shim v1")) {
    fail(`First-run CLI shim is not HTMLslide-managed: ${shimPath}`);
  }

  const appConfig = JSON.parse(await readFile(appPathJson, "utf8"));
  const expectedAppPath = await realpath(appPath);
  const actualAppPath = await realpath(String(appConfig.appPath));
  if (actualAppPath !== expectedAppPath) {
    fail(
      `First-run app-path.json does not point at the installed app: ${appPathJson}\n` +
      `expected: ${expectedAppPath}\n` +
      `actual: ${actualAppPath}`
    );
  }
}

async function smokeFirstRunOfficialSkills(htmlslideHome) {
  const skillsDir = path.join(htmlslideHome, "skills");
  const entries = await readdir(skillsDir).catch(() => []);
  const expectedSkills = [
    "deck-architect",
    "visual-direction",
    "swiss-editorial",
    "consulting-clean",
    "technical-dark",
    "product-launch",
    "data-report",
    "chart-redesign",
    "speaker-notes",
    "anti-ai-slop",
    "deck-repair",
    "brand-kit"
  ];

  for (const skillName of expectedSkills) {
    const skillPath = path.join(skillsDir, skillName, "SKILL.md");
    if (!existsSync(skillPath)) {
      fail(`Packaged app first-run setup did not install official skill: ${skillPath}`);
    }
    const skillMarkdown = await readFile(skillPath, "utf8");
    if (!skillMarkdown.includes(`name: ${skillName}`) || skillMarkdown.includes("writesSecrets: true")) {
      fail(`Official skill file does not match expected safe metadata: ${skillPath}`);
    }
  }

  if (entries.length < expectedSkills.length) {
    fail(`Packaged app installed only ${entries.length} official skills under ${skillsDir}.`);
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
  const cliPath = packagedCliPath(appPath);
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

async function smokeMovedAppCliRepair(originalAppPath, smokeRoot, firstRunState) {
  const movedRoot = path.join(smokeRoot, "Moved Applications");
  const movedAppPath = path.join(movedRoot, appName);
  await mkdir(movedRoot, { recursive: true });
  await cp(originalAppPath, movedAppPath, {
    recursive: true,
    verbatimSymlinks: true
  });
  await rm(originalAppPath, { recursive: true, force: true });

  await launchPackagedAppForStartup(movedAppPath, smokeRoot, {
    cliTargetDir: firstRunState.cliTargetDir,
    htmlslideHome: firstRunState.htmlslideHome,
    name: "moved-app"
  });
  await smokeFirstRunCliProvisioning(movedAppPath, firstRunState.cliTargetDir, firstRunState.htmlslideHome);

  const shimPath = path.join(firstRunState.cliTargetDir, "htmlslide");
  const env = {
    HTMLSLIDE_HOME: firstRunState.htmlslideHome,
    PATH: `${path.dirname(shimPath)}${path.delimiter}${process.env.PATH ?? ""}`
  };
  const doctor = readJsonOutput(run(shimPath, ["doctor", "--json"], { env }), "moved app htmlslide doctor");
  const cliShim = doctor.checks?.find((check) => check.id === "cli-shim");
  if (doctor.status !== "passed" || cliShim?.status !== "passed") {
    fail(`htmlslide doctor did not pass after moved app CLI repair: ${JSON.stringify(doctor, null, 2)}`);
  }

  return movedAppPath;
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
    await smokeZipArtifact(zipPath, smokeRoot);

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

    assertDeckPackageDocumentType(installedAppPath);
    const firstRunState = await launchAppOnce(installedAppPath, smokeRoot);
    const movedAppPath = await smokeMovedAppCliRepair(installedAppPath, smokeRoot, firstRunState);
    await launchAppWithDeckPackage(movedAppPath, smokeRoot);
    await smokeCliShim(movedAppPath, smokeRoot);

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
