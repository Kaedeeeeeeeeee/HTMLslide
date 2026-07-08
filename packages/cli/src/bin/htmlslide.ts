#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  checkLoadedProject,
  createProject,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  listAgentEngines,
  loadProject,
  tryLoadProjectForCheck
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
  const exitCode =
    typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number"
      ? error.exitCode
      : EXIT_CODES.generic;
  writeResult({ status: "failed", error: message, exitCode }, json);
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

program
  .command("doctor")
  .option("--json", "print machine-readable JSON")
  .description("Report local HTMLslide runtime health.")
  .action((options: JsonOption) => {
    const json = Boolean(options.json ?? program.opts<JsonOption>().json);
    writeResult(doctor(), json);
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
