import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function fileMetadata(filePath) {
  const fileStats = await lstat(filePath);
  if (fileStats.isFile()) {
    const contents = await readFile(filePath);
    return {
      fileName: path.basename(filePath),
      sizeBytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex")
    };
  }
  if (!fileStats.isDirectory()) {
    throw new Error(`Release security input is not a regular file or app bundle: ${path.basename(filePath)}.`);
  }

  const files = await collectBundleFiles(filePath);
  const digest = createHash("sha256");
  let sizeBytes = 0;
  for (const childPath of files.sort()) {
    const relativePath = path.relative(filePath, childPath).split(path.sep).join("/");
    const contents = await readFile(childPath);
    sizeBytes += contents.byteLength;
    digest.update(`${relativePath}\0${contents.byteLength}\0`);
    digest.update(contents);
  }
  return {
    fileName: path.basename(filePath),
    sizeBytes,
    sha256: digest.digest("hex")
  };
}

async function collectBundleFiles(rootPath, currentPath = rootPath) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release security input contains a symlink: ${path.relative(rootPath, entryPath)}.`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectBundleFiles(rootPath, entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else {
      throw new Error(`Release security input contains an unsupported entry: ${path.relative(rootPath, entryPath)}.`);
    }
  }
  return files;
}

function valueFromOutput(output, key) {
  const match = output.match(new RegExp(`^${key}=(.+)$`, "mu"));
  return match?.[1]?.trim();
}

function assertSignatureDisplay(output, { expectedIdentity, expectedBundleIdentifier, expectedTeamIdentifier }) {
  const identity = valueFromOutput(output, "Authority") ?? "";
  const bundleIdentifier = valueFromOutput(output, "Identifier") ?? "";
  const teamIdentifier = valueFromOutput(output, "TeamIdentifier") ?? "";
  if (!identity.startsWith("Developer ID Application:")) {
    throw new Error("Release app signature is not a Developer ID Application signature.");
  }
  if (expectedIdentity && identity !== expectedIdentity) {
    throw new Error("Release app signature identity does not match the configured Developer ID identity.");
  }
  if (expectedBundleIdentifier && bundleIdentifier !== expectedBundleIdentifier) {
    throw new Error("Release app signature bundle identifier does not match the release contract.");
  }
  if (!teamIdentifier) {
    throw new Error("Release app signature is missing a TeamIdentifier.");
  }
  if (expectedTeamIdentifier && teamIdentifier !== expectedTeamIdentifier) {
    throw new Error("Release app signature TeamIdentifier does not match the configured Apple team.");
  }
  if (!/\bruntime\b/u.test(output)) {
    throw new Error("Release app signature is missing the hardened runtime flag.");
  }
  return {
    identity,
    bundleIdentifier,
    teamIdentifier,
    hardenedRuntime: true
  };
}

export async function verifyReleaseSecurity({
  appPath,
  dmgPath,
  manifestPath,
  expectedIdentity,
  expectedTeamIdentifier,
  expectedBundleIdentifier = "app.htmlslide",
  now = new Date().toISOString(),
  runCommand = defaultRunCommand
}) {
  runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const appDisplay = runCommand("codesign", ["--display", "--verbose=4", appPath]);
  const signature = assertSignatureDisplay(appDisplay, {
    expectedIdentity,
    expectedBundleIdentifier,
    expectedTeamIdentifier
  });
  runCommand("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);

  runCommand("codesign", ["--verify", "--strict", "--verbose=4", dmgPath]);
  runCommand("codesign", ["--display", "--verbose=4", dmgPath]);
  runCommand("xcrun", ["stapler", "validate", dmgPath]);
  runCommand("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]);

  const [app, dmg, manifest] = await Promise.all([
    fileMetadata(appPath),
    fileMetadata(dmgPath),
    fileMetadata(manifestPath)
  ]);
  return {
    schemaVersion: "1",
    generatedAt: now,
    checks: [
      { tool: "codesign.app.verify", status: "passed" },
      { tool: "codesign.app.display", status: "passed" },
      { tool: "spctl.app.execute", status: "passed" },
      { tool: "codesign.dmg.verify", status: "passed" },
      { tool: "codesign.dmg.display", status: "passed" },
      { tool: "xcrun.stapler.validate", status: "passed" },
      { tool: "spctl.dmg.open", status: "passed" }
    ],
    signature,
    artifacts: { app, dmg, manifest }
  };
}

export function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    parsed[key] = value;
    if (inlineValue === undefined) index += 1;
  }
  for (const key of ["app", "dmg", "manifest", "evidence"]) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      throw new Error(`Missing required --${key}.`);
    }
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const evidence = await verifyReleaseSecurity({
    appPath: path.resolve(options.app),
    dmgPath: path.resolve(options.dmg),
    manifestPath: path.resolve(options.manifest),
    expectedIdentity: options.identity,
    expectedTeamIdentifier: options.teamId,
    expectedBundleIdentifier: options.bundleIdentifier ?? "app.htmlslide"
  });
  await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Release security evidence written: ${path.basename(options.evidence)}\n`);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
