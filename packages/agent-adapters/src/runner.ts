import { spawn } from "node:child_process";

import type { CommandInvocation, CommandResult } from "./types.js";

export function runCommand(invocation: CommandInvocation): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let completed = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      invocation.signal?.removeEventListener("abort", cancelRun);
    };

    const complete = (result: CommandResult): void => {
      if (completed) {
        return;
      }
      completed = true;
      cleanup();
      resolve(result);
    };

    const terminate = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }

      forceKillTimeout = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      forceKillTimeout.unref();
    };

    function cancelRun(): void {
      cancelled = true;
      terminate();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      complete({
        exitCode: 1,
        stdout,
        stderr: [stderr, formatSpawnError(error)].filter(Boolean).join("\n"),
        timedOut,
        cancelled
      });
    });

    child.once("close", (code, signal) => {
      complete({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        cancelled,
        signal: signal ?? undefined
      });
    });

    if (invocation.timeoutMs !== undefined && invocation.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, invocation.timeoutMs);
      timeout.unref();
    }

    if (invocation.signal?.aborted === true) {
      cancelRun();
    } else {
      invocation.signal?.addEventListener("abort", cancelRun, { once: true });
    }
  });
}

function formatSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
