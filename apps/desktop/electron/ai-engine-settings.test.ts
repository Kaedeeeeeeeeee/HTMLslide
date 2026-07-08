import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectExternalAgentStatuses,
  readAiEngineSettings,
  writeAiEngineSettings,
  type ExternalAgentDetectorRunner
} from "./desktop-services.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "htmlslide-ai-settings-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AI engine settings persistence", () => {
  it("returns No AI defaults when no settings file exists", async () => {
    const root = await tempDir();

    await expect(readAiEngineSettings(path.join(root, "ai-engine-settings.json"))).resolves.toMatchObject({
      apiKey: {
        hasKey: false,
        model: "gpt-5-mini",
        provider: "openai"
      },
      externalAgent: {
        customCommand: "",
        selectedId: "codex-cli"
      },
      mode: "no-ai",
      version: 1
    });
  });

  it("writes only safe API key metadata", async () => {
    const root = await tempDir();
    const settingsPath = path.join(root, "ai-engine-settings.json");

    const saved = await writeAiEngineSettings(settingsPath, {
      apiKey: {
        apiKeyInput: "sk-test-secret",
        hasKey: true,
        model: "gpt-5.1",
        provider: "openai",
        rawKey: "sk-another-secret",
        updatedAt: "2026-07-09T00:00:00.000Z"
      },
      externalAgent: {
        customCommand: " codex exec ",
        selectedId: "codex-cli"
      },
      mode: "htmlslide-agent",
      token: "bearer-secret",
      updatedAt: "2026-07-09T00:00:00.000Z"
    });

    expect(saved).toMatchObject({
      apiKey: {
        hasKey: true,
        model: "gpt-5.1",
        provider: "openai"
      },
      externalAgent: {
        customCommand: "codex exec",
        selectedId: "codex-cli"
      },
      mode: "htmlslide-agent"
    });

    const raw = await readFile(settingsPath, "utf8");
    expect(raw).not.toContain("sk-test-secret");
    expect(raw).not.toContain("sk-another-secret");
    expect(raw).not.toContain("bearer-secret");
  });
});

describe("external agent status detection", () => {
  it("uses detector commands without running an agent task", async () => {
    const runner: ExternalAgentDetectorRunner = async (invocation) => {
      if (invocation.command === "claude") {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      }

      if (invocation.command === "codex" && invocation.args.includes("--version")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "codex 1.2.3\n"
        };
      }

      if (invocation.command === "codex" && invocation.args.join(" ") === "auth status") {
        return {
          exitCode: 1,
          stderr: "login required\n",
          stdout: ""
        };
      }

      throw new Error(`Unexpected detector invocation: ${invocation.command} ${invocation.args.join(" ")}`);
    };

    const statuses = await detectExternalAgentStatuses({
      cwd: "/tmp",
      now: "2026-07-09T00:00:00.000Z",
      runner
    });

    expect(statuses.find((status) => status.id === "claude-code")).toMatchObject({
      authenticated: false,
      installed: false,
      status: "not-installed"
    });
    expect(statuses.find((status) => status.id === "codex-cli")).toMatchObject({
      authenticated: false,
      installed: true,
      status: "not-authenticated",
      version: "codex 1.2.3"
    });
    expect(statuses.find((status) => status.id === "generic")).toMatchObject({
      status: "unavailable"
    });
  });
});
