import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCapabilitySet,
  detectClaudeCli,
  detectCodexCli,
  readJsonFileWriteManifest,
  renderCommandTemplate,
  runGenericAgentAdapter,
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
