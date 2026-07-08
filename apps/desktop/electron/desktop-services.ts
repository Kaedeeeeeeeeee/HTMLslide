import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMockAgentProject,
  createFileCopyCheckpoint,
  createMockProvider,
  defaultAgentStages,
  diffFileCopyCheckpoint,
  recordCheckpointChanges,
  revertFileCopyCheckpoint,
  runAgent,
  type AgentRunEvent,
  type AgentRunLog,
  type AgentRunResult,
  type AgentRunStage,
  type AgentRunStatus,
  type ApplyMockAgentProjectResult,
  type FileCopyCheckpointDiff,
  type FileCopyCheckpointRevertResult
} from "@htmlslide/agent";

export type DesktopProjectStatus =
  | "Ready"
  | "Needs check"
  | "Export failed"
  | "Missing files"
  | "External changes detected";

export type DesktopProjectRecord = {
  id: string;
  title: string;
  path: string;
  lastOpenedAt: string;
  status: DesktopProjectStatus;
  slideCount: number;
  thumbnail?: string;
};

export type DesktopLibrary = {
  version: 1;
  defaultWorkspace: string;
  recentProjects: DesktopProjectRecord[];
};

export type DesktopSlidePreview = {
  id: string;
  number: string;
  title: string;
  section: string;
  status: "ready" | "needs-check" | "blocked";
  duration: string;
  accent: string;
  speakerNotes: string;
  bullets: string[];
  sourcePath: string;
  notesPath?: string;
  html: string;
};

export type DesktopProjectPreview = {
  project: DesktopProjectRecord;
  slides: DesktopSlidePreview[];
};

export type DesktopCreateProjectRequest = {
  title: string;
  folderName: string;
  workspacePath?: string;
};

export type DesktopResolvedCreateProjectRequest = {
  title: string;
  folderName: string;
  workspacePath: string;
  projectPath: string;
};

export type CliRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
};

export type CliRuntime = {
  mode: "development" | "packaged";
  cliPath: string;
  cwd: string;
  rootPath?: string;
};

export type CliRunnerOptions = {
  rootPath?: string;
  cliPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type DesktopCliRunner = (args: string[], options: CliRunnerOptions) => Promise<CliRunResult>;

export type DesktopMockAgentRunRequest = {
  projectPath: string;
  brief: string;
  runExport?: boolean;
  maxRepairRounds?: number;
  runId?: string;
};

export type DesktopMockAgentStageSummary = {
  stage: AgentRunStage;
  status: AgentRunStatus;
  summary: string;
  updatedAt?: string;
};

export type DesktopMockAgentRunSummary = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  stageCount: number;
  completedStages: number;
  failedStages: number;
  checkStatus?: string;
  checkErrors?: number;
  checkWarnings?: number;
  exportStatus?: string;
  exportArtifacts: string[];
};

export type DesktopMockAgentRunResult = {
  ok: boolean;
  providerId: "htmlslide-mock";
  projectPath: string;
  stages: DesktopMockAgentStageSummary[];
  events: AgentRunEvent[];
  logs: AgentRunLog[];
  agent: AgentRunResult;
  applied?: ApplyMockAgentProjectResult;
  checkpointDiff?: FileCopyCheckpointDiff;
  check?: CliRunResult;
  export?: CliRunResult;
  project?: DesktopProjectPreview;
  summary: DesktopMockAgentRunSummary;
};

export type DesktopCheckpointRequest = {
  projectPath: string;
  runId?: string;
  checkpointId?: string;
  confirmed?: boolean;
};

export type DesktopCheckpointRevertResult = FileCopyCheckpointRevertResult & {
  project?: DesktopProjectPreview;
};

export type DesktopMockAgentRunnerOptions = {
  cliRuntime?: CliRuntime;
  cliRunner?: DesktopCliRunner;
};

export type DesktopAiEngineMode = "no-ai" | "htmlslide-agent" | "external-agent";
export type DesktopApiKeyProvider = "openai" | "anthropic" | "compatible";
export type DesktopExternalAgentId = "claude-code" | "codex-cli" | "generic";
export type DesktopExternalAgentDetectionStatus = "ready" | "not-installed" | "not-authenticated" | "unavailable";

export type DesktopAiEngineSettings = {
  version: 1;
  mode: DesktopAiEngineMode;
  apiKey: {
    provider: DesktopApiKeyProvider;
    model: string;
    hasKey: boolean;
    updatedAt?: string;
  };
  externalAgent: {
    selectedId: DesktopExternalAgentId;
    customCommand: string;
    updatedAt?: string;
  };
  updatedAt?: string;
};

export type DesktopExternalAgentStatus = {
  id: DesktopExternalAgentId;
  label: string;
  kind: DesktopExternalAgentId;
  capabilities: Record<string, boolean>;
  status: DesktopExternalAgentDetectionStatus;
  installed: boolean;
  authenticated: boolean;
  command: string;
  version?: string;
  checkedAt: string;
  summary: string;
};

export type ExternalAgentDetectorRunner = (invocation: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type DeckManifest = {
  title?: unknown;
  slides?: Array<{
    id?: unknown;
    title?: unknown;
    source?: unknown;
    notes?: unknown;
    durationSec?: unknown;
    kind?: unknown;
    status?: unknown;
  }>;
};

const DEFAULT_LIBRARY: Omit<DesktopLibrary, "defaultWorkspace"> = {
  version: 1,
  recentProjects: []
};

const DEFAULT_AI_ENGINE_SETTINGS: DesktopAiEngineSettings = {
  apiKey: {
    hasKey: false,
    model: "gpt-5-mini",
    provider: "openai"
  },
  externalAgent: {
    customCommand: "",
    selectedId: "codex-cli"
  },
  mode: "no-ai",
  version: 1
};

const DEFAULT_AGENT_CAPABILITIES = {
  cancelRun: false,
  configureMCP: false,
  detectAuthenticated: true,
  detectInstalled: true,
  headlessRun: false,
  installSkills: false,
  openExternal: true,
  readDiff: false,
  streamLogs: false
};

const EXTERNAL_AGENT_SPECS = [
  {
    authArgs: ["auth", "status"] as const,
    command: "claude",
    id: "claude-code",
    kind: "claude-code",
    label: "Claude Code",
    versionArgs: ["--version"] as const
  },
  {
    authArgs: ["auth", "status"] as const,
    command: "codex",
    id: "codex-cli",
    kind: "codex-cli",
    label: "Codex CLI",
    versionArgs: ["--version"] as const
  }
] satisfies Array<{
  authArgs: readonly string[];
  command: string;
  id: DesktopExternalAgentId;
  kind: DesktopExternalAgentId;
  label: string;
  versionArgs: readonly string[];
}>;

const CLI_RUNTIME_ENTRY_PARTS = ["cli-runtime", "dist", "bin", "htmlslide.js"] as const;
const DEFAULT_ACCENT = "#315fcb";
const DEFAULT_ACCENTS = [DEFAULT_ACCENT, "#267a4f", "#9a6410", "#286a8d", "#7b4ab8", "#bc3a3a"];

export const defaultWorkspacePath = (): string => path.join(os.homedir(), "Documents", "HTMLslide");

export function resolveCreateProjectRequest(
  request: DesktopCreateProjectRequest,
  defaultWorkspace = defaultWorkspacePath()
): DesktopResolvedCreateProjectRequest {
  if (typeof request.title !== "string" || typeof request.folderName !== "string") {
    throw new Error("New deck title and folder name are required.");
  }

  if (request.workspacePath !== undefined && typeof request.workspacePath !== "string") {
    throw new Error("Workspace path must be a string.");
  }

  const title = request.title.trim().replace(/\s+/g, " ");
  if (title.length === 0) {
    throw new Error("Deck title is required.");
  }

  if (title.length > 120) {
    throw new Error("Deck title must be 120 characters or fewer.");
  }

  const folderName = request.folderName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(folderName)) {
    throw new Error("Folder name must start with a lowercase letter or number and use only lowercase letters, numbers, dashes, underscores, or dots.");
  }

  if (folderName === "." || folderName === ".." || folderName.includes("..")) {
    throw new Error("Folder name cannot contain path traversal segments.");
  }

  const workspacePath = path.resolve(request.workspacePath ?? defaultWorkspace);
  const projectPath = path.resolve(workspacePath, folderName);
  const relativePath = path.relative(workspacePath, projectPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("New deck folder must stay inside the selected workspace.");
  }

  return {
    folderName,
    projectPath,
    title,
    workspacePath
  };
}

export async function readDesktopLibrary(
  libraryPath: string,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  try {
    const contents = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<DesktopLibrary>;
    return {
      version: 1,
      defaultWorkspace:
        typeof parsed.defaultWorkspace === "string" && parsed.defaultWorkspace.length > 0
          ? parsed.defaultWorkspace
          : defaultWorkspace,
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter(isProjectRecord)
        : []
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        ...DEFAULT_LIBRARY,
        defaultWorkspace
      };
    }
    throw error;
  }
}

export async function writeDesktopLibrary(libraryPath: string, library: DesktopLibrary): Promise<void> {
  await fs.mkdir(path.dirname(libraryPath), { recursive: true });
  await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

export async function readAiEngineSettings(settingsPath: string): Promise<DesktopAiEngineSettings> {
  try {
    const contents = await fs.readFile(settingsPath, "utf8");
    return sanitizeAiEngineSettings(JSON.parse(contents));
  } catch (error) {
    if (isMissingFileError(error)) {
      return sanitizeAiEngineSettings(DEFAULT_AI_ENGINE_SETTINGS);
    }
    throw error;
  }
}

export async function writeAiEngineSettings(
  settingsPath: string,
  settings: unknown
): Promise<DesktopAiEngineSettings> {
  const safeSettings = sanitizeAiEngineSettings(settings);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(safeSettings, null, 2)}\n`);
  return safeSettings;
}

export async function detectExternalAgentStatuses({
  cwd = process.cwd(),
  now = new Date().toISOString(),
  runner = runDetectorCommand
}: {
  cwd?: string;
  now?: string;
  runner?: ExternalAgentDetectorRunner;
} = {}): Promise<DesktopExternalAgentStatus[]> {
  const detected = await Promise.all(
    EXTERNAL_AGENT_SPECS.map(async (spec) => {
      const versionResult = await runDetectorSafely(runner, {
        args: spec.versionArgs,
        command: spec.command,
        cwd,
        timeoutMs: 3_000
      });

      if (versionResult.kind === "not-installed") {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: false,
          label: spec.label,
          status: "not-installed",
          summary: versionResult.detail
        });
      }

      if (versionResult.result.exitCode !== 0) {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          rawVersion: versionResult.result.stderr || versionResult.result.stdout,
          status: "unavailable",
          summary: `Version check exited with ${versionResult.result.exitCode}`
        });
      }

      const authResult = await runDetectorSafely(runner, {
        args: spec.authArgs,
        command: spec.command,
        cwd,
        timeoutMs: 3_000
      });
      const version = firstNonEmptyLine(versionResult.result.stdout) ?? firstNonEmptyLine(versionResult.result.stderr);

      if (authResult.kind === "not-installed") {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: false,
          label: spec.label,
          status: "not-installed",
          summary: authResult.detail
        });
      }

      if (authResult.result.exitCode !== 0) {
        return externalAgentStatus({
          checkedAt: now,
          command: spec.command,
          id: spec.id,
          installed: true,
          label: spec.label,
          status: "not-authenticated",
          summary: authResult.result.stderr || authResult.result.stdout || "Authentication status is unavailable",
          version
        });
      }

      return externalAgentStatus({
        authenticated: true,
        checkedAt: now,
        command: spec.command,
        id: spec.id,
        installed: true,
        label: spec.label,
        status: "ready",
        summary: "Detected and authenticated",
        version
      });
    })
  );

  return [
    ...detected,
    externalAgentStatus({
      checkedAt: now,
      command: "",
      id: "generic",
      installed: false,
      label: "Generic command",
      status: "unavailable",
      summary: "Add a custom command template before detection"
    })
  ];
}

export async function upsertRecentProject(
  libraryPath: string,
  project: DesktopProjectRecord,
  defaultWorkspace = defaultWorkspacePath()
): Promise<DesktopLibrary> {
  const library = await readDesktopLibrary(libraryPath, defaultWorkspace);
  const nextProjects = [
    project,
    ...library.recentProjects.filter((item) => path.resolve(item.path) !== path.resolve(project.path))
  ].slice(0, 40);
  const nextLibrary = {
    ...library,
    recentProjects: nextProjects
  };
  await writeDesktopLibrary(libraryPath, nextLibrary);
  return nextLibrary;
}

export async function summarizeDeckProject(projectPath: string): Promise<DesktopProjectRecord> {
  const root = path.resolve(projectPath);
  const manifest = await readDeckManifest(root);
  const title = typeof manifest.title === "string" && manifest.title.length > 0
    ? manifest.title
    : path.basename(root);
  const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
  const missingFiles = await hasMissingSlideFiles(root, manifest);

  return {
    id: `proj_${stableId(root)}`,
    title,
    path: root,
    lastOpenedAt: new Date().toISOString(),
    status: missingFiles ? "Missing files" : "Needs check",
    slideCount: slides.length
  };
}

export async function loadProjectPreview(projectPath: string): Promise<DesktopProjectPreview> {
  const project = await summarizeDeckProject(projectPath);
  const manifest = await readDeckManifest(project.path);
  const slides = await Promise.all(
    (manifest.slides ?? []).map(async (slide, index): Promise<DesktopSlidePreview> => {
      const slideId = typeof slide.id === "string" && slide.id.length > 0 ? slide.id : `slide-${index + 1}`;
      const sourcePath = typeof slide.source === "string" ? slide.source : "";
      const notesPath = typeof slide.notes === "string" ? slide.notes : undefined;
      const html = await readProjectText(project.path, sourcePath);
      const notes = notesPath ? await readProjectText(project.path, notesPath) : "";
      const title = typeof slide.title === "string" && slide.title.length > 0 ? slide.title : slideId;
      const durationSec = typeof slide.durationSec === "number" && Number.isFinite(slide.durationSec)
        ? slide.durationSec
        : 60;

      return {
        id: slideId,
        number: String(index + 1).padStart(2, "0"),
        title,
        section: typeof slide.kind === "string" ? titleCase(slide.kind) : "Content",
        status: slide.status === "ready" || slide.status === "final" ? "ready" : "needs-check",
        duration: formatDuration(durationSec),
        accent: DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length] ?? DEFAULT_ACCENT,
        speakerNotes: notes.trim(),
        bullets: extractBullets(html, title),
        sourcePath,
        notesPath,
        html
      };
    })
  );

  return {
    project,
    slides
  };
}

export async function runHtmlslideCli(args: string[], options: CliRunnerOptions): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const command = process.execPath;
  const cliPath = options.cliPath ?? (options.rootPath ? path.join(options.rootPath, "packages", "cli", "dist", "bin", "htmlslide.js") : undefined);

  if (!cliPath) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI runtime was not configured for this desktop build."
    };
  }

  const commandArgs = [cliPath, ...args];
  const cliExists = await pathExists(cliPath);

  if (!cliExists) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: `HTMLslide CLI runtime was not found at ${cliPath}.`
    };
  }

  return new Promise<CliRunResult>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? options.rootPath ?? path.dirname(cliPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...options.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: 6,
        stdout,
        stderr,
        error: `htmlslide ${args.join(" ")} timed out after ${timeoutMs}ms.`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        json: parseJsonOutput(stdout)
      });
    });
  });
}

export async function runDesktopMockAgent(
  request: DesktopMockAgentRunRequest,
  options: DesktopMockAgentRunnerOptions = {}
): Promise<DesktopMockAgentRunResult> {
  const projectPath = path.resolve(request.projectPath);
  const brief = request.brief.trim();
  const logs: AgentRunLog[] = [];
  const cliRunner = options.cliRunner ?? runHtmlslideCli;

  let agent = await runAgent({
    brief: brief.length > 0 ? brief : "Create or revise this HTMLslide deck.",
    maxRepairRounds: request.maxRepairRounds,
    projectRoot: projectPath,
    provider: createMockProvider(),
    runId: request.runId,
    metadata: {
      mode: "desktop-mock-agent"
    },
    createCheckpoint: createFileCopyCheckpoint
  });

  logs.push(...agent.logs);

  let applied: ApplyMockAgentProjectResult | undefined;
  let checkpointDiff: FileCopyCheckpointDiff | undefined;
  let check: CliRunResult | undefined;
  let exportResult: CliRunResult | undefined;
  let project: DesktopProjectPreview | undefined;

  if (agent.ok) {
    applied = await applyMockAgentProject({
      brief,
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
    logs.push({
      createdAt: new Date().toISOString(),
      level: "info",
      message: `Applied mock source files: ${applied.filesChanged.join(", ")}`,
      runId: agent.runId,
      stage: "build",
      metadata: {
        filesChanged: applied.filesChanged
      }
    });

    check = await runDesktopAgentCliStep(["check", projectPath, "--json"], options.cliRuntime, cliRunner);
    logs.push(desktopAgentCliLog(agent.runId, "check", check));

    if (check.ok && request.runExport !== false) {
      exportResult = await runDesktopAgentCliStep(["export", projectPath, "--json"], options.cliRuntime, cliRunner);
      logs.push(desktopAgentCliLog(agent.runId, "export", exportResult));
    }

    project = await loadProjectPreview(projectPath);
  }

  const summary = summarizeDesktopMockAgentRun(agent, check, exportResult);

  return {
    ok: agent.ok && (check === undefined || check.ok) && (exportResult === undefined || exportResult.ok),
    providerId: "htmlslide-mock",
    projectPath,
    stages: summarizeAgentStages(agent.events),
    events: agent.events,
    logs,
    agent,
    applied,
    checkpointDiff,
    check,
    export: exportResult,
    project,
    summary
  };
}

export async function diffDesktopCheckpoint(request: DesktopCheckpointRequest): Promise<FileCopyCheckpointDiff> {
  return diffFileCopyCheckpoint({
    projectRoot: path.resolve(request.projectPath),
    runId: request.runId,
    checkpointId: request.checkpointId
  });
}

export async function revertDesktopCheckpoint(
  request: DesktopCheckpointRequest
): Promise<DesktopCheckpointRevertResult> {
  if (request.confirmed !== true) {
    throw new Error("Checkpoint revert requires explicit confirmation.");
  }

  const projectPath = path.resolve(request.projectPath);
  const reverted = await revertFileCopyCheckpoint({
    projectRoot: projectPath,
    runId: request.runId,
    checkpointId: request.checkpointId
  });

  return {
    ...reverted,
    project: await loadProjectPreview(projectPath).catch(() => undefined)
  };
}

export function findCliRuntime(startPath: string, resourcesPath?: string): CliRuntime | undefined {
  const repoRoot = findRepositoryRoot(startPath);
  if (repoRoot) {
    const cliPath = path.join(repoRoot, "packages", "cli", "dist", "bin", "htmlslide.js");
    if (pathExistsSync(cliPath)) {
      return {
        mode: "development",
        cliPath,
        cwd: repoRoot,
        rootPath: repoRoot
      };
    }
  }

  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const resourceRoots = [
    resourcesPath,
    typeof processResourcesPath === "string" ? processResourcesPath : undefined,
    path.resolve(startPath, "..", "..", "..")
  ].filter((value): value is string => Boolean(value));

  for (const resourceRoot of resourceRoots) {
    const appResourcesRoot = path.join(resourceRoot, "app");
    const cliPath = path.join(appResourcesRoot, ...CLI_RUNTIME_ENTRY_PARTS);
    if (pathExistsSync(cliPath)) {
      return {
        mode: "packaged",
        cliPath,
        cwd: path.join(appResourcesRoot, "cli-runtime")
      };
    }
  }

  return undefined;
}

export function findRepositoryRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath);
  while (true) {
    if (pathExistsSync(path.join(current, "pnpm-workspace.yaml")) && pathExistsSync(path.join(current, "packages", "cli"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function sanitizeAiEngineSettings(value: unknown): DesktopAiEngineSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_AI_ENGINE_SETTINGS, apiKey: { ...DEFAULT_AI_ENGINE_SETTINGS.apiKey }, externalAgent: { ...DEFAULT_AI_ENGINE_SETTINGS.externalAgent } };
  }

  const apiKey = isRecord(value.apiKey) ? value.apiKey : {};
  const externalAgent = isRecord(value.externalAgent) ? value.externalAgent : {};
  const provider = normalizeApiKeyProvider(apiKey.provider);

  return {
    apiKey: {
      hasKey: apiKey.hasKey === true,
      model: normalizeModel(apiKey.model, provider),
      provider,
      updatedAt: typeof apiKey.updatedAt === "string" ? apiKey.updatedAt : undefined
    },
    externalAgent: {
      customCommand: typeof externalAgent.customCommand === "string" ? externalAgent.customCommand.trim() : "",
      selectedId: normalizeExternalAgentId(externalAgent.selectedId),
      updatedAt: typeof externalAgent.updatedAt === "string" ? externalAgent.updatedAt : undefined
    },
    mode: normalizeAiEngineMode(value.mode),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    version: 1
  };
}

function normalizeAiEngineMode(value: unknown): DesktopAiEngineMode {
  return value === "htmlslide-agent" || value === "external-agent" || value === "no-ai" ? value : "no-ai";
}

function normalizeApiKeyProvider(value: unknown): DesktopApiKeyProvider {
  return value === "anthropic" || value === "compatible" || value === "openai" ? value : "openai";
}

function normalizeExternalAgentId(value: unknown): DesktopExternalAgentId {
  return value === "claude-code" || value === "generic" || value === "codex-cli" ? value : "codex-cli";
}

function normalizeModel(value: unknown, provider: DesktopApiKeyProvider): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (provider === "anthropic") {
    return "claude-sonnet-4.5";
  }

  if (provider === "compatible") {
    return "openai-compatible/default";
  }

  return "gpt-5-mini";
}

function externalAgentStatus({
  authenticated = false,
  checkedAt,
  command,
  id,
  installed,
  label,
  status,
  summary,
  version
}: {
  authenticated?: boolean;
  checkedAt: string;
  command: string;
  id: DesktopExternalAgentId;
  installed: boolean;
  label: string;
  rawVersion?: string;
  status: DesktopExternalAgentDetectionStatus;
  summary: string;
  version?: string;
}): DesktopExternalAgentStatus {
  return {
    authenticated,
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
    checkedAt,
    command,
    id,
    installed,
    kind: id,
    label,
    status,
    summary: collapseWhitespace(summary),
    version
  };
}

type DetectorCommandOutcome =
  | {
      kind: "result";
      result: Awaited<ReturnType<ExternalAgentDetectorRunner>>;
    }
  | {
      detail: string;
      kind: "not-installed";
    };

async function runDetectorSafely(
  runner: ExternalAgentDetectorRunner,
  invocation: Parameters<ExternalAgentDetectorRunner>[0]
): Promise<DetectorCommandOutcome> {
  try {
    const result = await runner(invocation);
    if (isCommandNotFoundText(result.stderr)) {
      return {
        detail: result.stderr,
        kind: "not-installed"
      };
    }
    return {
      kind: "result",
      result
    };
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      return {
        detail: error instanceof Error ? error.message : String(error),
        kind: "not-installed"
      };
    }
    throw error;
  }
}

function runDetectorCommand(invocation: Parameters<ExternalAgentDetectorRunner>[0]): Promise<Awaited<ReturnType<ExternalAgentDetectorRunner>>> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || `Command ${invocation.command} timed out after ${invocation.timeoutMs}ms.`
      });
    }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message
      });
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function readDeckManifest(projectPath: string): Promise<DeckManifest> {
  const deckPath = path.join(projectPath, "deck.json");
  const contents = await fs.readFile(deckPath, "utf8");
  return JSON.parse(contents) as DeckManifest;
}

async function hasMissingSlideFiles(projectPath: string, manifest: DeckManifest): Promise<boolean> {
  for (const slide of manifest.slides ?? []) {
    const source = typeof slide.source === "string" ? slide.source : undefined;
    if (!source || !(await pathExists(resolveProjectPath(projectPath, source)))) {
      return true;
    }
    const notes = typeof slide.notes === "string" ? slide.notes : undefined;
    if (notes && !(await pathExists(resolveProjectPath(projectPath, notes)))) {
      return true;
    }
  }
  return false;
}

async function readProjectText(projectPath: string, relativePath: string): Promise<string> {
  if (relativePath.length === 0) {
    return "";
  }
  return fs.readFile(resolveProjectPath(projectPath, relativePath), "utf8");
}

function resolveProjectPath(projectPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  const resolved = path.resolve(projectPath, relativePath);
  const root = path.resolve(projectPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  return resolved;
}

function extractBullets(html: string, fallbackTitle: string): string[] {
  const listItems = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);

  if (listItems.length > 0) {
    return listItems;
  }

  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);

  return paragraphs.length > 0 ? paragraphs : [`Review ${fallbackTitle}`];
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function stableId(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function runDesktopAgentCliStep(
  args: string[],
  cliRuntime: CliRuntime | undefined,
  cliRunner: DesktopCliRunner
): Promise<CliRunResult> {
  if (!cliRuntime) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide."
    };
  }

  return cliRunner(args, {
    cliPath: cliRuntime.cliPath,
    cwd: cliRuntime.cwd,
    rootPath: cliRuntime.rootPath
  });
}

function desktopAgentCliLog(runId: string, stage: "check" | "export", result: CliRunResult): AgentRunLog {
  return {
    runId,
    stage,
    level: result.ok ? "info" : "error",
    message: result.ok
      ? `htmlslide ${stage} completed with exit code ${result.exitCode}.`
      : `htmlslide ${stage} failed with exit code ${result.exitCode}.`,
    createdAt: new Date().toISOString(),
    metadata: {
      exitCode: result.exitCode
    }
  };
}

function summarizeAgentStages(events: readonly AgentRunEvent[]): DesktopMockAgentStageSummary[] {
  return defaultAgentStages.map((stage) => {
    const stageEvents = events.filter((event) => event.stage === stage);
    const terminalEvent = lastMatchingEvent(
      stageEvents,
      (event) => event.type === "stage-failed" || event.type === "stage-completed"
    );
    const lastEvent = terminalEvent ?? stageEvents.at(-1);
    return {
      stage,
      status: lastEvent?.status ?? "queued",
      summary: lastEvent?.summary ?? `${stage} queued.`,
      updatedAt: lastEvent?.createdAt
    };
  });
}

function lastMatchingEvent(
  events: readonly AgentRunEvent[],
  predicate: (event: AgentRunEvent) => boolean
): AgentRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) {
      return event;
    }
  }
  return undefined;
}

function summarizeDesktopMockAgentRun(
  agent: AgentRunResult,
  check: CliRunResult | undefined,
  exportResult: CliRunResult | undefined
): DesktopMockAgentRunSummary {
  const stages = summarizeAgentStages(agent.events);
  const checkJson = asRecord(check?.json);
  const checkSummary = asRecord(checkJson?.summary);
  const exportJson = asRecord(exportResult?.json);

  return {
    runId: agent.runId,
    status: agent.status,
    stageCount: stages.length,
    completedStages: stages.filter((stage) => stage.status === "succeeded").length,
    failedStages: stages.filter((stage) => stage.status === "failed").length,
    checkStatus: typeof checkJson?.status === "string" ? checkJson.status : undefined,
    checkErrors: numberFromRecord(checkSummary, "errors"),
    checkWarnings: numberFromRecord(checkSummary, "warnings"),
    exportStatus: typeof exportJson?.status === "string" ? exportJson.status : undefined,
    exportArtifacts: collectExportArtifacts(exportJson)
  };
}

function collectExportArtifacts(value: Record<string, unknown> | undefined): string[] {
  const artifacts = asRecord(value?.artifacts);
  if (!artifacts) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of Object.values(artifacts)) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string") {
          paths.push(item);
        }
      }
    }
  }
  return paths;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function numberFromRecord(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function firstNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function isProjectRecord(value: unknown): value is DesktopProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<DesktopProjectRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.path === "string" &&
    typeof record.lastOpenedAt === "string" &&
    typeof record.slideCount === "number" &&
    typeof record.status === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCommandNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isCommandNotFoundText(stderr: string): boolean {
  return /\bENOENT\b|command not found|not recognized as/.test(stderr);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
