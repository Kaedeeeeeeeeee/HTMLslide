import { spawn } from "node:child_process";

import type { CommandInvocation, CommandResult } from "./types.js";

export const COMMAND_CAPTURE_LIMIT_CHARS = 1024 * 1024;
export const COMMAND_CAPTURE_TRUNCATION_MARKER = `\n[HTMLslide: output truncated after ${COMMAND_CAPTURE_LIMIT_CHARS} characters]\n`;
const POST_EXIT_PIPE_DRAIN_GRACE_MS = 500;
const SAFE_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "HTMLSLIDE_HOME"
] as const;

export function runCommand(invocation: CommandInvocation): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      detached: isolatedProcessGroup,
      env: createCommandEnvironment(invocation),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutCapture = createBoundedCapture();
    const stderrCapture = createBoundedCapture();
    let timedOut = false;
    let cancelled = false;
    let completed = false;
    let exited = false;
    let closed = false;
    let terminationRequested = false;
    let treeTerminationStarted = false;
    let treeFinalized = false;
    let spawnError: unknown;
    let directExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let postExitPipeDrainTimeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
      if (postExitPipeDrainTimeout !== undefined) {
        clearTimeout(postExitPipeDrainTimeout);
        postExitPipeDrainTimeout = undefined;
      }
      invocation.signal?.removeEventListener("abort", cancelRun);
      child.stdout.removeListener("data", handleStdout);
      child.stderr.removeListener("data", handleStderr);
      child.removeListener("error", handleError);
      child.removeListener("exit", handleExit);
      child.removeListener("close", handleClose);
    };

    const complete = (result: CommandResult): void => {
      if (completed) {
        return;
      }
      completed = true;
      cleanup();
      resolve(result);
    };

    const completeWithExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const stdout = stdoutCapture.read();
      const stderr = stderrCapture.read();
      complete({
        exitCode: code ?? 1,
        stdout,
        stderr: spawnError === undefined ? stderr : [stderr, formatSpawnError(spawnError)].filter(Boolean).join("\n"),
        timedOut,
        cancelled,
        signal: signal ?? undefined
      });
    };

    const signalProcessTree = (signal: NodeJS.Signals): boolean => {
      if (isolatedProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
          }
          throw error;
        }
      }
      return child.kill(signal);
    };

    const processTreeAlive = (): boolean => {
      if (!isolatedProcessGroup || child.pid === undefined) {
        return !exited && !closed;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const finalizeTree = (): void => {
      treeFinalized = true;
      child.stdout.destroy();
      child.stderr.destroy();
      if (directExit !== undefined) {
        completeWithExit(directExit.code, directExit.signal);
      }
    };

    const beginTreeTermination = (graceMs: number): void => {
      if (treeFinalized || completed) {
        return;
      }
      if (!treeTerminationStarted) {
        treeTerminationStarted = true;
        signalProcessTree("SIGTERM");
      }
      if (forceKillTimeout !== undefined) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        forceKillTimeout = undefined;
        if (processTreeAlive()) {
          signalProcessTree("SIGKILL");
        }
        finalizeTree();
      }, graceMs);
      forceKillTimeout.unref();
    };

    const terminate = (): void => {
      if (terminationRequested || treeFinalized || completed) {
        return;
      }

      terminationRequested = true;
      beginTreeTermination(1_000);
    };

    function cancelRun(): void {
      cancelled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      terminate();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
    child.once("error", handleError);
    child.once("exit", handleExit);
    child.once("close", handleClose);

    function handleStdout(chunk: string): void {
      stdoutCapture.append(chunk);
      invocation.onOutput?.({
        stream: "stdout",
        text: chunk
      });
    }

    function handleStderr(chunk: string): void {
      stderrCapture.append(chunk);
      invocation.onOutput?.({
        stream: "stderr",
        text: chunk
      });
    }

    function handleError(error: unknown): void {
      spawnError = error;
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
      exited = true;
      directExit = { code, signal };
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (treeFinalized) {
        completeWithExit(code, signal);
        return;
      }

      if (processTreeAlive()) {
        beginTreeTermination(terminationRequested ? 1_000 : POST_EXIT_PIPE_DRAIN_GRACE_MS);
        return;
      }

      postExitPipeDrainTimeout = setTimeout(() => {
        postExitPipeDrainTimeout = undefined;
        finalizeTree();
      }, POST_EXIT_PIPE_DRAIN_GRACE_MS);
      postExitPipeDrainTimeout.unref();
    }

    function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
      closed = true;
      exited = true;
      directExit ??= { code, signal };
      if (treeFinalized) {
        completeWithExit(directExit.code, directExit.signal);
        return;
      }
      if (processTreeAlive()) {
        beginTreeTermination(terminationRequested ? 1_000 : POST_EXIT_PIPE_DRAIN_GRACE_MS);
        return;
      }
      treeFinalized = true;
      completeWithExit(code, signal);
    }

    if (invocation.timeoutMs !== undefined && invocation.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timeout = undefined;
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

function createCommandEnvironment(invocation: CommandInvocation): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  if (invocation.inheritEnv === true) {
    Object.assign(environment, process.env);
  } else {
    for (const key of SAFE_ENVIRONMENT_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        environment[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(invocation.env ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }

  return environment;
}

interface BoundedCapture {
  append(chunk: string): void;
  read(): string;
}

// Capture is capped per stream in UTF-16 code units; pipes continue to be drained after truncation.
function createBoundedCapture(): BoundedCapture {
  let captured = "";
  let truncated = false;

  return {
    append(chunk: string): void {
      if (truncated) {
        return;
      }

      const remaining = COMMAND_CAPTURE_LIMIT_CHARS - captured.length;
      if (chunk.length <= remaining) {
        captured += chunk;
        return;
      }

      captured += chunk.slice(0, remaining);
      captured += COMMAND_CAPTURE_TRUNCATION_MARKER;
      truncated = true;
    },
    read(): string {
      return captured;
    }
  };
}

function formatSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
