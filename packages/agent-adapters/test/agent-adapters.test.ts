import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBuiltInExternalAgentCommand,
  COMMAND_CAPTURE_LIMIT_CHARS,
  COMMAND_CAPTURE_TRUNCATION_MARKER,
  createBuiltInExternalAgentDescriptor,
  createCapabilitySet,
  detectClaudeCli,
  detectCodexCli,
  detectGeminiCli,
  readJsonFileWriteManifest,
  renderCommandTemplate,
  runBuiltInExternalAgentAdapter,
  runCommand,
  runGenericAgentAdapter,
  validateReportedFileWrites,
  type CommandRunner,
  type GenericAgentAdapterConfig
} from "../src/index.js";

describe("external agent detector helpers", () => {
  it("reports not installed without invoking a real Claude CLI", async () => {
    const runner: CommandRunner = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };

    const result = await detectClaudeCli({ runner });

    expect(result.status).toBe("not-installed");
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.failure?.type).toBe("agent-not-installed");
  });

  it("reports installed but not authenticated without requiring a real Codex login", async () => {
    const runner: CommandRunner = async (invocation) => {
      if (invocation.args.includes("--version")) {
        return {
          exitCode: 0,
          stdout: "codex 1.2.3\n",
          stderr: ""
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "login required\n"
      };
    };

    const result = await detectCodexCli({ runner });

    expect(result.status).toBe("not-authenticated");
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.version).toBe("codex 1.2.3");
    expect(result.failure?.type).toBe("not-authenticated");
  });

  it("detects ready fake Claude and Codex commands without real CLI logins", async () => {
    const invocations: string[] = [];
    const runner: CommandRunner = async (invocation) => {
      invocations.push([invocation.command, ...invocation.args].join(" "));

      if (invocation.args.includes("--version")) {
        return {
          exitCode: 0,
          stdout: `${invocation.command} 9.9.9\n`,
          stderr: ""
        };
      }
      if (invocation.args.includes("--help")) {
        return {
          exitCode: 0,
          stdout: invocation.command === "fake-claude"
            ? "--setting-sources --strict-mcp-config --disable-slash-commands --no-chrome --no-session-persistence\n"
            : "--sandbox --ephemeral --ignore-user-config --skip-git-repo-check --json\n",
          stderr: ""
        };
      }
      return {
        exitCode: 0,
        stdout: "authenticated\n",
        stderr: ""
      };
    };

    const claude = await detectClaudeCli({ command: "fake-claude", runner });
    const codex = await detectCodexCli({ command: "fake-codex", runner });

    expect(claude).toMatchObject({
      authenticated: true,
      command: "fake-claude",
      installed: true,
      status: "ready",
      version: "fake-claude 9.9.9"
    });
    expect(codex).toMatchObject({
      authenticated: true,
      command: "fake-codex",
      installed: true,
      status: "ready",
      version: "fake-codex 9.9.9"
    });
    expect(invocations).toEqual([
      "fake-claude --version",
      "fake-claude auth status",
      "fake-claude --help",
      "fake-codex --version",
      "fake-codex login status",
      "fake-codex exec --help"
    ]);
  });

  it("keeps authenticated CLIs unavailable when their fixed headless contract is missing", async () => {
    const runner: CommandRunner = async (invocation) => ({
      exitCode: 0,
      stdout: invocation.args.includes("--version") ? "codex 0.1.0\n" : "authenticated\n",
      stderr: ""
    });

    const result = await detectCodexCli({ runner });

    expect(result).toMatchObject({ authenticated: true, installed: true, status: "unavailable" });
    expect(result.capabilities.headlessRun).toBe(false);
    expect(result.failure?.detail).toContain("missing required headless flags");
  });

  it("detects Gemini CLI installation without pretending authentication is verified", async () => {
    const invocations: string[] = [];
    const runner: CommandRunner = async (invocation) => {
      invocations.push([invocation.command, ...invocation.args].join(" "));
      return {
        exitCode: 0,
        stdout: "gemini 0.9.0\n",
        stderr: ""
      };
    };

    const result = await detectGeminiCli({ command: "fake-gemini", runner });

    expect(result).toMatchObject({
      authenticated: false,
      command: "fake-gemini",
      installed: true,
      status: "unavailable",
      version: "gemini 0.9.0"
    });
    expect(result.capabilities.detectInstalled).toBe(true);
    expect(result.capabilities.detectAuthenticated).toBe(false);
    expect(result.capabilities.headlessRun).toBe(false);
    expect(result.capabilities.openExternal).toBe(true);
    expect(invocations).toEqual(["fake-gemini --version"]);
  });
});

describe("built-in external agent adapters", () => {
  it("creates runnable descriptors with fixed defaults and command overrides", () => {
    expect(createBuiltInExternalAgentDescriptor("claude-code")).toMatchObject({
      id: "claude-code",
      label: "Claude Code",
      kind: "claude-code",
      command: "claude",
      capabilities: {
        headlessRun: true,
        streamLogs: true,
        cancelRun: true,
        readDiff: true
      }
    });
    expect(createBuiltInExternalAgentDescriptor("codex-cli", "/opt/bin/codex-test")).toMatchObject({
      id: "codex-cli",
      label: "Codex CLI",
      kind: "codex-cli",
      command: "/opt/bin/codex-test"
    });
  });

  it("builds the exact Claude Code argv without shell interpolation", async () => {
    const project = await createFakeProject("built-in-claude argv");

    expect(
      buildBuiltInExternalAgentCommand({
        kind: "claude-code",
        command: "fake-claude",
        projectRoot: project.projectRoot,
        promptFile: project.promptFile
      })
    ).toEqual({
      command: "fake-claude",
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
        builtInTaskPrompt(project.promptFile)
      ]
    });
  });

  it("builds the exact Codex CLI argv without shell interpolation", async () => {
    const project = await createFakeProject("built-in-codex argv");

    expect(
      buildBuiltInExternalAgentCommand({
        kind: "codex-cli",
        command: "fake-codex",
        projectRoot: project.projectRoot,
        promptFile: project.promptFile
      })
    ).toEqual({
      command: "fake-codex",
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
        project.projectRoot,
        builtInTaskPrompt(project.promptFile)
      ]
    });
  });

  it("rejects a built-in prompt path outside the project before running", async () => {
    const project = await createFakeProject("built-in-boundary");
    let runnerCalled = false;

    const result = await runBuiltInExternalAgentAdapter({
      kind: "claude-code",
      projectRoot: project.projectRoot,
      promptFile: path.resolve(project.projectRoot, "..", "outside-task.md"),
      runner: async () => {
        runnerCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(runnerCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected a project boundary failure.");
    }
    expect(result.failure.type).toBe("project-boundary-violation");
  });

  it("passes cwd, timeout, cancellation signal, and output callback to the shared runner", async () => {
    const project = await createFakeProject("built-in-run");
    const slideFile = path.join(project.projectRoot, "slides", "001-title.html");
    await fs.mkdir(path.dirname(slideFile), { recursive: true });
    await fs.writeFile(slideFile, "<section data-slide-id=\"001-title\"></section>\n", "utf8");
    const controller = new AbortController();
    const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const invocations: Parameters<CommandRunner>[0][] = [];
    const runner: CommandRunner = async (invocation) => {
      invocations.push(invocation);
      invocation.onOutput?.({ stream: "stdout", text: "progress\n" });
      return { exitCode: 0, stdout: "complete\n", stderr: "warning\n" };
    };

    const result = await runBuiltInExternalAgentAdapter({
      kind: "codex-cli",
      command: "fake-codex",
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      runner,
      signal: controller.signal,
      timeoutMs: 4_321,
      onOutput: (chunk) => chunks.push(chunk),
      readReportedFileWrites: async () => ["slides/001-title.html"]
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual({
      command: "fake-codex",
      args: buildBuiltInExternalAgentCommand({
        kind: "codex-cli",
        command: "fake-codex",
        projectRoot: project.projectRoot,
        promptFile: project.promptFile
      }).args,
      cwd: project.projectRoot,
      signal: controller.signal,
      timeoutMs: 4_321,
      onOutput: expect.any(Function)
    });
    expect(chunks).toEqual([{ stream: "stdout", text: "progress\n" }]);
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      cwd: project.projectRoot,
      stdout: "complete\n",
      stderr: "warning\n",
      reportedWrites: [slideFile],
      adapter: {
        id: "codex-cli",
        kind: "codex-cli",
        command: "fake-codex"
      }
    });
  });

  it.each([
    {
      name: "cancellation",
      commandResult: { exitCode: 1, stdout: "partial", stderr: "", cancelled: true },
      failureType: "cancelled",
      status: "cancelled"
    },
    {
      name: "timeout",
      commandResult: { exitCode: 1, stdout: "partial", stderr: "", timedOut: true },
      failureType: "run-timeout",
      status: "failed"
    },
    {
      name: "command failure",
      commandResult: { exitCode: 17, stdout: "", stderr: "provider failed" },
      failureType: "command-failed",
      status: "failed"
    }
  ])("maps $name from the shared runner into AgentAdapterRunResult", async ({ commandResult, failureType, status }) => {
    const project = await createFakeProject(`built-in-${failureType}`);
    const result = await runBuiltInExternalAgentAdapter({
      kind: "claude-code",
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      timeoutMs: 250,
      runner: async () => commandResult
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(`Expected ${failureType}.`);
    }
    expect(result.status).toBe(status);
    expect(result.failure.type).toBe(failureType);
    expect(result.stdout).toBe(commandResult.stdout);
    expect(result.stderr).toBe(commandResult.stderr);
    if (failureType === "command-failed") {
      expect(result.failure.exitCode).toBe(17);
    }
  });
});

describe("generic external agent adapter", () => {
  it("renders command templates as argv and preserves project paths with spaces", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide adapters "));
    const promptFile = path.join(projectRoot, "prompts", "prompt one.txt");
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "Edit slide one.", "utf8");

    const command = renderCommandTemplate('fake-agent --cwd "{{projectPath}}" --prompt-file "{{promptFile}}"', {
      projectRoot,
      variables: {
        projectPath: projectRoot,
        promptFile
      }
    });

    expect(command).toEqual({
      command: "fake-agent",
      args: ["--cwd", projectRoot, "--prompt-file", promptFile]
    });
  });

  it("rejects template path variables outside the project before command execution", async () => {
    const project = await createFakeProject("boundary");
    let commandCalled = false;
    const runner: CommandRunner = async () => {
      commandCalled = true;
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    };

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter("fake-agent --prompt-file {{promptFile}}"),
      projectRoot: project.projectRoot,
      promptFile: path.resolve(project.projectRoot, "..", "outside-prompt.txt"),
      runner
    });

    expect(result.ok).toBe(false);
    expect(commandCalled).toBe(false);
    if (result.ok) {
      throw new Error("Expected a project boundary failure.");
    }
    expect(result.failure.type).toBe("project-boundary-violation");
  });

  it("runs a controlled fake command and records a successful project edit", async () => {
    const project = await createFakeProject("success");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "success",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const promptFile = requireArg(args, "--prompt-file");
const manifestFile = requireArg(args, "--writes-manifest");
const slideFile = path.join(projectRoot, "slides", "001-title.html");
fs.mkdirSync(path.dirname(slideFile), { recursive: true });
fs.writeFileSync(slideFile, "<section data-slide-id=\\"001-title\\">Edited by fake agent</section>\\n");
fs.readFileSync(promptFile, "utf8");
fs.writeFileSync(manifestFile, JSON.stringify([slideFile]));
console.log("fake edit complete");
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      },
      readReportedFileWrites: () => readJsonFileWriteManifest(project.projectRoot, project.writeManifest)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.failure.message);
    }
    expect(result.stdout).toContain("fake edit complete");
    expect(result.reportedWrites).toEqual([path.join(project.projectRoot, "slides", "001-title.html")]);
    await expect(fs.readFile(path.join(project.projectRoot, "slides", "001-title.html"), "utf8")).resolves.toContain(
      "Edited by fake agent"
    );
  });

  it("surfaces command failures from controlled fake commands", async () => {
    const project = await createFakeProject("failure");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "failure",
      `
console.error("fake command failed");
process.exit(17);
`
    );

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected command failure.");
    }
    expect(result.failure.type).toBe("command-failed");
    expect(result.failure.exitCode).toBe(17);
    expect(result.stderr).toContain("fake command failed");
  });

  it("times out long-running fake commands", async () => {
    const project = await createFakeProject("timeout");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "timeout",
      `
setInterval(() => undefined, 1000);
`
    );

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      timeoutMs: 25,
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected timeout.");
    }
    expect(result.failure.type).toBe("run-timeout");
  });

  it("streams stdout and stderr chunks from a long-running fake command", async () => {
    const project = await createFakeProject("stream");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "stream",
      `
process.stdout.write("stream:start\\n");
setTimeout(() => process.stderr.write("stream:progress\\n"), 15);
setTimeout(() => process.stdout.write("stream:done\\n"), 30);
setTimeout(() => process.exit(0), 45);
`
    );
    const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      onOutput: (chunk) => chunks.push(chunk),
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      }
    });

    expect(result.ok).toBe(true);
    expect(chunks).toEqual([
      { stream: "stdout", text: "stream:start\n" },
      { stream: "stderr", text: "stream:progress\n" },
      { stream: "stdout", text: "stream:done\n" }
    ]);
    expect(result.stdout).toBe("stream:start\nstream:done\n");
    expect(result.stderr).toBe("stream:progress\n");
  });

  it("bounds captured output while continuing to drain and stream a noisy real child", async () => {
    const project = await createFakeProject("bounded-output");
    const overflowLength = COMMAND_CAPTURE_LIMIT_CHARS + 16_384;
    const stdoutTail = "stdout:after-limit\n";
    const stderrTail = "stderr:after-limit\n";
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "bounded-output",
      `
const overflowLength = ${overflowLength};
process.stdout.write("o".repeat(overflowLength));
process.stdout.write(${JSON.stringify(stdoutTail)});
process.stderr.write("e".repeat(overflowLength));
process.stderr.write(${JSON.stringify(stderrTail)});
`
    );
    const streamedLengths = { stdout: 0, stderr: 0 };
    const streamedTails = { stdout: "", stderr: "" };

    const result = await runCommand({
      command: process.execPath,
      args: [scriptFile],
      cwd: project.projectRoot,
      onOutput: (chunk) => {
        streamedLengths[chunk.stream] += chunk.text.length;
        const tailLength = chunk.stream === "stdout" ? stdoutTail.length : stderrTail.length;
        streamedTails[chunk.stream] = (streamedTails[chunk.stream] + chunk.text).slice(-tailLength);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("o".repeat(COMMAND_CAPTURE_LIMIT_CHARS) + COMMAND_CAPTURE_TRUNCATION_MARKER);
    expect(result.stderr).toBe("e".repeat(COMMAND_CAPTURE_LIMIT_CHARS) + COMMAND_CAPTURE_TRUNCATION_MARKER);
    expect(result.stdout.length).toBe(COMMAND_CAPTURE_LIMIT_CHARS + COMMAND_CAPTURE_TRUNCATION_MARKER.length);
    expect(result.stderr.length).toBe(COMMAND_CAPTURE_LIMIT_CHARS + COMMAND_CAPTURE_TRUNCATION_MARKER.length);
    expect(result.stdout.match(/output truncated/gu)).toHaveLength(1);
    expect(result.stderr.match(/output truncated/gu)).toHaveLength(1);
    expect(streamedLengths).toEqual({
      stdout: overflowLength + stdoutTail.length,
      stderr: overflowLength + stderrTail.length
    });
    expect(streamedTails).toEqual({ stdout: stdoutTail, stderr: stderrTail });
  }, 10_000);

  it("bounds pipe draining after a parent exits while a descendant holds inherited pipes", async () => {
    const project = await createFakeProject("post-exit-pipe-drain");
    const descendantPidFile = path.join(project.projectRoot, ".htmlslide", "descendant.pid");
    const descendantSource = `
process.on("SIGTERM", () => undefined);
setTimeout(() => process.stdout.write("descendant:drained\\n"), 50);
process.send?.("ready");
setInterval(() => undefined, 1_000);
`;
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "post-exit-pipe-drain",
      `
import fs from "node:fs";
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit", "ipc"]
});
descendant.once("message", () => {
  fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  fs.writeSync(1, "parent:exiting\\n");
  process.exit(17);
});
`
    );
    let deadline: NodeJS.Timeout | undefined;

    try {
      const startedAt = Date.now();
      const result = await Promise.race([
        runCommand({
          command: process.execPath,
          args: [scriptFile],
          cwd: project.projectRoot
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("runCommand did not finish after its direct child exited.")), 2_000);
        })
      ]);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.exitCode).toBe(17);
      expect(result.signal).toBeUndefined();
      expect(result.stdout).toContain("parent:exiting\n");
      expect(result.stdout).toContain("descendant:drained\n");
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      const descendantPid = Number(await fs.readFile(descendantPidFile, "utf8"));
      await killProcess(descendantPid);
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "terminates the full process group before a cancelled descendant can write",
    async () => {
      const project = await createFakeProject("cancel-process-group");
      const descendantPidFile = path.join(project.projectRoot, ".htmlslide", "cancel-descendant.pid");
      const lateMarkerFile = path.join(project.projectRoot, ".htmlslide", "late-descendant-write.txt");
      const descendantSource = `
import fs from "node:fs";
process.on("SIGTERM", () => undefined);
setTimeout(() => fs.writeFileSync(${JSON.stringify(lateMarkerFile)}, "descendant survived"), 1_400);
process.send?.("ready");
setInterval(() => undefined, 1_000);
`;
      const scriptFile = await writeFakeAgentScript(
        project.projectRoot,
        "cancel-process-group",
        `
import fs from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => undefined);
const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit", "ipc"]
});
descendant.once("message", () => {
  fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
  process.stdout.write("tree:ready\\n");
});
setInterval(() => undefined, 1_000);
`
      );
      const controller = new AbortController();
      let descendantPid: number | undefined;
      let ready: (() => void) | undefined;
      const childReady = new Promise<void>((resolve) => {
        ready = resolve;
      });

      try {
        const run = runCommand({
          command: process.execPath,
          args: [scriptFile],
          cwd: project.projectRoot,
          signal: controller.signal,
          onOutput: (chunk) => {
            if (chunk.stream === "stdout" && chunk.text.includes("tree:ready")) {
              ready?.();
            }
          }
        });

        await childReady;
        controller.abort();
        const result = await run;
        descendantPid = Number(await fs.readFile(descendantPidFile, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(result.cancelled).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        await expect(fs.access(lateMarkerFile)).rejects.toThrow();
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        if (descendantPid !== undefined) {
          await killProcess(descendantPid);
        }
      }
    },
    10_000
  );

  it("cancels long-running fake commands", async () => {
    const project = await createFakeProject("cancel");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "cancel",
      `
setInterval(() => undefined, 1000);
`
    );
    const controller = new AbortController();
    const run = runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      signal: controller.signal,
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      }
    });

    setTimeout(() => controller.abort(), 25);
    const result = await run;

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected cancellation.");
    }
    expect(result.status).toBe("cancelled");
    expect(result.failure.type).toBe("cancelled");
  });

  it("escalates cancellation to SIGKILL when a real child traps SIGTERM", async () => {
    const project = await createFakeProject("cancel-sigterm-trap");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "cancel-sigterm-trap",
      `
process.on("SIGTERM", () => {
  process.stdout.write("sigterm trapped\\n");
  setTimeout(() => process.exit(23), 2_500);
});
setInterval(() => undefined, 1_000);
process.stdout.write("ready\\n");
`
    );
    const controller = new AbortController();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const run = runCommand({
      command: process.execPath,
      args: [scriptFile],
      cwd: project.projectRoot,
      signal: controller.signal,
      onOutput: (chunk) => {
        if (chunk.stream === "stdout" && chunk.text.includes("ready")) {
          markReady?.();
        }
      }
    });

    await ready;
    const abortedAt = Date.now();
    controller.abort();
    const result = await run;

    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(900);
    expect(result.cancelled).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("sigterm trapped");
  }, 10_000);

  it("detects forbidden writes reported by a fake command", async () => {
    const project = await createFakeProject("forbidden");
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "forbidden",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const manifestFile = requireArg(args, "--writes-manifest");
const outsideFile = path.resolve(projectRoot, "..", "outside-project.txt");
fs.writeFileSync(outsideFile, "not allowed");
fs.writeFileSync(manifestFile, JSON.stringify([outsideFile]));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );

    const result = await runGenericAgentAdapter({
      adapter: createFakeAdapter(nodeCommandTemplate()),
      projectRoot: project.projectRoot,
      promptFile: project.promptFile,
      variables: {
        scriptFile,
        writeManifest: project.writeManifest
      },
      readReportedFileWrites: () => readJsonFileWriteManifest(project.projectRoot, project.writeManifest)
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected forbidden file write failure.");
    }
    expect(result.failure.type).toBe("forbidden-file-write");
    expect(result.failure.path).toBe(path.resolve(project.projectRoot, "..", "outside-project.txt"));
  });

  it("rejects generated artifact and private runtime writes reported by fake commands", async () => {
    for (const [name, reportedWrite] of [
      ["artifact", "exports/deck.pdf"],
      ["runtime", ".htmlslide/cache/file.txt"]
    ] as const) {
      const project = await createFakeProject(`forbidden-${name}`);
      const scriptFile = await writeFakeAgentScript(
        project.projectRoot,
        name,
        `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const manifestFile = requireArg(args, "--writes-manifest");
const targetFile = path.join(projectRoot, ...${JSON.stringify(reportedWrite.split("/"))});
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, "not allowed");
fs.writeFileSync(manifestFile, JSON.stringify({ writes: [${JSON.stringify(reportedWrite)}] }));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
      );

      const result = await runGenericAgentAdapter({
        adapter: createFakeAdapter(nodeCommandTemplate()),
        projectRoot: project.projectRoot,
        promptFile: project.promptFile,
        variables: {
          scriptFile,
          writeManifest: project.writeManifest
        },
        readReportedFileWrites: () => readJsonFileWriteManifest(project.projectRoot, project.writeManifest)
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected forbidden file write failure.");
      }
      expect(result.failure.type).toBe("forbidden-file-write");
      expect(result.failure.path).toBe(path.join(project.projectRoot, ...reportedWrite.split("/")));
    }
  });

  it("rejects reported source writes that escape through project symlinks", async () => {
    const project = await createFakeProject("symlink-escape");
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-agent-outside-"));
    const scriptFile = await writeFakeAgentScript(
      project.projectRoot,
      "symlink-escape",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const manifestFile = requireArg(args, "--writes-manifest");
const outsideRoot = ${JSON.stringify(outsideRoot)};
const linkPath = path.join(projectRoot, "assets", "outside-link");
const targetFile = path.join(linkPath, "stolen.txt");
fs.mkdirSync(path.dirname(linkPath), { recursive: true });
try {
  fs.symlinkSync(outsideRoot, linkPath, "dir");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
fs.writeFileSync(targetFile, "not allowed through symlink");
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["assets/outside-link/stolen.txt"] }));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );

    try {
      const result = await runGenericAgentAdapter({
        adapter: createFakeAdapter(nodeCommandTemplate()),
        projectRoot: project.projectRoot,
        promptFile: project.promptFile,
        variables: {
          scriptFile,
          writeManifest: project.writeManifest
        },
        readReportedFileWrites: () => readJsonFileWriteManifest(project.projectRoot, project.writeManifest)
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected forbidden file write failure.");
      }
      expect(result.failure.type).toBe("forbidden-file-write");
      expect(result.failure.detail).toContain("symlinks");
      await expect(fs.realpath(result.failure.path ?? "")).resolves.toBe(
        await fs.realpath(path.join(outsideRoot, "stolen.txt"))
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects reported writes outside editable deck source roots", async () => {
    const project = await createFakeProject("source-scope");

    expect(validateReportedFileWrites(project.projectRoot, ["slides/001-title.html"])).toEqual([
      path.join(project.projectRoot, "slides", "001-title.html")
    ]);

    for (const reportedWrite of [
      "exports/deck.pdf",
      ".htmlslide/cache/thumb.png",
      "assets/sources/index.json",
      "slides/\0secret.html",
      path.resolve(project.projectRoot, "..", "outside.txt")
    ]) {
      expect(() => validateReportedFileWrites(project.projectRoot, [reportedWrite])).toThrow(
        /External agents may only|outside the HTMLslide project/u
      );
    }
  });
});

interface FakeProject {
  readonly projectRoot: string;
  readonly promptFile: string;
  readonly writeManifest: string;
}

async function createFakeProject(name: string): Promise<FakeProject> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `htmlslide-${name}-`));
  const promptFile = path.join(projectRoot, ".htmlslide", "prompts", "agent-prompt.txt");
  const writeManifest = path.join(projectRoot, ".htmlslide", "write-manifest.json");

  await fs.mkdir(path.dirname(promptFile), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "deck.json"), JSON.stringify({ schemaVersion: "0.1.0" }), "utf8");
  await fs.writeFile(promptFile, "Create one slide.", "utf8");

  return {
    projectRoot,
    promptFile,
    writeManifest
  };
}

async function writeFakeAgentScript(projectRoot: string, name: string, source: string): Promise<string> {
  const scriptFile = path.join(projectRoot, ".htmlslide", `${name}.mjs`);
  await fs.mkdir(path.dirname(scriptFile), { recursive: true });
  await fs.writeFile(scriptFile, source.trimStart(), "utf8");
  return scriptFile;
}

function createFakeAdapter(commandTemplate: string): GenericAgentAdapterConfig {
  return {
    id: "fake-agent",
    label: "Fake Agent",
    kind: "fake",
    commandTemplate,
    capabilities: createCapabilitySet(["headlessRun", "cancelRun", "streamLogs"])
  };
}

function nodeCommandTemplate(): string {
  return `"${process.execPath}" "{{scriptFile}}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;
}

function builtInTaskPrompt(promptFile: string): string {
  return [
    `Read and follow the HTMLslide task instructions in ${promptFile}.`,
    "Only edit source files in deck.json, slides/, notes/, theme/, and assets/; do not modify assets/sources/ reference material.",
    "Do not edit exports/ or .htmlslide/."
  ].join(" ");
}

async function killProcess(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to kill invalid descendant pid: ${String(pid)}`);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
  }

  throw new Error(`Descendant process ${pid} did not exit after SIGKILL.`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
