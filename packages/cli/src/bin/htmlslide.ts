#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  checkLoadedProject,
  createProject,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  getCliShimStatus,
  installCliShim,
  listAgentEngines,
  loadProject,
  tryLoadProjectForCheck,
  uninstallCliShim
} from "../index.js";

type JsonOption = {
  json?: boolean;
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
  fallbackCliPath?: string;
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

const program = new Command();

program
  .name("htmlslide")
  .description("Local-first CLI for HTMLslide deck projects.")
  .version("0.1.0")
  .option("--json", "print machine-readable JSON");

program
  .command("new")
  .argument("<name>", "deck project folder name")
  .option("--json", "print machine-readable JSON")
  .description("Create a deck project from the default template.")
  .action(async (name: string, options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const project = await createProject(name, path.basename(path.resolve(name)));
      writeResult({ status: "passed", projectPath: project.projectPath, title: project.manifest.title }, json);
    } catch (error) {
      fail(error, json);
    }
  });

program
  .command("init")
  .option("--json", "print machine-readable JSON")
  .description("Initialize the current directory as a deck project.")
  .action(async (options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const name = process.cwd().split(/[\\/]/).at(-1) ?? "deck";
      const project = await createProject(process.cwd(), name);
      writeResult({ status: "passed", projectPath: project.projectPath, title: project.manifest.title }, json);
    } catch (error) {
      fail(error, json);
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
  .option("--fallback-cli-path <path>", "development CLI entrypoint used when no app path is configured")
  .description("Install or update the local htmlslide command shim.")
  .action(async (options: SetupCommandOptions) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    try {
      const result = await installCliShim({
        targetDir: options.targetDir,
        targetPath: options.targetPath,
        appPath: options.appPath,
        fallbackCliPath: options.fallbackCliPath
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

program
  .command("agent")
  .description("Inspect or run configured AI engines.")
  .command("engines")
  .option("--json", "print machine-readable JSON")
  .description("List known AI engine adapters.")
  .action((options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    writeResult({ status: "passed", engines: listAgentEngines() }, json);
  });

program.parseAsync(process.argv);
