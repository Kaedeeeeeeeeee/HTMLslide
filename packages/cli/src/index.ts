import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  applyMockAgentProject,
  applyAgentSourceWrites,
  createAnthropicProvider,
  createFileCopyCheckpoint,
  createMockProvider,
  createOpenAICompatibleProvider,
  diffFileCopyCheckpoint,
  mockEngines,
  normalizeAgentSourceWrites,
  recordCheckpointChanges,
  revertFileCopyCheckpoint,
  runAgent,
  sanitizeProviderText,
  type AgentRunResult,
  type AgentRunErrorInfo,
  type AgentRunStage,
  type AgentSourceWrite,
  type ApplyMockAgentProjectResult,
  type CredentialStatus,
  type FetchLike,
  type FileCopyCheckpointDiff,
  type FileCopyCheckpointRevertResult,
  type ModelProvider
} from "@htmlslide/agent";
import {
  exportDeck,
  inspectChromiumRuntime,
  type CompilerProjectInput,
  type ExportOptions,
  type ExportResult
} from "@htmlslide/compiler";
import {
  ExportManifestSchema,
  loadDeckProject,
  normalizeSpeakerNotesMode,
  ProjectLoadError,
  type Deck,
  type LoadedDeckProject,
  type SpeakerNotesMode
} from "@htmlslide/core";
import { renderBuiltInDeckTemplate, type DeckTemplateId } from "@htmlslide/core/templates";
import { AGENT_RUN_REPORT_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import { checkProject, type CheckReport } from "@htmlslide/linter";
import { validateDeckPackage, type DeckPackageValidationResult } from "@htmlslide/presenter";

export const EXIT_CODES = {
  success: 0,
  generic: 1,
  validationFailed: 2,
  exportFailed: 3,
  missingDependency: 4,
  permissionDenied: 5,
  agentFailed: 6,
  projectNotFound: 7,
  incompatibleSchema: 8
} as const;

const CHROMIUM_EXECUTABLE_ENV = "HTMLSLIDE_CHROMIUM_EXECUTABLE";
const BROWSER_RUNTIME_CONFIG_FILE = "browser-runtime.json";
const MAX_BROWSER_RUNTIME_CONFIG_BYTES = 16 * 1024;

export type CliBrowserRuntimeState = {
  available: boolean;
  executablePath?: string;
  message: string;
  source: "environment" | "packaged" | "unconfigured";
};

export type CliBrowserRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
};

const cliRuntimeRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const validateChromiumExecutable = async (executablePath: string): Promise<string> => {
  const resolved = path.resolve(executablePath);
  const entry = await lstat(resolved).catch(() => undefined);
  if (!entry?.isFile()) {
    throw new Error(`Chromium runtime executable is missing or is not a regular file: ${resolved}`);
  }
  await access(resolved, fsConstants.X_OK).catch(() => {
    throw new Error(`Chromium runtime executable is not executable: ${resolved}`);
  });
  return resolved;
};

export const configureCliBrowserRuntime = async (
  options: CliBrowserRuntimeOptions = {}
): Promise<CliBrowserRuntimeState> => {
  const env = options.env ?? process.env;
  const configuredExecutable = env[CHROMIUM_EXECUTABLE_ENV]?.trim();
  if (configuredExecutable) {
    const executablePath = await validateChromiumExecutable(configuredExecutable);
    return {
      available: true,
      executablePath,
      message: `Chromium runtime configured at ${executablePath}.`,
      source: "environment"
    };
  }

  const runtimeRoot = path.resolve(options.runtimeRoot ?? cliRuntimeRoot());
  const configPath = path.join(runtimeRoot, BROWSER_RUNTIME_CONFIG_FILE);
  const configEntry = await lstat(configPath).catch(() => undefined);
  if (!configEntry) {
    return {
      available: false,
      message: "No packaged Chromium runtime is configured; the compiler will use the local Playwright installation.",
      source: "unconfigured"
    };
  }
  if (!configEntry.isFile() || configEntry.size > MAX_BROWSER_RUNTIME_CONFIG_BYTES) {
    throw new Error(`Invalid packaged Chromium runtime configuration: ${configPath}`);
  }

  const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
    executablePath?: unknown;
    schemaVersion?: unknown;
  };
  if (parsed.schemaVersion !== 1 || typeof parsed.executablePath !== "string" || parsed.executablePath.length === 0) {
    throw new Error(`Invalid packaged Chromium runtime configuration: ${configPath}`);
  }
  if (path.isAbsolute(parsed.executablePath) || parsed.executablePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Packaged Chromium executable path must stay inside the CLI runtime: ${parsed.executablePath}`);
  }

  const executablePath = path.resolve(runtimeRoot, ...parsed.executablePath.split("/"));
  const relative = path.relative(runtimeRoot, executablePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Packaged Chromium executable path escapes the CLI runtime: ${parsed.executablePath}`);
  }
  const validatedExecutable = await validateChromiumExecutable(executablePath);
  const [realRuntimeRoot, realExecutablePath] = await Promise.all([
    realpath(runtimeRoot),
    realpath(validatedExecutable)
  ]);
  const realRelative = path.relative(realRuntimeRoot, realExecutablePath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Packaged Chromium executable resolves outside the CLI runtime: ${parsed.executablePath}`);
  }
  env[CHROMIUM_EXECUTABLE_ENV] = validatedExecutable;
  return {
    available: true,
    executablePath: validatedExecutable,
    message: `Packaged Chromium runtime configured at ${validatedExecutable}.`,
    source: "packaged"
  };
};

export type LoadedProject = {
  projectPath: string;
  manifest: Deck;
};

export type CreateProjectOptions = {
  speakerNotesMode?: SpeakerNotesMode;
  templateId?: DeckTemplateId | string;
};

export type ProjectLoadResult =
  | {
      ok: true;
      project: LoadedProject;
    }
  | {
      ok: false;
      exitCode: number;
      report: CheckReport;
    };

export type AgentRunCliOptions = {
  engine: string;
  task: string;
  projectPath?: string;
  speakerNotesMode?: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  targetSlideCount?: number;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  checkProject?: (project: LoadedProject) => Promise<CheckReport>;
  exportProject?: (project: LoadedProject) => Promise<ExportResult>;
};

export type AppliedProviderAgentSourceWrites = {
  projectPath: string;
  source: "provider-source-writes";
  filesChanged: string[];
  writeCount: number;
  stages: Array<{
    stage: Extract<AgentRunStage, "build" | "repair">;
    attempt?: number;
    filesChanged: string[];
    writeCount: number;
  }>;
};

export type AgentRunExportManifestSummary = {
  sourceDigest: string;
  artifactCount: number;
  sha256: string;
};

export type AgentRunCliResult = AgentRunResult & {
  projectPath?: string;
  provider?: AgentProviderKind;
  providerId?: "htmlslide-byok";
  model?: string;
  baseUrl?: string;
  targetSlideCount?: number;
  applied?: ApplyMockAgentProjectResult | AppliedProviderAgentSourceWrites;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: CheckReport;
  export?: ExportResult;
  exportManifest?: AgentRunExportManifestSummary;
  reportPath?: string;
};

export type AgentProviderKind = "openai" | "anthropic" | "compatible";

export type AgentProviderValidationOptions = {
  provider: string;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
};

export type AgentProviderValidationResult = {
  status: "passed" | "failed";
  command: "agent validate-provider";
  provider: AgentProviderKind;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  credential: CredentialStatus;
  secretRecorded: false;
  exitCode: 0 | typeof EXIT_CODES.agentFailed;
};

export type CheckpointCliOptions = {
  projectPath?: string;
  runId?: string;
  checkpointId?: string;
};

export type CliShimTargetOptions = {
  targetDir?: string;
  targetPath?: string;
  htmlslideHomeDir?: string;
};

export type CliShimInstallOptions = CliShimTargetOptions & {
  appPath?: string;
  appVersion?: string;
  bundleId?: string;
  fallbackCliPath?: string;
  updatedAt?: string;
};

export type CliShimResult = {
  status: "passed";
  command: "setup install-cli" | "setup uninstall-cli";
  action: "installed" | "updated" | "removed" | "unchanged";
  targetPath: string;
  targetDir: string;
  htmlslideHomeDir: string;
  appPathJson?: string;
  message: string;
};

export type CliShimStatus = {
  status: "passed" | "info" | "warning" | "failed";
  installed: boolean;
  managed: boolean;
  targetPath: string;
  targetDir: string;
  htmlslideHomeDir: string;
  onPath: boolean;
  message: string;
  suggestedFix?: string;
};

export type DesktopAppPathConfig = {
  schemaVersion: 1;
  appPath: string;
  bundleId?: string;
  version?: string;
  updatedAt?: string;
};

export type DesktopLaunchTargetKind = "project" | "deckpkg";

export type DesktopLaunchOptions = {
  htmlslideHomeDir?: string;
  platform?: NodeJS.Platform;
  appPath?: string;
  runOpen?: (executable: string, args: readonly string[]) => Promise<void>;
};

export type DesktopLaunchResult = {
  status: "passed";
  command: "open" | "present";
  appPath: string;
  targetPath: string;
  targetKind: DesktopLaunchTargetKind;
};

export type PackageProjectResult = Awaited<ReturnType<typeof exportLoadedProject>> & {
  command: "package";
  deckpkgPath: string;
};

const HTMLSLIDE_SHIM_MARKER = "HTMLslide managed CLI shim v1";
const HTMLSLIDE_HOME_ENV = "HTMLSLIDE_HOME";
const execFileAsync = promisify(execFile);

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const setupError = (
  code: string,
  message: string,
  exitCode: number,
  suggestedFix: string,
  extra?: Record<string, unknown>
): Error =>
  Object.assign(new Error(message), {
    code,
    exitCode,
    suggestedFix,
    ...extra
  });

const resolveHtmlslideHomeDir = (htmlslideHomeDir?: string): string =>
  path.resolve(htmlslideHomeDir ?? process.env[HTMLSLIDE_HOME_ENV] ?? path.join(os.homedir(), ".htmlslide"));

const resolveCliShimTarget = (options: CliShimTargetOptions = {}) => {
  if (options.targetDir && options.targetPath) {
    throw setupError(
      "CLI_TARGET_AMBIGUOUS",
      "Pass either --target-dir or --target-path, not both.",
      EXIT_CODES.generic,
      "Choose a target directory for htmlslide or a complete target path."
    );
  }

  const htmlslideHomeDir = resolveHtmlslideHomeDir(options.htmlslideHomeDir);
  const targetPath = options.targetPath
    ? path.resolve(options.targetPath)
    : path.join(options.targetDir ? path.resolve(options.targetDir) : path.join(htmlslideHomeDir, "bin"), "htmlslide");

  return {
    targetPath,
    targetDir: path.dirname(targetPath),
    htmlslideHomeDir,
    explicit: Boolean(options.targetDir || options.targetPath)
  };
};

const defaultFallbackCliPath = (): string => {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const packageRoot = ["src", "dist"].includes(path.basename(moduleDir)) ? path.dirname(moduleDir) : moduleDir;
  return path.join(packageRoot, "dist", "bin", "htmlslide.js");
};

const appPathConfigPath = (htmlslideHomeDir: string): string => path.join(htmlslideHomeDir, "app-path.json");

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readDesktopAppPathConfig = async (
  htmlslideHomeDir?: string
): Promise<DesktopAppPathConfig> => {
  const homeDir = resolveHtmlslideHomeDir(htmlslideHomeDir);
  const configPath = appPathConfigPath(homeDir);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw setupError(
        "DESKTOP_APP_NOT_CONFIGURED",
        `HTMLslide desktop app is not configured at ${configPath}.`,
        EXIT_CODES.missingDependency,
        "Open HTMLslide.app once or run htmlslide setup install-cli --app-path <HTMLslide.app>."
      );
    }
    throw setupError(
      "DESKTOP_APP_CONFIG_INVALID",
      `HTMLslide desktop app configuration is invalid at ${configPath}.`,
      EXIT_CODES.missingDependency,
      "Open HTMLslide.app to repair CLI integration.",
      { cause: error }
    );
  }

  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.appPath !== "string" ||
    value.appPath.trim().length === 0
  ) {
    throw setupError(
      "DESKTOP_APP_CONFIG_INVALID",
      `HTMLslide desktop app configuration is invalid at ${configPath}.`,
      EXIT_CODES.missingDependency,
      "Open HTMLslide.app to repair CLI integration."
    );
  }

  const optionalString = (key: "bundleId" | "version" | "updatedAt"): string | undefined => {
    const entry = value[key];
    return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
  };

  return {
    schemaVersion: 1,
    appPath: path.resolve(value.appPath),
    bundleId: optionalString("bundleId"),
    version: optionalString("version"),
    updatedAt: optionalString("updatedAt")
  };
};

const defaultOpenRunner = async (executable: string, args: readonly string[]): Promise<void> => {
  await execFileAsync(executable, [...args]);
};

export const launchDesktopTarget = async (
  command: DesktopLaunchResult["command"],
  targetPath: string,
  targetKind: DesktopLaunchTargetKind,
  options: DesktopLaunchOptions = {}
): Promise<DesktopLaunchResult> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw setupError(
      "DESKTOP_LAUNCH_UNSUPPORTED",
      `HTMLslide desktop launch is not supported on ${platform}.`,
      EXIT_CODES.missingDependency,
      "Run this command on macOS, or use htmlslide check/export in headless environments."
    );
  }

  const appPath = options.appPath
    ? path.resolve(options.appPath)
    : (await readDesktopAppPathConfig(options.htmlslideHomeDir)).appPath;
  let appStats;
  try {
    appStats = await lstat(appPath);
  } catch (error) {
    throw setupError(
      "DESKTOP_APP_MISSING",
      `Configured HTMLslide desktop app was not found at ${appPath}.`,
      EXIT_CODES.missingDependency,
      "Open the installed HTMLslide.app to repair CLI integration.",
      { cause: error }
    );
  }
  if (!appStats.isDirectory() || !appPath.endsWith(".app")) {
    throw setupError(
      "DESKTOP_APP_INVALID",
      `Configured HTMLslide desktop app is not a macOS application bundle: ${appPath}.`,
      EXIT_CODES.missingDependency,
      "Reinstall HTMLslide.app and open it once to repair CLI integration."
    );
  }

  const resolvedTargetPath = path.resolve(targetPath);
  let targetStats;
  try {
    targetStats = await lstat(resolvedTargetPath);
  } catch (error) {
    throw setupError(
      targetKind === "project" ? "PROJECT_NOT_FOUND" : "DECK_PACKAGE_NOT_FOUND",
      `Launch target was not found at ${resolvedTargetPath}.`,
      targetKind === "project" ? EXIT_CODES.projectNotFound : EXIT_CODES.validationFailed,
      targetKind === "project" ? "Pass a valid HTMLslide project directory." : "Pass an existing .deckpkg file.",
      { cause: error }
    );
  }
  if (
    (targetKind === "project" && !targetStats.isDirectory()) ||
    (targetKind === "deckpkg" && (!targetStats.isFile() || !resolvedTargetPath.endsWith(".deckpkg")))
  ) {
    throw setupError(
      "DESKTOP_LAUNCH_TARGET_INVALID",
      `Launch target is not a valid ${targetKind}: ${resolvedTargetPath}.`,
      EXIT_CODES.validationFailed,
      targetKind === "project" ? "Pass a valid HTMLslide project directory." : "Pass an existing .deckpkg file."
    );
  }

  const runOpen = options.runOpen ?? defaultOpenRunner;
  try {
    await runOpen("/usr/bin/open", ["-a", appPath, resolvedTargetPath]);
  } catch (error) {
    throw setupError(
      "DESKTOP_LAUNCH_FAILED",
      `Unable to launch HTMLslide.app for ${resolvedTargetPath}.`,
      EXIT_CODES.missingDependency,
      "Open HTMLslide.app manually, then rerun the command.",
      { cause: error }
    );
  }

  return {
    status: "passed",
    command,
    appPath,
    targetPath: resolvedTargetPath,
    targetKind
  };
};

const readExistingShim = async (
  targetPath: string
): Promise<{ exists: false } | { exists: true; managed: boolean; kind: "file" | "directory" | "symlink" | "other" }> => {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isFile()) {
      return {
        exists: true,
        managed: false,
        kind: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other"
      };
    }

    const content = await readFile(targetPath, "utf8");
    return {
      exists: true,
      managed: content.includes(HTMLSLIDE_SHIM_MARKER),
      kind: "file"
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
};

const escapeShimString = (value: string): string => JSON.stringify(value);

const cliShimScript = (fallbackCliPath: string): string => `#!/usr/bin/env node
// ${HTMLSLIDE_SHIM_MARKER}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fallbackCliPath = ${escapeShimString(path.resolve(fallbackCliPath))};

const unique = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];

const readAppPathConfig = () => {
  const htmlslideHomeDir = process.env.HTMLSLIDE_HOME || path.join(os.homedir(), ".htmlslide");
  const configPath = path.join(htmlslideHomeDir, "app-path.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error("HTMLslide CLI shim could not parse " + configPath + ": " + error.message);
    process.exit(4);
  }
};

const appCliCandidates = (config) => {
  const appPath = config && config.appPath ? String(config.appPath) : "";
  return unique([
    config && config.cliPath,
    config && config.cliEntry,
    config && config.appCliPath,
    appPath && path.join(appPath, "Contents", "Resources", "app", "cli-runtime", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "app", "packages", "cli", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "app.asar", "packages", "cli", "dist", "bin", "htmlslide.js"),
    appPath && path.join(appPath, "Contents", "Resources", "htmlslide", "cli", "htmlslide.js")
  ]);
};

const candidates = unique([...appCliCandidates(readAppPathConfig()), fallbackCliPath]);
const cliPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!cliPath) {
  console.error("HTMLslide CLI shim could not locate the CLI entrypoint.");
  console.error("Run htmlslide setup install-cli from the HTMLslide app, or reinstall the CLI shim.");
  process.exit(4);
}

if (path.resolve(cliPath) === path.resolve(process.argv[1])) {
  console.error("HTMLslide CLI shim resolved to itself. Reinstall the CLI shim with a valid app or development CLI path.");
  process.exit(4);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error("HTMLslide CLI shim failed to start: " + result.error.message);
  process.exit(4);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`;

const ensureWritableDir = async (targetDir: string): Promise<void> => {
  try {
    await mkdir(targetDir, { recursive: true });
    await access(targetDir, fsConstants.W_OK);
  } catch (error) {
    throw setupError(
      "CLI_TARGET_NOT_WRITABLE",
      `Cannot write HTMLslide CLI shim to ${targetDir}.`,
      EXIT_CODES.permissionDenied,
      "Choose a writable target directory, for example ~/.htmlslide/bin, or fix directory permissions.",
      { cause: error, targetDir }
    );
  }
};

export const getCliShimStatus = async (options: CliShimTargetOptions = {}): Promise<CliShimStatus> => {
  const target = resolveCliShimTarget(options);
  const existing = await readExistingShim(target.targetPath);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry || "."));
  const onPath = pathEntries.includes(path.resolve(target.targetDir));

  if (!existing.exists) {
    return {
      status: "info",
      installed: false,
      managed: false,
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      onPath,
      message: `HTMLslide CLI shim is not installed at ${target.targetPath}.`,
      suggestedFix: "Run htmlslide setup install-cli."
    };
  }

  if (!existing.managed) {
    return {
      status: "failed",
      installed: true,
      managed: false,
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      onPath,
      message: `${target.targetPath} exists but is not an HTMLslide-managed shim.`,
      suggestedFix: "Choose another --target-path or remove the unrelated command manually."
    };
  }

  return {
    status: onPath ? "passed" : "warning",
    installed: true,
    managed: true,
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    onPath,
    message: onPath
      ? `HTMLslide CLI shim is installed at ${target.targetPath}.`
      : `HTMLslide CLI shim is installed at ${target.targetPath}, but ${target.targetDir} is not on PATH.`,
    suggestedFix: onPath ? undefined : `Add ${target.targetDir} to PATH.`
  };
};

export const installCliShim = async (options: CliShimInstallOptions = {}): Promise<CliShimResult> => {
  const target = resolveCliShimTarget(options);
  await ensureWritableDir(target.targetDir);

  const existing = await readExistingShim(target.targetPath);
  if (existing.exists && !existing.managed) {
    throw setupError(
      "CLI_SHIM_CONFLICT",
      `Refusing to overwrite existing non-HTMLslide command at ${target.targetPath}.`,
      EXIT_CODES.generic,
      "Choose another --target-path or remove the unrelated command manually.",
      { targetPath: target.targetPath }
    );
  }

  let appPathJson: string | undefined;
  if (options.appPath) {
    const appPath = path.resolve(options.appPath);
    appPathJson = appPathConfigPath(target.htmlslideHomeDir);
    await mkdir(path.dirname(appPathJson), { recursive: true });
    await writeFile(
      appPathJson,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appPath,
          bundleId: options.bundleId,
          version: options.appVersion,
          updatedAt: options.updatedAt ?? new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
  }

  const fallbackCliPath = options.fallbackCliPath ? path.resolve(options.fallbackCliPath) : defaultFallbackCliPath();
  const temporaryPath = path.join(target.targetDir, `.htmlslide-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporaryPath, cliShimScript(fallbackCliPath), { mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, target.targetPath);

  const action = existing.exists ? "updated" : "installed";
  return {
    status: "passed",
    command: "setup install-cli",
    action,
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    appPathJson,
    message: `${action === "installed" ? "Installed" : "Updated"} HTMLslide CLI shim at ${target.targetPath}.`
  };
};

export const uninstallCliShim = async (options: CliShimTargetOptions = {}): Promise<CliShimResult> => {
  const target = resolveCliShimTarget(options);
  const existing = await readExistingShim(target.targetPath);

  if (!existing.exists) {
    return {
      status: "passed",
      command: "setup uninstall-cli",
      action: "unchanged",
      targetPath: target.targetPath,
      targetDir: target.targetDir,
      htmlslideHomeDir: target.htmlslideHomeDir,
      message: `No HTMLslide CLI shim was installed at ${target.targetPath}.`
    };
  }

  if (!existing.managed) {
    throw setupError(
      "CLI_SHIM_CONFLICT",
      `Refusing to remove existing non-HTMLslide command at ${target.targetPath}.`,
      EXIT_CODES.generic,
      "Choose the correct --target-path or remove the unrelated command manually.",
      { targetPath: target.targetPath }
    );
  }

  await rm(target.targetPath);
  return {
    status: "passed",
    command: "setup uninstall-cli",
    action: "removed",
    targetPath: target.targetPath,
    targetDir: target.targetDir,
    htmlslideHomeDir: target.htmlslideHomeDir,
    message: `Removed HTMLslide CLI shim from ${target.targetPath}.`
  };
};

const ensureProjectDirs = async (projectPath: string): Promise<void> => {
  await Promise.all([
    mkdir(path.join(projectPath, "slides"), { recursive: true }),
    mkdir(path.join(projectPath, "notes"), { recursive: true }),
    mkdir(path.join(projectPath, "theme"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "images"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "fonts"), { recursive: true }),
    mkdir(path.join(projectPath, "assets", "data"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "cache"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "checkpoints"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "logs"), { recursive: true }),
    mkdir(path.join(projectPath, ".htmlslide", "reports"), { recursive: true })
  ]);
};

export const createProject = async (
  projectPath: string,
  name: string,
  options: CreateProjectOptions = {}
): Promise<LoadedProject> => {
  const resolvedProjectPath = path.resolve(projectPath);
  await mkdir(resolvedProjectPath, { recursive: true });
  const deckPath = path.join(resolvedProjectPath, "deck.json");
  if (await exists(deckPath)) {
    throw new Error(`deck.json already exists at ${deckPath}`);
  }

  const template = renderBuiltInDeckTemplate({
    name,
    speakerNotesMode: options.speakerNotesMode,
    templateId: options.templateId
  });
  const manifest = template.manifest;
  await ensureProjectDirs(resolvedProjectPath);
  for (const file of template.files) {
    const filePath = path.join(resolvedProjectPath, file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents);
  }

  return { projectPath: resolvedProjectPath, manifest };
};

export const loadProject = async (projectPath = process.cwd()): Promise<LoadedProject> => {
  try {
    const project = await loadDeckProject(projectPath, { verifyFiles: false });
    return fromCoreProject(project);
  } catch (error) {
    if (error instanceof ProjectLoadError) {
      throw Object.assign(error, {
        exitCode: exitCodeForProjectLoadError(error)
      });
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      exitCode: EXIT_CODES.validationFailed
    });
  }
};

export const tryLoadProjectForCheck = async (projectPath = process.cwd()): Promise<ProjectLoadResult> => {
  try {
    return {
      ok: true,
      project: await loadProject(projectPath)
    };
  } catch (error) {
    if (error instanceof ProjectLoadError) {
      const issueSummary = error.issues.reduce(
        (summary, issue) => {
          if (issue.severity === "error") {
            summary.errors += 1;
          } else if (issue.severity === "warning") {
            summary.warnings += 1;
          } else {
            summary.info += 1;
          }
          return summary;
        },
        { errors: 0, warnings: 0, info: 0 }
      );
      const report: CheckReport = {
        status: "failed",
        projectPath: path.resolve(projectPath),
        summary: {
          errors: Math.max(issueSummary.errors, 1),
          warnings: issueSummary.warnings,
          suggestions: 0,
          info: issueSummary.info
        },
        issues:
          error.issues.length > 0
            ? error.issues.map((issue) => ({
                slideId: issue.slideId ?? "deck",
                severity: issue.severity,
                type: issue.type,
                message: issue.message,
                path: issue.path,
                selector: issue.selector,
                suggestedFix: issue.suggestedFix ?? "Fix the project manifest and rerun htmlslide check.",
                agentInstruction:
                  issue.suggestedFix ?? "Inspect deck.json and referenced source files, then fix the reported load error."
              }))
            : [
                {
                  slideId: "deck",
                  severity: "error",
                  type: "missing-slide-source",
                  message: error.message,
                  suggestedFix: "Run htmlslide from a deck project or pass a path containing deck.json.",
                  agentInstruction: "Locate the deck project root before running check or export."
                }
              ]
      };
      return {
        ok: false,
        exitCode: exitCodeForProjectLoadError(error),
        report
      };
    }
    throw error;
  }
};

const exitCodeForProjectLoadError = (error: ProjectLoadError): number => {
  if (error.code === "PROJECT_NOT_FOUND") {
    return EXIT_CODES.projectNotFound;
  }
  if (error.code === "PERMISSION_DENIED") {
    return EXIT_CODES.permissionDenied;
  }

  return error.code === "INCOMPATIBLE_SCHEMA" ? EXIT_CODES.incompatibleSchema : EXIT_CODES.validationFailed;
};

const fromCoreProject = (project: LoadedDeckProject): LoadedProject => ({
  projectPath: project.projectRoot,
  manifest: project.deck
});

const toCompilerInput = (project: LoadedProject): CompilerProjectInput => ({
  projectPath: project.projectPath,
  title: project.manifest.title,
  language: project.manifest.language,
  viewport: project.manifest.viewport,
  safeArea: project.manifest.safeArea,
  themeCssPath: project.manifest.theme?.css,
  themeTokensPath: project.manifest.theme?.tokens,
  slides: project.manifest.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    sourcePath: slide.source,
    notesPath: slide.notes,
    durationSec: slide.durationSec
  }))
});

export const checkLoadedProject = async (project: LoadedProject): Promise<CheckReport> =>
  checkProject({
    projectPath: project.projectPath,
    writeReport: true,
    slides: project.manifest.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      sourcePath: slide.source,
      notesPath: slide.notes
    }))
  });

export const resolveProjectExportOptions = (
  project: LoadedProject,
  options: ExportOptions = {}
): ExportOptions => ({
  ...options,
  deckpkg: options.deckpkg ?? project.manifest.export.deckpkg,
  html: options.html ?? project.manifest.export.html,
  pdf: options.pdf ?? project.manifest.export.pdf,
  thumbnails: options.thumbnails ?? project.manifest.export.thumbnails
});

export const exportLoadedProject = async (project: LoadedProject, options?: ExportOptions) =>
  exportDeck(toCompilerInput(project), resolveProjectExportOptions(project, options));

export const packageLoadedProject = async (project: LoadedProject): Promise<PackageProjectResult> => {
  const result = await exportLoadedProject(project, {
    pdf: false,
    html: false,
    deckpkg: true,
    thumbnails: false
  });
  const deckpkgPath = result.artifacts.deckpkg;
  if (!deckpkgPath) {
    throw setupError(
      "DECK_PACKAGE_EXPORT_MISSING",
      "The compiler completed without returning a deck package path.",
      EXIT_CODES.exportFailed,
      "Rerun htmlslide package. If the issue persists, rebuild HTMLslide and inspect the compiler report."
    );
  }
  return {
    command: "package",
    deckpkgPath,
    ...result
  };
};

export const validateDeckPackageForPresentation = async (
  deckpkgPath: string
): Promise<DeckPackageValidationResult & { deckpkgPath: string }> => {
  const resolvedDeckpkgPath = path.resolve(deckpkgPath);
  const result = await validateDeckPackage(resolvedDeckpkgPath);
  if (result.status === "failed" || !result.deckPackage) {
    throw Object.assign(new Error(`Deck package validation failed for ${resolvedDeckpkgPath}.`), {
      code: "DECK_PACKAGE_INVALID",
      exitCode: EXIT_CODES.validationFailed,
      suggestedFix: "Rebuild the package with htmlslide package and resolve the reported package issues.",
      issues: result.issues,
      summary: result.summary
    });
  }
  return {
    ...result,
    deckpkgPath: resolvedDeckpkgPath
  };
};

export const doctor = async (options: CliShimTargetOptions = {}) => {
  const cliShim = await getCliShimStatus(options);
  const chromium = await inspectChromiumRuntime();
  const status = chromium.available && cliShim.status !== "failed" ? "passed" as const : "failed" as const;

  return {
    status,
    app: "HTMLslide",
    version: HTMLSLIDE_APP_VERSION,
    checks: [
      {
        id: "node",
        status: "passed",
        message: `Node.js ${process.version}`
      },
      {
        id: "filesystem",
        status: "passed",
        message: "Local filesystem access available"
      },
      {
        id: "chromium",
        status: chromium.available ? "passed" : "failed",
        message: chromium.available
          ? `Chromium ${chromium.version} available at ${chromium.executablePath}`
          : `Chromium is unavailable at ${chromium.executablePath}: ${chromium.error}`,
        suggestedFix: chromium.available
          ? undefined
          : "Install the Playwright Chromium build or reinstall HTMLslide.app."
      },
      {
        id: "cli-shim",
        status: cliShim.status,
        message: cliShim.message,
        targetPath: cliShim.targetPath,
        suggestedFix: cliShim.suggestedFix
      },
      {
        id: "ai",
        status: "info",
        message: "No AI provider is required for No AI mode"
      }
    ]
  };
};

const providerBackedEngineIds = new Set(["htmlslide-byok", "htmlslide-byok-openai"]);

export const listAgentEngines = () => [
  ...mockEngines.map((engine) =>
    engine.id === "htmlslide-byok-openai" ? { ...engine, available: true } : engine
  ),
  {
    id: "htmlslide-byok",
    label: "HTMLslide Agent (BYOK)",
    mode: "byok" as const,
    available: true
  }
];

const agentError = (
  code: string,
  message: string,
  suggestedFix: string,
  extra?: Record<string, unknown>
): Error =>
  Object.assign(new Error(message), {
    code,
    exitCode: EXIT_CODES.agentFailed,
    suggestedFix,
    ...extra
  });

const agentProviderKinds: AgentProviderKind[] = ["openai", "anthropic", "compatible"];
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const normalizeCompatibleProviderBaseUrl = (value: string | undefined): string => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_INVALID",
      "Compatible provider base URL must be an absolute HTTP(S) URL.",
      "Rerun with --base-url set to a URL such as https://api.example.com/v1."
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_INVALID",
      "Compatible provider base URL must not contain credentials, query parameters, or fragments.",
      "Use an HTTPS API root without embedded credentials, query parameters, or fragments."
    );
  }

  return parsed.toString().replace(/\/+$/u, "");
};

const normalizeAgentProviderKind = (provider: string): AgentProviderKind => {
  const normalized = provider.trim().toLowerCase();
  if (agentProviderKinds.includes(normalized as AgentProviderKind)) {
    return normalized as AgentProviderKind;
  }

  throw agentError(
    "AGENT_PROVIDER_NOT_FOUND",
    `Unknown provider: ${provider}.`,
    "Pass --provider openai, --provider anthropic, or --provider compatible.",
    { provider }
  );
};

const requireTrimmedAgentOption = (value: string, code: string, message: string, suggestedFix: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw agentError(code, message, suggestedFix);
  }
  return trimmed;
};

const normalizeTargetSlideCount = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw agentError(
      "AGENT_TARGET_SLIDE_COUNT_INVALID",
      "Target slide count must be a positive integer.",
      "Rerun with --target-slide-count set to a positive integer."
    );
  }
  return value;
};

type ResolvedAgentProvider = {
  provider: AgentProviderKind;
  model: string;
  apiKeyEnv: string;
  apiKey: string;
  baseUrl?: string;
  modelProvider: ModelProvider;
};

const resolveAgentProvider = (options: AgentProviderValidationOptions): ResolvedAgentProvider => {
  const provider = normalizeAgentProviderKind(options.provider);
  const model = requireTrimmedAgentOption(
    options.model,
    "AGENT_PROVIDER_MODEL_REQUIRED",
    "Pass a provider model id.",
    "Rerun with --model set to the exact model you want to validate."
  );
  const apiKeyEnv = requireTrimmedAgentOption(
    options.apiKeyEnv,
    "AGENT_PROVIDER_API_KEY_ENV_REQUIRED",
    "Pass the environment variable name that contains the provider API key.",
    "Set --api-key-env OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider-owned environment variable."
  );

  if (!envNamePattern.test(apiKeyEnv)) {
    throw agentError(
      "AGENT_PROVIDER_API_KEY_ENV_INVALID",
      "Invalid API key environment variable name.",
      "Use a shell environment variable name such as OPENAI_API_KEY or ANTHROPIC_API_KEY."
    );
  }

  const baseUrl = provider === "compatible"
    ? normalizeCompatibleProviderBaseUrl(options.baseUrl)
    : options.baseUrl?.trim().replace(/\/+$/u, "");
  if (provider === "compatible" && (!baseUrl || baseUrl.length === 0)) {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_REQUIRED",
      "OpenAI-compatible provider validation requires --base-url.",
      "Rerun with --base-url set to the compatible provider API root, for example https://api.example.com/v1.",
      { provider }
    );
  }

  if (provider !== "compatible" && baseUrl && baseUrl.length > 0) {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_UNSUPPORTED",
      `--base-url is only supported for the compatible provider, not ${provider}.`,
      "Use --provider compatible for custom OpenAI-compatible API roots.",
      { provider }
    );
  }

  const env = options.env ?? process.env;
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw agentError(
      "AGENT_PROVIDER_API_KEY_ENV_MISSING",
      `Environment variable ${apiKeyEnv} is not set or is empty.`,
      "Export the provider API key in that environment variable, then rerun the command. Do not paste API keys into CLI arguments.",
      { apiKeyEnv }
    );
  }

  const label = `HTMLslide Agent (${provider} / ${model})`;
  const modelProvider = provider === "anthropic"
    ? createAnthropicProvider({
        apiKey,
        fetch: options.fetch,
        id: "htmlslide-byok",
        label,
        model
      })
    : createOpenAICompatibleProvider({
        apiKey,
        baseUrl: provider === "compatible" ? baseUrl : undefined,
        fetch: options.fetch,
        id: "htmlslide-byok",
        label,
        model
      });

  return {
    provider,
    model,
    apiKeyEnv,
    apiKey,
    ...(provider === "compatible" ? { baseUrl } : {}),
    modelProvider
  };
};

const validateResolvedAgentProvider = async (
  resolved: ResolvedAgentProvider
): Promise<CredentialStatus> => {
  try {
    return await resolved.modelProvider.validateCredentials();
  } catch (error) {
    return {
      ok: false,
      providerId: resolved.modelProvider.id,
      reason: sanitizeProviderText(error instanceof Error ? error.message : String(error), [resolved.apiKey]),
      recoverable: true
    };
  }
};

const providerCredentialFailure = (
  resolved: ResolvedAgentProvider,
  credential: CredentialStatus
): Error => agentError(
  "AGENT_PROVIDER_CREDENTIALS_INVALID",
  credential.ok
    ? "Provider credential validation failed."
    : credential.reason,
  "Resolve the provider credential/model or endpoint, then rerun the agent.",
  {
    apiKeyEnv: resolved.apiKeyEnv,
    model: resolved.model,
    provider: resolved.provider
  }
);

const deterministicAgentClock = () => new Date("2026-01-01T00:00:00.000Z");

export const runAgentTask = async (options: AgentRunCliOptions): Promise<AgentRunCliResult> => {
  const engine = mockEngines.find((candidate) => candidate.id === options.engine);
  const providerBacked = providerBackedEngineIds.has(options.engine);
  if (engine === undefined && !providerBacked) {
    throw agentError(
      "AGENT_ENGINE_NOT_FOUND",
      `Unknown agent engine: ${options.engine}.`,
      "Run htmlslide agent engines --json and pass one of the listed engine ids.",
      { engine: options.engine }
    );
  }

  if (engine !== undefined && engine.id !== "htmlslide-mock") {
    if (providerBackedEngineIds.has(engine.id)) {
      return runProviderBackedAgentTask(options);
    }
    throw agentError(
      "AGENT_ENGINE_UNAVAILABLE",
      `Agent engine ${engine.id} is not available from the CLI yet.`,
      "Use --engine htmlslide-mock for deterministic local test runs.",
      { engine: engine.id }
    );
  }

  if (providerBacked) {
    return runProviderBackedAgentTask(options);
  }

  const projectPath = path.resolve(options.projectPath ?? process.cwd());
  const speakerNotesMode = normalizeSpeakerNotesMode(options.speakerNotesMode);
  const result = await runAgent(
    {
      projectRoot: projectPath,
      brief: options.task,
      provider: createMockProvider(),
      createCheckpoint: createFileCopyCheckpoint,
      speakerNotesMode
    },
    {
      clock: deterministicAgentClock
    }
  );

  if (!result.ok) {
    return result;
  }

  const applied = await applyMockAgentProject({
    brief: options.task,
    projectPath,
    result
  });
  const checkpoint = await recordCheckpointChanges({
    projectRoot: projectPath,
    runId: result.runId,
    filesChanged: applied.filesChanged,
    recordedAt: deterministicAgentClock().toISOString()
  });

  return {
    ...result,
    checkpoint,
    applied
  };
};

const runProviderBackedAgentTask = async (options: AgentRunCliOptions): Promise<AgentRunCliResult> => {
  const projectPath = path.resolve(options.projectPath ?? process.cwd());
  const targetSlideCount = normalizeTargetSlideCount(options.targetSlideCount);
  const resolved = resolveAgentProvider({
    apiKeyEnv: options.apiKeyEnv ?? "",
    baseUrl: options.baseUrl,
    env: options.env,
    fetch: options.fetch,
    model: options.model ?? "",
    provider: options.provider ?? ""
  });
  const credential = await validateResolvedAgentProvider(resolved);
  if (!credential.ok) {
    throw providerCredentialFailure(resolved, credential);
  }

  let agent = await runAgent({
    brief: options.task,
    createCheckpoint: createFileCopyCheckpoint,
    metadata: {
      mode: "cli-byok-agent",
      model: resolved.model,
      provider: resolved.provider,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {})
    },
    projectRoot: projectPath,
    provider: resolved.modelProvider,
    speakerNotesMode: normalizeSpeakerNotesMode(options.speakerNotesMode),
    targetSlideCount
  });

  let applied: AppliedProviderAgentSourceWrites | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CheckReport | undefined;
  let exportResult: ExportResult | undefined;
  let exportManifest: AgentRunExportManifestSummary | undefined;

  if (agent.ok) {
    try {
      applied = await applyProviderAgentSourceWrites({
        projectPath,
        result: agent
      });
      const checkpoint = await recordCheckpointChanges({
        projectRoot: projectPath,
        runId: agent.runId,
        filesChanged: applied.filesChanged
      });
      agent = {
        ...agent,
        checkpoint
      };
      checkpointDiff = await diffFileCopyCheckpoint({
        projectRoot: projectPath,
        runId: agent.runId
      });

      const project = await loadProject(projectPath);
      check = await (options.checkProject ?? checkLoadedProject)(project);
      if (check.status !== "passed" || check.summary.errors > 0) {
        throw agentGateError(
          "check-failed",
          `Authoritative CLI check failed with status "${check.status}" and ${check.summary.errors} error(s).`,
          "check"
        );
      }

      exportResult = await (options.exportProject ?? exportLoadedProject)(project);
      if (collectExportArtifactPaths(exportResult.artifacts).length === 0) {
        throw agentGateError("export-failed", "Authoritative CLI export returned no artifacts.", "export");
      }
      exportManifest = await readAgentRunExportManifest(projectPath);
    } catch (error) {
      const gate = error as { agentGateCode?: AgentRunErrorInfo["code"]; agentStage?: AgentRunStage };
      agent = createAgentFailureResult(agent, {
        code: gate.agentGateCode ?? "unknown",
        message: sanitizeProviderText(error instanceof Error ? error.message : String(error), [resolved.apiKey]),
        stage: gate.agentStage ?? "build"
      });
    }
  }

  return finalizeProviderAgentRun({
    agent,
    applied,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    check,
    checkpointDiff,
    exportManifest,
    exportResult,
    model: resolved.model,
    projectPath,
    provider: resolved.provider,
    targetSlideCount
  });
};

const agentGateError = (
  code: AgentRunErrorInfo["code"],
  message: string,
  stage: AgentRunStage
): Error => Object.assign(new Error(message), {
  agentGateCode: code,
  agentStage: stage
});

const createAgentFailureResult = (
  result: AgentRunResult,
  error: AgentRunErrorInfo
): AgentRunResult => {
  if (!result.ok) {
    return result;
  }
  return {
    ok: false,
    status: "failed",
    runId: result.runId,
    checkpoint: result.checkpoint,
    error,
    outputs: result.outputs,
    events: result.events,
    logs: result.logs
  };
};

const applyProviderAgentSourceWrites = async ({
  projectPath,
  result
}: {
  projectPath: string;
  result: AgentRunResult;
}): Promise<AppliedProviderAgentSourceWrites> => {
  if (!result.ok || result.status !== "succeeded") {
    throw new Error("Cannot apply provider source writes from a non-successful agent run.");
  }

  if (!result.outputs.build?.sourceWrites) {
    throw new Error("Provider agent did not return build sourceWrites.");
  }

  const batches: Array<{
    stage: Extract<AgentRunStage, "build" | "repair">;
    attempt?: number;
    writes: AgentSourceWrite[];
  }> = [
    {
      stage: "build",
      writes: normalizeAgentSourceWrites(result.outputs.build.sourceWrites)
    }
  ];

  for (const repair of result.outputs.repairs) {
    if (!repair.sourceWrites) {
      throw new Error(`Provider agent did not return sourceWrites for repair attempt ${repair.attempt}.`);
    }
    batches.push({
      attempt: repair.attempt,
      stage: "repair",
      writes: normalizeAgentSourceWrites(repair.sourceWrites)
    });
  }

  const stages: AppliedProviderAgentSourceWrites["stages"] = [];
  for (const batch of batches) {
    const applied = await applyAgentSourceWrites({
      projectPath,
      writes: batch.writes
    });
    stages.push({
      ...(batch.attempt === undefined ? {} : { attempt: batch.attempt }),
      filesChanged: applied.filesChanged,
      stage: batch.stage,
      writeCount: applied.writes.length
    });
  }

  const filesChanged = [...new Set(stages.flatMap((stage) => stage.filesChanged))];
  return {
    projectPath: path.resolve(projectPath),
    source: "provider-source-writes",
    filesChanged,
    writeCount: stages.reduce((total, stage) => total + stage.writeCount, 0),
    stages
  };
};

const finalizeProviderAgentRun = async ({
  agent,
  apiKey,
  applied,
  baseUrl,
  check,
  checkpointDiff,
  exportManifest,
  exportResult,
  model,
  projectPath,
  provider,
  targetSlideCount
}: {
  agent: AgentRunResult;
  applied?: AppliedProviderAgentSourceWrites;
  apiKey: string;
  baseUrl?: string;
  check?: CheckReport;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportManifest?: AgentRunExportManifestSummary;
  exportResult?: ExportResult;
  model: string;
  projectPath: string;
  provider: AgentProviderKind;
  targetSlideCount?: number;
}): Promise<AgentRunCliResult> => {
  const reportPath = await writeAgentRunReport({
    agent,
    apiKey,
    applied,
    baseUrl,
    check,
    checkpointDiff,
    exportManifest,
    exportResult,
    model,
    projectPath,
    provider,
    targetSlideCount
  });

  return {
    ...agent,
    applied,
    baseUrl,
    check,
    checkpointDiff,
    export: exportResult,
    exportManifest,
    model,
    projectPath,
    provider,
    providerId: "htmlslide-byok",
    reportPath,
    targetSlideCount
  };
};

type AgentRunReportCliSummary = {
  ok: boolean;
  exitCode: number;
  status?: string;
  summary?: unknown;
  artifactPaths: string[];
};

const collectExportArtifactPaths = (artifacts: ExportResult["artifacts"]): string[] => {
  const paths: string[] = [];
  for (const value of Object.values(artifacts)) {
    if (typeof value === "string") {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          paths.push(item);
        }
      }
    }
  }
  return paths;
};

const readAgentRunExportManifest = async (
  projectPath: string
): Promise<AgentRunExportManifestSummary> => {
  const manifestPath = path.join(projectPath, "exports", "export-manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Authoritative CLI export did not produce a regular export manifest.");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = ExportManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  return {
    sourceDigest: manifest.sourceDigest,
    artifactCount: manifest.artifacts.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex")
  };
};

const writeAgentRunReport = async ({
  agent,
  apiKey,
  applied,
  baseUrl,
  check,
  checkpointDiff,
  exportManifest,
  exportResult,
  model,
  projectPath,
  provider,
  targetSlideCount
}: {
  agent: AgentRunResult;
  apiKey: string;
  applied?: AppliedProviderAgentSourceWrites;
  baseUrl?: string;
  check?: CheckReport;
  checkpointDiff?: FileCopyCheckpointDiff;
  exportManifest?: AgentRunExportManifestSummary;
  exportResult?: ExportResult;
  model: string;
  projectPath: string;
  provider: AgentProviderKind;
  targetSlideCount?: number;
}): Promise<string> => {
  const reportsPath = await ensureAgentRunReportsPath(projectPath);
  const report: Record<string, unknown> = {
    schemaVersion: AGENT_RUN_REPORT_SCHEMA_VERSION,
    kind: "htmlslide-agent-run-report",
    runId: agent.runId,
    providerId: "htmlslide-byok",
    provider: {
      provider,
      model,
      ...(baseUrl ? { baseUrlSha256: createHash("sha256").update(baseUrl).digest("hex") } : {})
    },
    ...(targetSlideCount === undefined ? {} : { targetSlideCount }),
    projectPath: path.resolve(projectPath),
    generatedAt: new Date().toISOString(),
    ok: agent.ok,
    status: agent.status,
    outputs: sanitizeAgentOutputsForReport(agent.outputs, [apiKey]),
    ...(agent.checkpoint
      ? {
          checkpoint: {
            id: agent.checkpoint.id,
            strategy: agent.checkpoint.strategy,
            manifestPath: agent.checkpoint.manifestPath,
            canRevert: agent.checkpoint.restore.canRevert
          }
        }
      : {}),
    ...(applied
      ? {
          applied: {
            source: applied.source,
            filesChanged: applied.filesChanged,
            writeCount: applied.writeCount,
            stages: applied.stages
          }
        }
      : {}),
    ...(checkpointDiff
      ? {
          checkpointDiff: {
            summary: checkpointDiff.summary,
            changedPaths: checkpointDiff.changed.map((file) => file.path),
            addedPaths: checkpointDiff.added.map((file) => file.path),
            deletedPaths: checkpointDiff.deleted.map((file) => file.path)
          }
        }
      : {}),
    cli: {
      ...(check ? { check: summarizeAgentRunCheck(check) } : {}),
      ...(exportResult ? { export: summarizeAgentRunExport(exportResult, projectPath) } : {})
    },
    ...(exportManifest ? { exportManifest } : {})
  };

  const payload = `${JSON.stringify(sanitizeReportValue(report, [apiKey]), null, 2)}\n`;
  const reportPath = path.join(reportsPath, `agent-run-${safeAgentRunReportId(agent.runId)}.json`);
  await Promise.all([
    writeAgentRunReportFile(reportPath, payload),
    writeAgentRunReportFile(path.join(reportsPath, "latest-agent-run.json"), payload)
  ]);
  return reportPath;
};

const summarizeAgentRunCheck = (check: CheckReport): AgentRunReportCliSummary => ({
  ok: check.status === "passed" && check.summary.errors === 0,
  exitCode: check.status === "passed" && check.summary.errors === 0
    ? EXIT_CODES.success
    : EXIT_CODES.validationFailed,
  status: check.status,
  summary: check.summary,
  artifactPaths: []
});

const summarizeAgentRunExport = (
  exportResult: ExportResult,
  projectPath: string
): AgentRunReportCliSummary => ({
  ok: collectExportArtifactPaths(exportResult.artifacts).length > 0,
  exitCode: collectExportArtifactPaths(exportResult.artifacts).length > 0
    ? EXIT_CODES.success
    : EXIT_CODES.exportFailed,
  status: collectExportArtifactPaths(exportResult.artifacts).length > 0 ? "passed" : "failed",
  artifactPaths: collectExportArtifactPaths(exportResult.artifacts).map((artifactPath) =>
    path.relative(path.resolve(projectPath), path.resolve(projectPath, artifactPath)).split(path.sep).join("/")
  )
});

const sanitizeAgentOutputsForReport = (
  outputs: AgentRunResult["outputs"],
  secrets: readonly string[]
): Record<string, unknown> => {
  const reportOutputs: Record<string, unknown> = {
    checks: sanitizeReportValue(outputs.checks, secrets),
    repairs: outputs.repairs.map((repair) => ({
      attempt: repair.attempt,
      filesChanged: sanitizeReportValue(repair.filesChanged, secrets),
      issuesAddressed: sanitizeReportValue(repair.issuesAddressed, secrets),
      sourceWriteCount: repair.sourceWrites?.length ?? 0,
      sourceWritePaths: repair.sourceWrites?.map((write) => sanitizeProviderText(write.path, secrets)) ?? []
    }))
  };

  if (outputs.speakerNotesMode) {
    reportOutputs.speakerNotesMode = outputs.speakerNotesMode;
  }
  if (outputs.brief) {
    reportOutputs.brief = sanitizeReportValue(outputs.brief, secrets);
  }
  if (outputs.outline) {
    reportOutputs.outline = sanitizeReportValue(outputs.outline, secrets);
  }
  if (outputs.visualDirection) {
    reportOutputs.visualDirection = sanitizeReportValue(outputs.visualDirection, secrets);
  }
  if (outputs.selectedVisualDirectionId) {
    reportOutputs.selectedVisualDirectionId = sanitizeProviderText(outputs.selectedVisualDirectionId, secrets);
  }
  if (outputs.build) {
    reportOutputs.build = {
      filesChanged: sanitizeReportValue(outputs.build.filesChanged, secrets),
      slidesChanged: sanitizeReportValue(outputs.build.slidesChanged, secrets),
      notesChanged: sanitizeReportValue(outputs.build.notesChanged, secrets),
      themeChanged: sanitizeReportValue(outputs.build.themeChanged, secrets),
      sourceWriteCount: outputs.build.sourceWrites?.length ?? 0,
      sourceWritePaths: outputs.build.sourceWrites?.map((write) => sanitizeProviderText(write.path, secrets)) ?? []
    };
  }
  if (outputs.export) {
    reportOutputs.export = sanitizeReportValue(outputs.export, secrets);
  }
  if (outputs.review) {
    reportOutputs.review = sanitizeReportValue(outputs.review, secrets);
  }
  return reportOutputs;
};

const sanitizeReportValue = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") {
    return sanitizeProviderText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportValue(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeReportValue(item, secrets)])
    );
  }
  return value;
};

const ensureAgentRunReportsPath = async (projectPath: string): Promise<string> => {
  const runtimeRoot = path.join(path.resolve(projectPath), ".htmlslide");
  const reportsPath = path.join(runtimeRoot, "reports");
  for (const directory of [runtimeRoot, reportsPath]) {
    await mkdir(directory, { recursive: true });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Agent run report path must be a real project directory: ${directory}`);
    }
  }
  return reportsPath;
};

const writeAgentRunReportFile = async (filePath: string, payload: string): Promise<void> => {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporaryPath, filePath);
};

const safeAgentRunReportId = (runId: string): string => {
  const safeId = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return safeId.length > 0 && safeId !== "." && safeId !== ".." ? safeId : "run";
};

export const validateAgentProviderCredentials = async (
  options: AgentProviderValidationOptions
): Promise<AgentProviderValidationResult> => {
  const provider = normalizeAgentProviderKind(options.provider);
  const model = requireTrimmedAgentOption(
    options.model,
    "AGENT_PROVIDER_MODEL_REQUIRED",
    "Pass a provider model id.",
    "Rerun with --model set to the exact model you want to validate."
  );
  const apiKeyEnv = requireTrimmedAgentOption(
    options.apiKeyEnv,
    "AGENT_PROVIDER_API_KEY_ENV_REQUIRED",
    "Pass the environment variable name that contains the provider API key.",
    "Set --api-key-env OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider-owned environment variable."
  );

  if (!envNamePattern.test(apiKeyEnv)) {
    throw agentError(
      "AGENT_PROVIDER_API_KEY_ENV_INVALID",
      "Invalid API key environment variable name.",
      "Use a shell environment variable name such as OPENAI_API_KEY or ANTHROPIC_API_KEY."
    );
  }

  const baseUrl = provider === "compatible"
    ? normalizeCompatibleProviderBaseUrl(options.baseUrl)
    : options.baseUrl?.trim().replace(/\/+$/u, "");
  if (provider === "compatible" && (!baseUrl || baseUrl.length === 0)) {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_REQUIRED",
      "OpenAI-compatible provider validation requires --base-url.",
      "Rerun with --base-url set to the compatible provider API root, for example https://api.example.com/v1.",
      { provider }
    );
  }

  if (provider !== "compatible" && baseUrl && baseUrl.length > 0) {
    throw agentError(
      "AGENT_PROVIDER_BASE_URL_UNSUPPORTED",
      `--base-url is only supported for the compatible provider, not ${provider}.`,
      "Use --provider compatible for custom OpenAI-compatible API roots.",
      { provider }
    );
  }

  const env = options.env ?? process.env;
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw agentError(
      "AGENT_PROVIDER_API_KEY_ENV_MISSING",
      `Environment variable ${apiKeyEnv} is not set or is empty.`,
      "Export the provider API key in that environment variable, then rerun the command. Do not paste API keys into CLI arguments.",
      { apiKeyEnv }
    );
  }

  const label = `HTMLslide ${provider} provider validation`;
  const modelProvider = provider === "anthropic"
    ? createAnthropicProvider({
        apiKey,
        fetch: options.fetch,
        id: "htmlslide-provider-validation",
        label,
        model
      })
    : createOpenAICompatibleProvider({
        apiKey,
        baseUrl: provider === "compatible" ? baseUrl : undefined,
        fetch: options.fetch,
        id: "htmlslide-provider-validation",
        label,
        model
      });

  let credential: CredentialStatus;
  try {
    credential = await modelProvider.validateCredentials();
  } catch (error) {
    credential = {
      ok: false,
      providerId: modelProvider.id,
      reason: sanitizeProviderText(error instanceof Error ? error.message : String(error), [apiKey]),
      recoverable: true
    };
  }

  const status = credential.ok ? "passed" : "failed";
  return {
    status,
    command: "agent validate-provider",
    provider,
    model,
    apiKeyEnv,
    ...(provider === "compatible" ? { baseUrl } : {}),
    credential,
    secretRecorded: false,
    exitCode: credential.ok ? EXIT_CODES.success : EXIT_CODES.agentFailed
  };
};

export const diffCheckpoint = async (options: CheckpointCliOptions): Promise<FileCopyCheckpointDiff> =>
  diffFileCopyCheckpoint({
    projectRoot: path.resolve(options.projectPath ?? process.cwd()),
    runId: options.runId,
    checkpointId: options.checkpointId
  });

export const revertCheckpoint = async (options: CheckpointCliOptions): Promise<FileCopyCheckpointRevertResult> =>
  revertFileCopyCheckpoint({
    projectRoot: path.resolve(options.projectPath ?? process.cwd()),
    runId: options.runId,
    checkpointId: options.checkpointId
  });
