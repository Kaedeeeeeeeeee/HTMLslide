import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..");
const desktopDir = path.join(root, "apps", "desktop");
const configPath = path.join(root, "build", "package", "alpha-macos.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env
    },
    stdio: options.stdio ?? "inherit"
  });

  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function readJson(filePath) {
  return readFile(filePath, "utf8").then((contents) => JSON.parse(contents));
}

function normalizeArch(arch) {
  if (arch === "x64" || arch === "arm64") {
    return arch;
  }

  fail(`Unsupported macOS alpha package architecture: ${arch}`);
}

function formatArtifactName(template, values) {
  return template.replace(/\$\{(version|arch)\}/g, (_, key) => values[key]);
}

function plistSet(plistPath, key, value) {
  const setResult = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
    encoding: "utf8",
    stdio: "ignore"
  });

  if (setResult.status === 0) {
    return;
  }

  run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
    stdio: "ignore"
  });
}

function plistDelete(plistPath, key) {
  spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath], {
    encoding: "utf8",
    stdio: "ignore"
  });
}

async function requirePath(pathToCheck, label) {
  if (!existsSync(pathToCheck)) {
    fail(`${label} is missing: ${pathToCheck}`);
  }
}

function electronAppPath() {
  const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));
  const electronPackagePath = requireFromDesktop.resolve("electron/package.json");
  return path.join(path.dirname(electronPackagePath), "dist", "Electron.app");
}

async function writeRuntimePackage(appResourcesPath, desktopPackage, version) {
  const runtimePackage = {
    name: "htmlslide",
    productName: "HTMLslide",
    version,
    private: true,
    type: "module",
    main: "dist/electron/main.js",
    description: desktopPackage.description
  };

  await writeFile(
    path.join(appResourcesPath, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`
  );
}

const cliRuntimePackages = [
  "@htmlslide/core",
  "@htmlslide/renderer",
  "@htmlslide/agent",
  "@htmlslide/linter",
  "@htmlslide/compiler",
  "@htmlslide/cli"
];

function buildCliRuntimePackages() {
  for (const packageName of cliRuntimePackages) {
    run("pnpm", ["--filter", packageName, "build"]);
  }
}

async function pruneCliRuntime(cliRuntimePath) {
  const packageNames = ["agent", "cli", "compiler", "core", "linter", "renderer"];
  const redundantPaths = [
    path.join(cliRuntimePath, "__tests__"),
    path.join(cliRuntimePath, "src"),
    path.join(cliRuntimePath, "test"),
    path.join(cliRuntimePath, "tsconfig.json"),
    path.join(cliRuntimePath, "tsconfig.tsbuildinfo")
  ];

  for (const packageName of packageNames) {
    const packagePath = path.join(cliRuntimePath, "node_modules", "@htmlslide", packageName);
    redundantPaths.push(
      path.join(packagePath, "__tests__"),
      path.join(packagePath, "src"),
      path.join(packagePath, "test"),
      path.join(packagePath, "tsconfig.json"),
      path.join(packagePath, "tsconfig.tsbuildinfo")
    );
  }

  await Promise.all(redundantPaths.map((targetPath) => rm(targetPath, { recursive: true, force: true })));
}

async function deployCliRuntime(appResourcesPath) {
  const cliRuntimePath = path.join(appResourcesPath, "cli-runtime");
  const temporaryParentPath = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-runtime-"));
  const temporaryRuntimePath = path.join(temporaryParentPath, "runtime");

  try {
    buildCliRuntimePackages();
    await rm(cliRuntimePath, { recursive: true, force: true });
    run("pnpm", ["--filter", "@htmlslide/cli", "deploy", "--prod", "--legacy", temporaryRuntimePath], {
      env: { CI: "true" }
    });
    await pruneCliRuntime(temporaryRuntimePath);
    await cp(temporaryRuntimePath, cliRuntimePath, {
      recursive: true,
      verbatimSymlinks: true
    });
    await requirePath(path.join(cliRuntimePath, "dist", "bin", "htmlslide.js"), "Packaged CLI runtime");
  } finally {
    await rm(temporaryParentPath, { recursive: true, force: true });
  }
}

async function deployDesktopRuntime(appResourcesPath) {
  const agentRuntimePath = path.join(appResourcesPath, "node_modules", "@htmlslide", "agent");
  const agentPackagePath = path.join(root, "packages", "agent");

  await rm(agentRuntimePath, { recursive: true, force: true });
  await mkdir(agentRuntimePath, { recursive: true });
  await cp(path.join(agentPackagePath, "package.json"), path.join(agentRuntimePath, "package.json"));
  await cp(path.join(agentPackagePath, "dist"), path.join(agentRuntimePath, "dist"), {
    recursive: true,
    verbatimSymlinks: true
  });
  await requirePath(path.join(agentRuntimePath, "dist", "index.js"), "Packaged desktop agent runtime");
}

async function createDmg({ appPath, artifactBaseName, outputDir, volumeName }) {
  const dmgPath = path.join(outputDir, `${artifactBaseName}.dmg`);
  const dmgRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-alpha-dmg-"));

  try {
    await cp(appPath, path.join(dmgRoot, path.basename(appPath)), {
      recursive: true,
      verbatimSymlinks: true
    });
    await symlink("/Applications", path.join(dmgRoot, "Applications"));
    await rm(dmgPath, { force: true });
    run("hdiutil", ["create", "-volname", volumeName, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
    return dmgPath;
  } finally {
    await rm(dmgRoot, { recursive: true, force: true });
  }
}

function createZip({ appPath, artifactBaseName, outputDir }) {
  const zipPath = path.join(outputDir, `${artifactBaseName}.zip`);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  return zipPath;
}

if (process.platform !== "darwin") {
  fail("Unsigned alpha macOS packaging must run on macOS because it uses Electron.app, hdiutil, and ditto.");
}

const [rootPackage, desktopPackage, config] = await Promise.all([
  readJson(path.join(root, "package.json")),
  readJson(path.join(desktopDir, "package.json")),
  readJson(configPath)
]);

const version = desktopPackage.version ?? rootPackage.version ?? "0.0.0";
const arch = normalizeArch(process.env.HTMLSLIDE_PACKAGE_ARCH ?? process.arch);
const artifactBaseName = formatArtifactName(config.artifactName, { version, arch });
const outputDir = path.resolve(root, config.outputDirectory);
const appPath = path.join(outputDir, `${config.appName}.app`);
const desktopDist = path.join(desktopDir, "dist");
const electronApp = electronAppPath();

if (!existsSync(electronApp)) {
  process.stdout.write("Electron runtime is missing; running electron once to fetch the packaged runtime.\n");
  run("pnpm", ["--filter", desktopPackage.name, "exec", "electron", "--version"]);
}

await requirePath(electronApp, "Electron runtime");

run("pnpm", ["--filter", desktopPackage.name, "build"]);

await requirePath(path.join(desktopDist, "electron", "main.js"), "Desktop main process build");
await requirePath(path.join(desktopDist, "electron", "preload.cjs"), "Desktop preload build");
await requirePath(path.join(desktopDist, "renderer", "index.html"), "Desktop renderer build");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(electronApp, appPath, { recursive: true, verbatimSymlinks: true });

const resourcesPath = path.join(appPath, "Contents", "Resources");
const appResourcesPath = path.join(resourcesPath, "app");
await rm(path.join(resourcesPath, "default_app.asar"), { force: true });
await rm(path.join(resourcesPath, "default_app.asar.unpacked"), { recursive: true, force: true });
await rm(appResourcesPath, { recursive: true, force: true });
await mkdir(appResourcesPath, { recursive: true });
await cp(desktopDist, path.join(appResourcesPath, "dist"), {
  recursive: true,
  verbatimSymlinks: true
});
await writeRuntimePackage(appResourcesPath, desktopPackage, version);
await deployDesktopRuntime(appResourcesPath);
await deployCliRuntime(appResourcesPath);

const plistPath = path.join(appPath, "Contents", "Info.plist");
plistSet(plistPath, "CFBundleName", config.appName);
plistSet(plistPath, "CFBundleDisplayName", config.appName);
plistSet(plistPath, "CFBundleIdentifier", config.bundleIdentifier);
plistSet(plistPath, "CFBundleShortVersionString", version);
plistSet(plistPath, "CFBundleVersion", process.env.GITHUB_RUN_NUMBER ?? version);
plistSet(plistPath, "LSMinimumSystemVersion", config.minimumSystemVersion);
plistDelete(plistPath, "ElectronAsarIntegrity");

if (config.adHocSign && process.env.HTMLSLIDE_ALPHA_SKIP_ADHOC_SIGN !== "1") {
  run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

const dmgPath = await createDmg({
  appPath,
  artifactBaseName,
  outputDir,
  volumeName: config.volumeName
});
const zipPath = createZip({ appPath, artifactBaseName, outputDir });
const manifestPath = path.join(outputDir, `${artifactBaseName}.json`);

await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      appName: config.appName,
      version,
      arch,
      channel: "alpha",
      bundleIdentifier: config.bundleIdentifier,
      signing: config.adHocSign ? "ad-hoc" : "none",
      notarized: false,
      artifacts: [dmgPath, zipPath]
    },
    null,
    2
  )}\n`
);

for (const artifact of [dmgPath, zipPath, manifestPath]) {
  process.stdout.write(`${artifact}\n`);
}
