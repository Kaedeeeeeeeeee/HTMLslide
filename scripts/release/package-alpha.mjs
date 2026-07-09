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
const configPath = path.resolve(root, process.env.HTMLSLIDE_PACKAGE_CONFIG ?? "build/package/alpha-macos.json");

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

function runVersionCheck() {
  if (process.env.HTMLSLIDE_SKIP_VERSION_CHECK === "1") {
    return;
  }
  run("pnpm", ["version:check"]);
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

function plistAdd(plistPath, key, type, value = undefined) {
  run("/usr/libexec/PlistBuddy", [
    "-c",
    value === undefined ? `Add :${key} ${type}` : `Add :${key} ${type} ${value}`,
    plistPath
  ], {
    stdio: "ignore"
  });
}

function plistDelete(plistPath, key) {
  spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath], {
    encoding: "utf8",
    stdio: "ignore"
  });
}

function writeDeckPackageDocumentTypes(plistPath, bundleIdentifier, documentType) {
  const typeName = documentType?.name ?? "HTMLslide Deck Package";
  const extension = documentType?.extension ?? "deckpkg";
  const mimeType = documentType?.mimeType ?? "application/vnd.htmlslide.deckpkg";
  const deckPackageUti = `${bundleIdentifier}.deckpkg`;

  plistDelete(plistPath, "CFBundleDocumentTypes");
  plistAdd(plistPath, "CFBundleDocumentTypes", "array");
  plistAdd(plistPath, "CFBundleDocumentTypes:0", "dict");
  plistAdd(plistPath, "CFBundleDocumentTypes:0:CFBundleTypeName", "string", typeName);
  plistAdd(plistPath, "CFBundleDocumentTypes:0:CFBundleTypeRole", "string", "Viewer");
  plistAdd(plistPath, "CFBundleDocumentTypes:0:LSHandlerRank", "string", "Owner");
  plistAdd(plistPath, "CFBundleDocumentTypes:0:CFBundleTypeExtensions", "array");
  plistAdd(plistPath, "CFBundleDocumentTypes:0:CFBundleTypeExtensions:0", "string", extension);
  plistAdd(plistPath, "CFBundleDocumentTypes:0:LSItemContentTypes", "array");
  plistAdd(plistPath, "CFBundleDocumentTypes:0:LSItemContentTypes:0", "string", deckPackageUti);

  plistDelete(plistPath, "UTExportedTypeDeclarations");
  plistAdd(plistPath, "UTExportedTypeDeclarations", "array");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0", "dict");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeIdentifier", "string", deckPackageUti);
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeDescription", "string", typeName);
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeConformsTo", "array");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeConformsTo:0", "string", "com.pkware.zip-archive");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeConformsTo:1", "string", "public.data");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeTagSpecification", "dict");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension", "array");
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0", "string", extension);
  plistAdd(plistPath, "UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.mime-type", "string", mimeType);
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
      env: {
        CI: "true",
        npm_config_confirm_modules_purge: "false"
      }
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

function restoreWorkspaceInstallState() {
  // pnpm deploy --prod mutates the root workspace state to production-only.
  // Reset it so follow-up local scripts like smoke:package:alpha run without a TTY prompt.
  run("pnpm", ["install", "--frozen-lockfile"], {
    env: {
      npm_config_confirm_modules_purge: "false"
    }
  });
}

async function copyWorkspaceRuntimePackage(appNodeModulesPath, packageName, packagePath) {
  const runtimePath = path.join(appNodeModulesPath, ...packageName.split("/"));
  await rm(runtimePath, { recursive: true, force: true });
  await mkdir(runtimePath, { recursive: true });
  await cp(path.join(packagePath, "package.json"), path.join(runtimePath, "package.json"));
  await cp(path.join(packagePath, "dist"), path.join(runtimePath, "dist"), {
    recursive: true,
    verbatimSymlinks: true
  });
  await requirePath(path.join(runtimePath, "dist", "index.js"), `Packaged desktop runtime ${packageName}`);
}

async function copyNpmRuntimePackage(appNodeModulesPath, packageName, requireContext) {
  const packageRoot = path.dirname(requireContext.resolve(`${packageName}/package.json`));
  const runtimePath = path.join(appNodeModulesPath, ...packageName.split("/"));
  await rm(runtimePath, { recursive: true, force: true });
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await cp(packageRoot, runtimePath, {
    recursive: true,
    verbatimSymlinks: false
  });
  await requirePath(path.join(runtimePath, "package.json"), `Packaged npm runtime ${packageName}`);
}

async function deployDesktopRuntime(appResourcesPath) {
  const appNodeModulesPath = path.join(appResourcesPath, "node_modules");
  const compilerRequire = createRequire(path.join(root, "packages", "compiler", "package.json"));
  const coreRequire = createRequire(path.join(root, "packages", "core", "package.json"));
  const jszipRequire = createRequire(compilerRequire.resolve("jszip/package.json"));
  const workspaceRuntimePackages = [
    ["@htmlslide/agent", path.join(root, "packages", "agent")],
    ["@htmlslide/agent-adapters", path.join(root, "packages", "agent-adapters")],
    ["@htmlslide/core", path.join(root, "packages", "core")],
    ["@htmlslide/presenter", path.join(root, "packages", "presenter")],
    ["@htmlslide/skills", path.join(root, "packages", "skills")]
  ];
  const npmRuntimePackages = [
    [compilerRequire, "jszip"],
    [coreRequire, "zod"],
    [jszipRequire, "core-util-is"],
    [jszipRequire, "immediate"],
    [jszipRequire, "inherits"],
    [jszipRequire, "isarray"],
    [jszipRequire, "lie"],
    [jszipRequire, "pako"],
    [jszipRequire, "process-nextick-args"],
    [jszipRequire, "readable-stream"],
    [jszipRequire, "safe-buffer"],
    [jszipRequire, "setimmediate"],
    [jszipRequire, "string_decoder"],
    [jszipRequire, "util-deprecate"]
  ];

  await rm(appNodeModulesPath, { recursive: true, force: true });
  await mkdir(appNodeModulesPath, { recursive: true });

  for (const [packageName, packagePath] of workspaceRuntimePackages) {
    await copyWorkspaceRuntimePackage(appNodeModulesPath, packageName, packagePath);
  }
  for (const [requireContext, packageName] of npmRuntimePackages) {
    await copyNpmRuntimePackage(appNodeModulesPath, packageName, requireContext);
  }
}

async function createDmg({ appPath, artifactBaseName, outputDir, volumeName }) {
  const dmgPath = path.join(outputDir, `${artifactBaseName}.dmg`);
  const dmgRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-dmg-"));

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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} must be set for Developer ID signing and notarization.`);
  }
  return value;
}

function developerIdIdentity() {
  return requiredEnv("APPLE_DEVELOPER_ID_APPLICATION");
}

function signAppBundle(appPath, config) {
  if (config.signing === "developer-id") {
    run("codesign", [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      developerIdIdentity(),
      appPath
    ]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    return "developer-id";
  }

  if (config.adHocSign && process.env.HTMLSLIDE_ALPHA_SKIP_ADHOC_SIGN !== "1") {
    run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
    return "ad-hoc";
  }

  return "none";
}

function signDmg(dmgPath, config) {
  if (!config.signDmg) {
    return;
  }

  if (config.signing !== "developer-id") {
    fail("signDmg requires Developer ID signing.");
  }

  run("codesign", ["--force", "--timestamp", "--sign", developerIdIdentity(), dmgPath]);
  run("codesign", ["--verify", "--verbose=2", dmgPath]);
}

function notarizeDmg(dmgPath, config) {
  if (!config.notarize) {
    return {
      notarized: false,
      stapled: false
    };
  }

  if (config.signing !== "developer-id") {
    fail("notarize requires Developer ID signing.");
  }

  run("xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--apple-id",
    requiredEnv("APPLE_ID"),
    "--team-id",
    requiredEnv("APPLE_TEAM_ID"),
    "--password",
    requiredEnv("APPLE_APP_SPECIFIC_PASSWORD"),
    "--wait"
  ]);

  if (config.staple !== false) {
    run("xcrun", ["stapler", "staple", dmgPath]);
    run("xcrun", ["stapler", "validate", dmgPath]);
  }

  return {
    notarized: true,
    stapled: config.staple !== false
  };
}

runVersionCheck();

if (process.platform !== "darwin") {
  fail("macOS packaging must run on macOS because it uses Electron.app, hdiutil, ditto, codesign, and xcrun.");
}

const [rootPackage, desktopPackage, config] = await Promise.all([
  readJson(path.join(root, "package.json")),
  readJson(path.join(desktopDir, "package.json")),
  readJson(configPath)
]);

const version = desktopPackage.version ?? rootPackage.version ?? "0.0.0";
const arch = normalizeArch(process.env.HTMLSLIDE_PACKAGE_ARCH ?? process.arch);
const channel = process.env.HTMLSLIDE_RELEASE_CHANNEL ?? config.channel ?? "alpha";
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
restoreWorkspaceInstallState();

const plistPath = path.join(appPath, "Contents", "Info.plist");
plistSet(plistPath, "CFBundleName", config.appName);
plistSet(plistPath, "CFBundleDisplayName", config.appName);
plistSet(plistPath, "CFBundleIdentifier", config.bundleIdentifier);
plistSet(plistPath, "CFBundleShortVersionString", version);
plistSet(plistPath, "CFBundleVersion", process.env.GITHUB_RUN_NUMBER ?? version);
plistSet(plistPath, "LSMinimumSystemVersion", config.minimumSystemVersion);
plistDelete(plistPath, "ElectronAsarIntegrity");
writeDeckPackageDocumentTypes(plistPath, config.bundleIdentifier, config.deckPackageDocumentType);

const signing = signAppBundle(appPath, config);

const dmgPath = await createDmg({
  appPath,
  artifactBaseName,
  outputDir,
  volumeName: config.volumeName
});
signDmg(dmgPath, config);
const notarization = notarizeDmg(dmgPath, config);
const zipPath = config.createZip === false ? undefined : createZip({ appPath, artifactBaseName, outputDir });
const manifestPath = path.join(outputDir, `${artifactBaseName}.json`);
const artifacts = [dmgPath, zipPath].filter(Boolean);

await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      appName: config.appName,
      version,
      arch,
      channel,
      bundleIdentifier: config.bundleIdentifier,
      documentTypes: [config.deckPackageDocumentType?.extension ?? "deckpkg"],
      signing,
      notarized: notarization.notarized,
      stapled: notarization.stapled,
      artifacts
    },
    null,
    2
  )}\n`
);

for (const artifact of [...artifacts, manifestPath]) {
  process.stdout.write(`${artifact}\n`);
}
