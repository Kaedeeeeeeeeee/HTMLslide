#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { listBuiltInDeckTemplates } from "@htmlslide/core/templates";
import { HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import {
  checkLoadedProject,
  createProject,
  diffCheckpoint,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  getCliShimStatus,
  installCliShim,
  listAgentEngines,
  loadProject,
  revertCheckpoint,
  runAgentTask,
  tryLoadProjectForCheck,
  uninstallCliShim
} from "../index.js";

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

type CheckpointCommandOptions = JsonOption & {
  path?: string;
  runId?: string;
  checkpointId?: string;
  yes?: boolean;
};

type CliError = Error & {
  code?: string;
  exitCode?: number;
  suggestedFix?: string;
  targetPath?: string;
  targetDir?: string;
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
      targetDir: details?.targetDir
    },
    json
  );
  process.exit(exitCode);
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
      fail(error, json);
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
      writeResult(await doctor(), json);
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

program.parseAsync(process.argv);
