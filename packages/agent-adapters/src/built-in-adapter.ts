import path from "node:path";

import { assertPathInsideProject, validateReportedFileWritesOnDisk } from "./boundary.js";
import { claudeCliCapabilities, codexCliCapabilities } from "./detectors.js";
import { createAgentAdapterFailure, toAgentAdapterFailure } from "./failures.js";
import { runCommand } from "./runner.js";
import {
  collectSensitiveValues,
  createCommandOutputRedactor,
  sanitizeAgentAdapterText,
  sanitizeRenderedCommand
} from "./sanitization.js";
import type {
  AgentAdapterDescriptor,
  AgentAdapterRunFailure,
  AgentAdapterRunResult,
  CommandOutputChunk,
  CommandRunner,
  RenderedCommand
} from "./types.js";

export type BuiltInExternalAgentKind = "claude-code" | "codex-cli";

export interface BuiltInExternalAgentDescriptor extends AgentAdapterDescriptor {
  readonly kind: BuiltInExternalAgentKind;
  readonly command: string;
}

export interface BuildBuiltInExternalAgentCommandOptions {
  readonly kind: BuiltInExternalAgentKind;
  readonly command?: string;
  readonly projectRoot: string;
  readonly promptFile: string;
}

export interface RunBuiltInExternalAgentAdapterOptions extends BuildBuiltInExternalAgentCommandOptions {
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onOutput?: (chunk: CommandOutputChunk) => void;
  readonly readReportedFileWrites?: () => Promise<readonly string[]>;
}

export function createBuiltInExternalAgentDescriptor(
  kind: BuiltInExternalAgentKind,
  command?: string
): BuiltInExternalAgentDescriptor {
  if (kind === "claude-code") {
    return {
      id: "claude-code",
      label: "Claude Code",
      kind,
      command: command ?? "claude",
      capabilities: claudeCliCapabilities()
    };
  }

  return {
    id: "codex-cli",
    label: "Codex CLI",
    kind,
    command: command ?? "codex",
    capabilities: codexCliCapabilities()
  };
}

export function buildBuiltInExternalAgentCommand(
  options: BuildBuiltInExternalAgentCommandOptions
): RenderedCommand {
  const projectRoot = path.resolve(options.projectRoot);
  const promptFile = assertPathInsideProject(projectRoot, options.promptFile, "promptFile");
  const descriptor = createBuiltInExternalAgentDescriptor(options.kind, options.command);
  const prompt = buildTaskPrompt(promptFile);

  if (options.kind === "claude-code") {
    return {
      command: descriptor.command,
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-chrome",
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Glob,Grep,Edit,Write",
        "--no-session-persistence",
        prompt
      ]
    };
  }

  return {
    command: descriptor.command,
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--json",
      "--color",
      "never",
      "-C",
      projectRoot,
      prompt
    ]
  };
}

export async function runBuiltInExternalAgentAdapter(
  options: RunBuiltInExternalAgentAdapterOptions
): Promise<AgentAdapterRunResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const adapter = createBuiltInExternalAgentDescriptor(options.kind, options.command);
  let command: RenderedCommand | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let reportedWrites: readonly string[] | undefined;
  const sensitiveValues = collectSensitiveValues(process.env);
  const outputRedactor = createCommandOutputRedactor(sensitiveValues);

  try {
    command = buildBuiltInExternalAgentCommand({
      kind: options.kind,
      command: options.command,
      projectRoot,
      promptFile: options.promptFile
    });

    const runner = options.runner ?? runCommand;
    const commandResult = await runner({
      command: command.command,
      args: command.args,
      cwd: projectRoot,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onOutput: (chunk) => {
        const safeChunk = outputRedactor.push(chunk);
        if (safeChunk.text.length > 0) {
          options.onOutput?.(safeChunk);
        }
      }
    });

    stdout = commandResult.stdout;
    stderr = commandResult.stderr;
    for (const chunk of outputRedactor.flush()) {
      if (chunk.text.length > 0) {
        options.onOutput?.(chunk);
      }
    }
    const safeCommand = sanitizeRenderedCommand(command, sensitiveValues);
    const safeStdout = sanitizeAgentAdapterText(stdout, sensitiveValues);
    const safeStderr = sanitizeAgentAdapterText(stderr, sensitiveValues);
    if (safeCommand === undefined) {
      throw new Error("Agent command was not rendered.");
    }

    if (commandResult.cancelled === true || options.signal?.aborted === true) {
      return createRunFailure(adapter, projectRoot, {
        command: safeCommand,
        stdout: safeStdout,
        stderr: safeStderr,
        failure: createAgentAdapterFailure("cancelled")
      });
    }

    if (commandResult.timedOut === true) {
      return createRunFailure(adapter, projectRoot, {
        command: safeCommand,
        stdout: safeStdout,
        stderr: safeStderr,
        failure: createAgentAdapterFailure("run-timeout", {
          detail: `Timeout: ${options.timeoutMs}ms.`
        })
      });
    }

    if (commandResult.exitCode !== 0) {
      return createRunFailure(adapter, projectRoot, {
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
      adapter,
      command: safeCommand,
      cwd: projectRoot,
      stdout: safeStdout ?? "",
      stderr: safeStderr ?? "",
      reportedWrites: normalizedWrites
    };
  } catch (error) {
    return createRunFailure(adapter, projectRoot, {
      command: sanitizeRenderedCommand(command, sensitiveValues),
      stdout: sanitizeAgentAdapterText(stdout, sensitiveValues),
      stderr: sanitizeAgentAdapterText(stderr, sensitiveValues),
      reportedWrites,
      failure: (() => {
        const failure = toAgentAdapterFailure(error);
        return {
          ...failure,
          message: sanitizeAgentAdapterText(failure.message, sensitiveValues) ?? failure.message,
          detail: sanitizeAgentAdapterText(failure.detail, sensitiveValues),
          command: sanitizeAgentAdapterText(failure.command, sensitiveValues)
        };
      })()
    });
  }
}

function buildTaskPrompt(promptFile: string): string {
  return [
    `Read and follow the HTMLslide task instructions in ${promptFile}.`,
    "Only edit source files in deck.json, slides/, notes/, theme/, and assets/; do not modify assets/sources/ reference material.",
    "Do not edit exports/ or .htmlslide/."
  ].join(" ");
}

function createRunFailure(
  adapter: BuiltInExternalAgentDescriptor,
  projectRoot: string,
  fields: Omit<AgentAdapterRunFailure, "ok" | "status" | "adapter" | "cwd">
): AgentAdapterRunFailure {
  return {
    ok: false,
    status: fields.failure.type === "cancelled" ? "cancelled" : "failed",
    adapter,
    cwd: projectRoot,
    ...fields
  };
}
