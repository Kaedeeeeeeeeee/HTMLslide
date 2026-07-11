#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { ProjectLoadError } from "@htmlslide/core";
import { listBuiltInDeckTemplates } from "@htmlslide/core/templates";
import { HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import {
  createHtmlslideMcpServer,
  htmlslideTools,
  startHtmlslideMcpStdioServer,
  summarizeHtmlslideMcpTools
} from "@htmlslide/mcp-server";
import {
  getOfficialSkill,
  inspectInstalledSkill,
  installSkill,
  listInstalledSkills,
  OFFICIAL_SKILLS,
  removeSkill,
  SkillStoreError,
  type ProjectSkillInstallLocation,
  type SkillInstallTarget
} from "@htmlslide/skills";
import {
  checkLoadedProject,
  configureCliBrowserRuntime,
  createProject,
  diffCheckpoint,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  getCliShimStatus,
  installCliShim,
  launchDesktopTarget,
  listAgentEngines,
  loadProject,
  packageLoadedProject,
  revertCheckpoint,
  runAgentTask,
  tryLoadProjectForCheck,
  uninstallCliShim,
  validateAgentProviderCredentials,
  validateDeckPackageForPresentation
} from "../index.js";

try {
  await configureCliBrowserRuntime();
} catch (error) {
  process.env.HTMLSLIDE_BROWSER_RUNTIME_ERROR = error instanceof Error ? error.message : String(error);
}

type JsonOption = {
  json?: boolean;
};

type NewCommandOptions = JsonOption & {
  template?: string;
  title?: string;
};

type ExportCommandOptions = JsonOption & {
  pdf?: boolean;
  html?: boolean;
  deckpkg?: boolean;
  thumbnails?: boolean;
};

type SetupCommandOptions = JsonOption & {
  targetDir?: string;
  targetPath?: string;
  appPath?: string;
  appVersion?: string;
  bundleId?: string;
  fallbackCliPath?: string;
  updatedAt?: string;
};

type AgentRunCommandOptions = JsonOption & {
  engine: string;
  task: string;
  path?: string;
};

type AgentValidateProviderCommandOptions = JsonOption & {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  provider: string;
};

type CheckpointCommandOptions = JsonOption & {
  path?: string;
  runId?: string;
  checkpointId?: string;
  yes?: boolean;
};

type McpCommandOptions = JsonOption & {
  listTools?: boolean;
  status?: boolean;
};

type SkillCommandOptions = JsonOption & {
  location?: string[];
  project?: string;
  yes?: boolean;
};

type CliError = Error & {
  code?: string;
  exitCode?: number;
  suggestedFix?: string;
  targetPath?: string;
  targetDir?: string;
  issues?: unknown;
  summary?: unknown;
  details?: unknown;
};

const writeResult = (payload: unknown, json = false): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (typeof payload === "string") {
    process.stdout.write(`${payload}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const fail = (error: unknown, json = false): never => {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error ? (error as CliError) : undefined;
  const exitCode = typeof details?.exitCode === "number" ? details.exitCode : EXIT_CODES.generic;
  writeResult(
    {
      status: "failed",
      error: message,
      code: details?.code,
      exitCode,
      suggestedFix: details?.suggestedFix,
      targetPath: details?.targetPath,
      targetDir: details?.targetDir,
      summary: details?.summary,
      issues: details?.issues,
      details: details?.details
    },
    json
  );
  process.exit(exitCode);
};

const exportFailure = (error: unknown): CliError => {
  if (error instanceof Error && typeof (error as CliError).exitCode === "number") {
    return error as CliError;
  }
  if (error instanceof Error && (error as CliError).code === "CHROMIUM_UNAVAILABLE") {
    return Object.assign(error, {
      exitCode: EXIT_CODES.missingDependency,
      suggestedFix: "Install the Playwright Chromium build or reinstall HTMLslide.app, then rerun htmlslide export."
    });
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), {
    cause: error
  }), {
    code: "EXPORT_FAILED",
    exitCode: EXIT_CODES.exportFailed,
    suggestedFix: "Resolve the reported export filesystem or concurrency issue, then rerun htmlslide export."
  });
};

const failStdioStartup = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error ? (error as CliError) : undefined;
  const exitCode = typeof details?.exitCode === "number" ? details.exitCode : EXIT_CODES.generic;
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      error: message,
      code: details?.code,
      exitCode,
      suggestedFix: details?.suggestedFix,
      targetPath: details?.targetPath,
      targetDir: details?.targetDir
    })}\n`
  );
  process.exit(exitCode);
};

const annotateProjectLoadError = (error: unknown): unknown => {
  if (error instanceof ProjectLoadError) {
    if (typeof (error as CliError).exitCode === "number") {
      return error;
    }
    return Object.assign(error, {
      exitCode:
        error.code === "PROJECT_NOT_FOUND"
          ? EXIT_CODES.projectNotFound
          : error.code === "INCOMPATIBLE_SCHEMA"
            ? EXIT_CODES.incompatibleSchema
            : EXIT_CODES.validationFailed
    });
  }
  return error;
};

const annotateSkillError = (error: unknown): unknown => {
  if (error instanceof SkillStoreError) {
    const networkFailure = [
      "SKILL_SOURCE_DNS_FAILED",
      "SKILL_SOURCE_FETCH_FAILED",
      "SKILL_SOURCE_HTTP_ERROR"
    ].includes(error.code);
    const validationFailure =
      error.code.startsWith("SKILL_SOURCE_") ||
      error.code === "SKILL_PLAN_NOT_INSTALLABLE" ||
      error.code === "SKILL_NAME_INVALID";
    return Object.assign(error, {
      exitCode: networkFailure
        ? EXIT_CODES.missingDependency
        : validationFailure
          ? EXIT_CODES.validationFailed
          : EXIT_CODES.generic,
      suggestedFix:
        error.code === "SKILL_CONFIRMATION_REQUIRED"
          ? "Inspect the reported warnings, then rerun with --yes to confirm installation."
          : error.code === "SKILL_TARGET_UNMANAGED" || error.code === "SKILL_TARGET_MODIFIED"
            ? "Inspect the existing skill and resolve local changes manually before retrying."
            : error.code.startsWith("SKILL_SOURCE_") || error.code === "SKILL_PLAN_NOT_INSTALLABLE"
              ? "Inspect the skill source, metadata, declared risks, and license before retrying."
              : "Inspect the selected skill target and retry the command.",
      details: error.details
    });
  }
  if (typeof error === "object" && error !== null && "code" in error && ["EACCES", "EPERM"].includes(String(error.code))) {
    return Object.assign(error, {
      exitCode: EXIT_CODES.permissionDenied,
      suggestedFix: "Choose a writable skill target or fix its directory permissions."
    });
  }
  return annotateProjectLoadError(error);
};

const resolveSkillTarget = async (options: SkillCommandOptions): Promise<SkillInstallTarget> => {
  if (!options.project) {
    if (options.location && options.location.length > 0) {
      throw Object.assign(new Error("--location requires --project."), {
        code: "SKILL_LOCATION_REQUIRES_PROJECT",
        exitCode: EXIT_CODES.generic,
        suggestedFix: "Pass --project <path>, or omit --location for a global install."
      });
    }
    return {
      kind: "global",
      htmlslideHomeDir: path.resolve(process.env.HTMLSLIDE_HOME ?? path.join(os.homedir(), ".htmlslide"))
    };
  }

  const project = await loadProject(options.project);
  const locations = options.location ?? ["project"];
  const allowed = new Set<ProjectSkillInstallLocation>(["project", "codex", "claude"]);
  const invalid = locations.filter((location) => !allowed.has(location as ProjectSkillInstallLocation));
  if (invalid.length > 0) {
    throw Object.assign(new Error(`Unsupported project skill locations: ${invalid.join(", ")}.`), {
      code: "SKILL_LOCATION_INVALID",
      exitCode: EXIT_CODES.generic,
      suggestedFix: "Use --location project, codex, or claude."
    });
  }
  return {
    kind: "project",
    projectRoot: project.projectPath,
    locations: [...new Set(locations)] as ProjectSkillInstallLocation[]
  };
};

const requireCheckpointReference = (options: CheckpointCommandOptions): void => {
  if (!options.runId && !options.checkpointId) {
    throw Object.assign(new Error("Pass --run-id or --checkpoint-id."), {
      code: "CHECKPOINT_REFERENCE_REQUIRED",
      exitCode: EXIT_CODES.generic,
      suggestedFix: "Use the runId from htmlslide agent run output, or pass a checkpoint id."
    });
  }
};

const program = new Command();

program
  .name("htmlslide")
  .description("Local-first CLI for HTMLslide deck projects.")
  .version(HTMLSLIDE_APP_VERSION)
  .option("--json", "print machine-readable JSON");

program
  .command("new")
  .argument("<name>", "deck project folder name")
  .option("--json", "print machine-readable JSON")
  .option("--template <template>", "built-in deck template id", "default")
  .option("--title <title>", "deck title to write into deck.json")
  .description("Create a deck project from a built-in template.")
  .action(async (name: string, options: NewCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const title = options.title?.trim() || path.basename(path.resolve(name));
      const project = await createProject(name, title, { templateId: options.template });
      writeResult(
        { status: "passed", projectPath: project.projectPath, template: options.template ?? "default", title: project.manifest.title },
        json
      );
    } catch (error) {
      fail(error, json);
    }
  });

program
  .command("init")
  .option("--json", "print machine-readable JSON")
  .option("--template <template>", "built-in deck template id", "default")
  .description("Initialize the current directory as a deck project.")
  .action(async (options: NewCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const name = process.cwd().split(/[\\/]/).at(-1) ?? "deck";
      const project = await createProject(process.cwd(), name, { templateId: options.template });
      writeResult(
        { status: "passed", projectPath: project.projectPath, template: options.template ?? "default", title: project.manifest.title },
        json
      );
    } catch (error) {
      fail(error, json);
    }
  });

const templatesCommand = program
  .command("templates")
  .description("Inspect built-in deck templates.");

templatesCommand
  .command("list")
  .option("--json", "print machine-readable JSON")
  .description("List built-in deck templates.")
  .action(async (options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    const templates = listBuiltInDeckTemplates();
    if (json) {
      writeResult({ status: "passed", templates }, true);
      return;
    }
    writeResult(templates.map((template) => `${template.id}\t${template.name}\t${template.summary}`).join("\n"));
  });

program
  .command("open")
  .argument("[path]", "deck project directory or .deckpkg path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .description("Open a deck project or validated deck package in HTMLslide.app.")
  .action(async (targetPath: string, options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      if (targetPath.toLowerCase().endsWith(".deckpkg")) {
        const validated = await validateDeckPackageForPresentation(targetPath);
        writeResult(await launchDesktopTarget("open", validated.deckpkgPath, "deckpkg"), json);
        return;
      }
      const project = await loadProject(targetPath);
      writeResult(await launchDesktopTarget("open", project.projectPath, "project"), json);
    } catch (error) {
      fail(annotateProjectLoadError(error), json);
    }
  });

program
  .command("check")
  .argument("[path]", "deck project path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .description("Validate a deck project and write .htmlslide/reports/check-report.json.")
  .action(async (projectPath: string, options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const loaded = await tryLoadProjectForCheck(projectPath);
      if (!loaded.ok) {
        writeResult(loaded.report, json);
        process.exit(loaded.exitCode);
      }
      const report = await checkLoadedProject(loaded.project);
      writeResult(report, json);
      if (report.status === "failed") {
        process.exit(EXIT_CODES.validationFailed);
      }
    } catch (error) {
      fail(error, json);
    }
  });

program
  .command("export")
  .argument("[path]", "deck project path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .option("--pdf", "export PDF")
  .option("--no-pdf", "skip PDF export")
  .option("--html", "export standalone HTML")
  .option("--no-html", "skip standalone HTML export")
  .option("--deckpkg", "export deckpkg")
  .option("--no-deckpkg", "skip deckpkg export")
  .option("--thumbnails", "export thumbnails")
  .option("--no-thumbnails", "skip thumbnail export")
  .description("Export PDF, HTML, thumbnails, notes, and deckpkg artifacts.")
  .action(async (projectPath: string, options: ExportCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const project = await loadProject(projectPath);
      const report = await checkLoadedProject(project);
      if (report.status === "failed") {
        writeResult(report, json);
        process.exit(EXIT_CODES.validationFailed);
      }
      const result = await exportLoadedProject(project, {
        pdf: options.pdf,
        html: options.html,
        deckpkg: options.deckpkg,
        thumbnails: options.thumbnails
      });
      writeResult({ status: "passed", ...result }, json);
    } catch (error) {
      fail(exportFailure(error), json);
    }
  });

program
  .command("package")
  .argument("[path]", "deck project path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .description("Validate a deck project and export its portable .deckpkg artifact.")
  .action(async (projectPath: string, options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const project = await loadProject(projectPath);
      const report = await checkLoadedProject(project);
      if (report.status === "failed") {
        writeResult(report, json);
        process.exit(EXIT_CODES.validationFailed);
      }
      const result = await packageLoadedProject(project);
      writeResult({ status: "passed", ...result }, json);
    } catch (error) {
      fail(exportFailure(annotateProjectLoadError(error)), json);
    }
  });

program
  .command("present")
  .argument("[file]", "deck project directory or .deckpkg path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .description("Validate a deck package and open it in HTMLslide presenter mode.")
  .action(async (inputPath: string, options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      let deckpkgPath: string;
      if (inputPath.toLowerCase().endsWith(".deckpkg")) {
        deckpkgPath = (await validateDeckPackageForPresentation(inputPath)).deckpkgPath;
      } else {
        const project = await loadProject(inputPath);
        const report = await checkLoadedProject(project);
        if (report.status === "failed") {
          writeResult(report, json);
          process.exit(EXIT_CODES.validationFailed);
        }
        try {
          deckpkgPath = (await packageLoadedProject(project)).deckpkgPath;
        } catch (error) {
          throw exportFailure(error);
        }
        await validateDeckPackageForPresentation(deckpkgPath);
      }
      writeResult(await launchDesktopTarget("present", deckpkgPath, "deckpkg"), json);
    } catch (error) {
      const annotated = annotateProjectLoadError(error);
      const details = annotated instanceof Error ? annotated as CliError : undefined;
      fail(details?.exitCode === EXIT_CODES.exportFailed ? exportFailure(annotated) : annotated, json);
    }
  });

const skillCommand = program.command("skill").description("Inspect and manage HTMLslide skills.");

const addSkillTargetOptions = (command: Command): Command =>
  command
    .option("--project <path>", "install or inspect project-local skills")
    .option("--location <locations...>", "project locations: project, codex, or claude");

addSkillTargetOptions(
  skillCommand
    .command("list")
    .option("--json", "print machine-readable JSON")
    .description("List official skills and installed skill integrity.")
).action(async (options: SkillCommandOptions) => {
  const json = Boolean(options.json ?? program.opts<JsonOption>().json);
  try {
    const target = await resolveSkillTarget(options);
    const installed = await listInstalledSkills({ target });
    const official = OFFICIAL_SKILLS.map((skill) => ({
      name: skill.metadata.name,
      version: skill.metadata.version,
      description: skill.metadata.description,
      license: skill.metadata.license,
      riskLevel: skill.metadata.riskLevel,
      installed: installed.skills
        .filter((entry) => entry.name === skill.metadata.name)
        .map((entry) => ({ location: entry.location, integrity: entry.integrity }))
    }));
    writeResult(
      {
        status: installed.invalid.length > 0 ? "warning" : "passed",
        command: "skill list",
        target: target.kind,
        official,
        installed: installed.skills,
        invalid: installed.invalid
      },
      json
    );
  } catch (error) {
    fail(annotateSkillError(error), json);
  }
});

addSkillTargetOptions(
  skillCommand
    .command("add")
    .argument("<path-or-url>", "official skill name, local file/directory, or HTTPS SKILL.md URL")
    .option("--yes", "confirm declared risk and license warnings")
    .option("--json", "print machine-readable JSON")
    .description("Validate and atomically install a managed skill.")
).action(async (source: string, options: SkillCommandOptions) => {
  const json = Boolean(options.json ?? program.opts<JsonOption>().json);
  try {
    const target = await resolveSkillTarget(options);
    const result = await installSkill({
      source,
      target,
      confirmWarnings: options.yes
    });
    writeResult({ status: "passed", command: "skill add", ...result }, json);
  } catch (error) {
    fail(annotateSkillError(error), json);
  }
});

addSkillTargetOptions(
  skillCommand
    .command("remove")
    .argument("<name>", "installed skill name")
    .option("--yes", "confirm managed skill removal")
    .option("--json", "print machine-readable JSON")
    .description("Remove only an integrity-verified HTMLslide-managed skill.")
).action(async (name: string, options: SkillCommandOptions) => {
  const json = Boolean(options.json ?? program.opts<JsonOption>().json);
  try {
    if (!options.yes) {
      throw Object.assign(new Error("Skill removal requires --yes."), {
        code: "SKILL_REMOVE_CONFIRMATION_REQUIRED",
        exitCode: EXIT_CODES.generic,
        suggestedFix: "Inspect the installed skill, then rerun with --yes."
      });
    }
    const target = await resolveSkillTarget(options);
    const result = await removeSkill({ target, name });
    writeResult({ status: "passed", command: "skill remove", ...result }, json);
  } catch (error) {
    fail(annotateSkillError(error), json);
  }
});

addSkillTargetOptions(
  skillCommand
    .command("inspect")
    .argument("<name>", "official or installed skill name")
    .option("--json", "print machine-readable JSON")
    .description("Inspect official metadata and installed skill integrity.")
).action(async (name: string, options: SkillCommandOptions) => {
  const json = Boolean(options.json ?? program.opts<JsonOption>().json);
  try {
    const target = await resolveSkillTarget(options);
    const officialSkill = getOfficialSkill(name);
    let installed: Awaited<ReturnType<typeof inspectInstalledSkill>> = [];
    try {
      installed = await inspectInstalledSkill({ target, name });
    } catch (error) {
      if (!(error instanceof SkillStoreError) || error.code !== "SKILL_NOT_FOUND") {
        throw error;
      }
    }
    if (!officialSkill && installed.length === 0) {
      throw new SkillStoreError("SKILL_NOT_FOUND", `Skill not found: ${name}.`);
    }
    writeResult(
      {
        status: "passed",
        command: "skill inspect",
        target: target.kind,
        official: officialSkill
          ? {
              metadata: officialSkill.metadata,
              markdown: officialSkill.markdown
            }
          : undefined,
        installed
      },
      json
    );
  } catch (error) {
    fail(annotateSkillError(error), json);
  }
});

const setupCommand = program.command("setup").description("Install, inspect, or remove local HTMLslide setup helpers.");

setupCommand
  .command("install-cli")
  .option("--json", "print machine-readable JSON")
  .option("--target-dir <dir>", "directory where the htmlslide shim should be written")
  .option("--target-path <path>", "complete path where the htmlslide shim should be written")
  .option("--app-path <path>", "HTMLslide.app path to record in ~/.htmlslide/app-path.json")
  .option("--app-version <version>", "HTMLslide.app version to record in ~/.htmlslide/app-path.json")
  .option("--bundle-id <id>", "HTMLslide bundle identifier to record in ~/.htmlslide/app-path.json")
  .option("--fallback-cli-path <path>", "development CLI entrypoint used when no app path is configured")
  .option("--updated-at <iso>", "timestamp to record in ~/.htmlslide/app-path.json")
  .description("Install or update the local htmlslide command shim.")
  .action(async (options: SetupCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await installCliShim({
        appVersion: options.appVersion,
        targetDir: options.targetDir,
        targetPath: options.targetPath,
        appPath: options.appPath,
        bundleId: options.bundleId,
        fallbackCliPath: options.fallbackCliPath,
        updatedAt: options.updatedAt
      });
      writeResult(result, json);
    } catch (error) {
      fail(error, json);
    }
  });

setupCommand
  .command("uninstall-cli")
  .option("--json", "print machine-readable JSON")
  .option("--target-dir <dir>", "directory containing the htmlslide shim")
  .option("--target-path <path>", "complete path to the htmlslide shim")
  .description("Remove an HTMLslide-managed local htmlslide command shim.")
  .action(async (options: SetupCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await uninstallCliShim({
        targetDir: options.targetDir,
        targetPath: options.targetPath
      });
      writeResult(result, json);
    } catch (error) {
      fail(error, json);
    }
  });

setupCommand
  .command("status")
  .option("--json", "print machine-readable JSON")
  .option("--target-dir <dir>", "directory containing the htmlslide shim")
  .option("--target-path <path>", "complete path to the htmlslide shim")
  .description("Report HTMLslide CLI shim installation status.")
  .action(async (options: SetupCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await getCliShimStatus({
        targetDir: options.targetDir,
        targetPath: options.targetPath
      });
      writeResult({ command: "setup status", ...result }, json);
      if (result.status === "failed") {
        process.exit(EXIT_CODES.generic);
      }
    } catch (error) {
      fail(error, json);
    }
  });

program
  .command("doctor")
  .option("--json", "print machine-readable JSON")
  .description("Report local HTMLslide runtime health.")
  .action(async (options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const report = await doctor();
      writeResult(report, json);
      if (report.status === "failed") {
        process.exit(EXIT_CODES.missingDependency);
      }
    } catch (error) {
      fail(error, json);
    }
  });

const agentCommand = program.command("agent").description("Inspect or run configured AI engines.");

agentCommand
  .command("engines")
  .option("--json", "print machine-readable JSON")
  .description("List known AI engine adapters.")
  .action((options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    writeResult({ status: "passed", engines: listAgentEngines() }, json);
  });

agentCommand
  .command("run")
  .requiredOption("--engine <engine>", "agent engine id from htmlslide agent engines")
  .requiredOption("--task <task>", "task or brief for the agent run")
  .option("--path <path>", "deck project path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .description("Run an agent task with a configured engine.")
  .action(async (options: AgentRunCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await runAgentTask({
        engine: options.engine,
        task: options.task,
        projectPath: options.path
      });
      writeResult(result, json);
      if (!result.ok) {
        process.exit(EXIT_CODES.agentFailed);
      }
    } catch (error) {
      fail(error, json);
    }
  });

agentCommand
  .command("validate-provider")
  .requiredOption("--provider <provider>", "provider id: openai, anthropic, or compatible")
  .requiredOption("--model <model>", "provider model id to validate")
  .requiredOption("--api-key-env <name>", "environment variable that contains the provider API key")
  .option("--base-url <url>", "OpenAI-compatible provider API root")
  .option("--json", "print machine-readable JSON")
  .description("Validate BYOK provider credentials without printing the API key.")
  .action(async (options: AgentValidateProviderCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await validateAgentProviderCredentials({
        apiKeyEnv: options.apiKeyEnv,
        baseUrl: options.baseUrl,
        model: options.model,
        provider: options.provider
      });
      writeResult(result, json);
      if (result.status === "failed") {
        process.exit(result.exitCode);
      }
    } catch (error) {
      fail(error, json);
    }
  });

const checkpointCommand = program.command("checkpoint").description("Inspect or revert agent checkpoints.");

checkpointCommand
  .command("diff")
  .option("--path <path>", "deck project path", process.cwd())
  .option("--run-id <runId>", "agent run id")
  .option("--checkpoint-id <checkpointId>", "checkpoint id")
  .option("--json", "print machine-readable JSON")
  .description("Show source file changes since a checkpoint.")
  .action(async (options: CheckpointCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      requireCheckpointReference(options);
      const diff = await diffCheckpoint({
        projectPath: options.path,
        runId: options.runId,
        checkpointId: options.checkpointId
      });
      writeResult({ status: "passed", ...diff }, json);
    } catch (error) {
      fail(error, json);
    }
  });

checkpointCommand
  .command("revert")
  .option("--path <path>", "deck project path", process.cwd())
  .option("--run-id <runId>", "agent run id")
  .option("--checkpoint-id <checkpointId>", "checkpoint id")
  .option("--yes", "confirm destructive checkpoint revert")
  .option("--json", "print machine-readable JSON")
  .description("Revert source files to a checkpoint after explicit confirmation.")
  .action(async (options: CheckpointCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      requireCheckpointReference(options);
      if (!options.yes) {
        throw Object.assign(new Error("Checkpoint revert requires --yes."), {
          code: "CHECKPOINT_REVERT_CONFIRMATION_REQUIRED",
          exitCode: EXIT_CODES.generic,
          suggestedFix: "Rerun with --yes after reviewing the checkpoint diff."
        });
      }
      const reverted = await revertCheckpoint({
        projectPath: options.path,
        runId: options.runId,
        checkpointId: options.checkpointId
      });
      writeResult({ status: "passed", ...reverted }, json);
    } catch (error) {
      fail(error, json);
    }
  });

program
  .command("mcp")
  .argument("[path]", "deck project path", process.cwd())
  .option("--json", "print machine-readable JSON")
  .option("--list-tools", "list registered HTMLslide MCP tools without opening a project")
  .option("--status", "validate that the alpha in-process MCP harness can start for a deck project")
  .description("Inspect the HTMLslide MCP server harness and registry.")
  .action(async (projectPath: string, options: McpCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      if (options.status && options.listTools) {
        throw Object.assign(new Error("Use either `--list-tools` or `--status`, not both."), {
          code: "MCP_DIAGNOSTIC_MODE_CONFLICT",
          exitCode: EXIT_CODES.generic,
          suggestedFix: "Run `htmlslide mcp --list-tools --json` or `htmlslide mcp <project-path> --status --json`."
        });
      }

      if (options.listTools) {
        const toolSummary = summarizeHtmlslideMcpTools();
        if (json) {
          writeResult({
            status: "passed",
            command: "mcp list-tools",
            ...toolSummary,
            toolCount: toolSummary.registeredToolCount,
            tools: htmlslideTools
          }, true);
          return;
        }
        writeResult(
          htmlslideTools
            .map((tool) => {
              const lifecycle = tool.deprecated ? "deprecated" : "current";
              const implementation = tool.implemented ? "implemented" : "planned";
              return `${tool.name}\t${tool.safety}\t${implementation}\t${lifecycle}\t${tool.description}`;
            })
            .join("\n")
        );
        return;
      }

      if (!options.status) {
        if (json) {
          throw Object.assign(new Error("`--json` is only valid with `htmlslide mcp --list-tools` or `htmlslide mcp --status`."), {
            code: "MCP_JSON_REQUIRES_DIAGNOSTIC_MODE",
            exitCode: EXIT_CODES.generic,
            suggestedFix: "Remove `--json` to start the stdio MCP server, or add `--status` for a one-shot JSON status check."
          });
        }
        await startHtmlslideMcpStdioServer({
          projectRoot: projectPath
        });
        return;
      }

      const server = createHtmlslideMcpServer({
        projectRoot: projectPath
      });
      const started = await server.start();
      const tools = server.listTools();
      if (json) {
        const { status: mcpStatus, ...startedResult } = started;
        writeResult({
          status: "passed",
          command: "mcp status",
          transport: "in-process",
          mcpStatus,
          ...startedResult,
          tools
        }, true);
        return;
      }
      writeResult(
        `MCP alpha harness ready for ${started.projectRoot}\n${started.registeredToolCount} tools registered\n${started.implementedToolCount} tools implemented\ntransport: in-process`
      );
    } catch (error) {
      const annotatedError = annotateProjectLoadError(error);
      if (!options.listTools && !options.status) {
        failStdioStartup(annotatedError);
      }
      fail(annotatedError, json);
    }
  });

const jsonArgumentRequested = process.argv.slice(2).includes("--json");
const configureCommanderErrors = (command: Command): void => {
  if (jsonArgumentRequested) {
    command.configureOutput({
      writeErr: () => undefined
    });
  }
  command.exitOverride();
  command.commands.forEach(configureCommanderErrors);
};
configureCommanderErrors(program);
void program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) {
      process.exit(0);
    }
    if (jsonArgumentRequested) {
      writeResult(
        {
          status: "failed",
          error: error.message,
          code: "CLI_ARGUMENT_ERROR",
          exitCode: EXIT_CODES.generic,
          suggestedFix: "Run the command with --help and correct its arguments or options.",
          details: { commanderCode: error.code }
        },
        true
      );
    }
    process.exit(error.exitCode || EXIT_CODES.generic);
  }
  fail(error, jsonArgumentRequested);
});
