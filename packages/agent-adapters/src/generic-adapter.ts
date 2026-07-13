import fs from "node:fs/promises";
import path from "node:path";

import { assertPathInsideProject, validateReportedFileWritesOnDisk } from "./boundary.js";
import { AgentAdapterFailureError, createAgentAdapterFailure, toAgentAdapterFailure } from "./failures.js";
import { runCommand } from "./runner.js";
import {
  collectSensitiveValues,
  collectProvidedValues,
  createCommandOutputRedactor,
  sanitizeAgentAdapterText,
  sanitizeRenderedCommand
} from "./sanitization.js";
import { renderCommandTemplate } from "./template.js";
import type {
  AgentAdapterRunFailure,
  AgentAdapterRunResult,
  GenericAgentRunOptions,
  RenderedCommand
} from "./types.js";

export async function runGenericAgentAdapter(options: GenericAgentRunOptions): Promise<AgentAdapterRunResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const variables: Readonly<Record<string, string | undefined>> = {
    projectPath: projectRoot,
    projectRoot,
    promptFile: options.promptFile,
    ...options.variables
  };
  const sensitiveValues = [
    ...collectSensitiveValues(process.env, variables),
    ...collectProvidedValues(options.env)
  ];
  const outputRedactor = createCommandOutputRedactor(sensitiveValues);

  let renderedCommand: RenderedCommand | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let reportedWrites: readonly string[] | undefined;

  try {
    renderedCommand = renderCommandTemplate(options.adapter.commandTemplate, {
      projectRoot,
      variables,
      pathVariables: options.adapter.pathVariables
    });

    const runner = options.runner ?? runCommand;
    const commandResult = await runner({
      command: renderedCommand.command,
      args: renderedCommand.args,
      cwd: projectRoot,
      inheritEnv: false,
      env: options.env,
      onOutput: (chunk) => {
        const safeChunk = outputRedactor.push(chunk);
        if (safeChunk.text.length > 0) {
          options.onOutput?.(safeChunk);
        }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? options.adapter.timeoutMs
    });

    stdout = commandResult.stdout;
    stderr = commandResult.stderr;
    for (const chunk of outputRedactor.flush()) {
      if (chunk.text.length > 0) {
        options.onOutput?.(chunk);
      }
    }
    const safeCommand = sanitizeRenderedCommand(renderedCommand, sensitiveValues);
    const safeStdout = sanitizeAgentAdapterText(stdout, sensitiveValues);
    const safeStderr = sanitizeAgentAdapterText(stderr, sensitiveValues);
    if (safeCommand === undefined) {
      throw new Error("Agent command was not rendered.");
    }

    if (commandResult.cancelled === true || options.signal?.aborted === true) {
      return createRunFailure(options, projectRoot, {
        command: safeCommand,
        stdout: safeStdout,
        stderr: safeStderr,
        failure: createAgentAdapterFailure("cancelled")
      });
    }

    if (commandResult.timedOut === true) {
      return createRunFailure(options, projectRoot, {
        command: safeCommand,
        stdout: safeStdout,
        stderr: safeStderr,
        failure: createAgentAdapterFailure("run-timeout", {
          detail: `Timeout: ${options.timeoutMs ?? options.adapter.timeoutMs}ms.`
        })
      });
    }

    if (commandResult.exitCode !== 0) {
      return createRunFailure(options, projectRoot, {
        command: safeCommand,
        stdout: safeStdout,
        stderr: safeStderr,
        failure: createAgentAdapterFailure("command-failed", {
          command: [safeCommand?.command, ...(safeCommand?.args ?? [])].filter(Boolean).join(" "),
          detail: safeStderr || safeStdout,
          exitCode: commandResult.exitCode
        })
      });
    }

    reportedWrites = options.readReportedFileWrites === undefined ? [] : await options.readReportedFileWrites();
    const normalizedWrites = await validateReportedFileWritesOnDisk(projectRoot, reportedWrites);

    return {
      ok: true,
      status: "completed",
      adapter: options.adapter,
      command: safeCommand,
      cwd: projectRoot,
      stdout: safeStdout ?? "",
      stderr: safeStderr ?? "",
      reportedWrites: normalizedWrites
    };
  } catch (error) {
    const failure = toAgentAdapterFailure(error);
    return createRunFailure(options, projectRoot, {
      command: sanitizeRenderedCommand(renderedCommand, sensitiveValues),
      stdout: sanitizeAgentAdapterText(stdout, sensitiveValues),
      stderr: sanitizeAgentAdapterText(stderr, sensitiveValues),
      reportedWrites,
      failure: {
        ...failure,
        message: sanitizeAgentAdapterText(failure.message, sensitiveValues) ?? failure.message,
        detail: sanitizeAgentAdapterText(failure.detail, sensitiveValues),
        command: sanitizeAgentAdapterText(failure.command, sensitiveValues)
      }
    });
  }
}

export async function readJsonFileWriteManifest(projectRoot: string, manifestPath: string): Promise<string[]> {
  const resolvedManifestPath = assertPathInsideProject(projectRoot, manifestPath, "write manifest");
  const manifest = JSON.parse(await fs.readFile(resolvedManifestPath, "utf8")) as unknown;

  if (Array.isArray(manifest) && manifest.every((entry) => typeof entry === "string")) {
    return manifest;
  }

  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "writes" in manifest &&
    Array.isArray(manifest.writes) &&
    manifest.writes.every((entry) => typeof entry === "string")
  ) {
    return manifest.writes;
  }

  throw new AgentAdapterFailureError(
    createAgentAdapterFailure("command-failed", {
      detail: "Write manifest must be a string array or an object with a string[] writes property.",
      path: resolvedManifestPath
    })
  );
}

function createRunFailure(
  options: GenericAgentRunOptions,
  projectRoot: string,
  fields: Omit<AgentAdapterRunFailure, "ok" | "status" | "adapter" | "cwd">
): AgentAdapterRunFailure {
  return {
    ok: false,
    status: fields.failure.type === "cancelled" ? "cancelled" : "failed",
    adapter: options.adapter,
    cwd: projectRoot,
    ...fields
  };
}
