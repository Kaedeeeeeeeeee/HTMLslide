import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectExternalAgentStatuses,
  readAiEngineSettings,
  readAiEngineCredentialStatus,
  saveAiEngineSettings,
  writeAiEngineSettings,
  type DesktopCredentialStore,
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

function createFakeCredentialStore(): DesktopCredentialStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    available: true,
    entries,
    label: "Fake Keychain",
    async getPassword(service, account) {
      return entries.get(`${service}:${account}`);
    },
    async setPassword(service, account, password) {
      entries.set(`${service}:${account}`, password);
    },
    async deletePassword(service, account) {
      entries.delete(`${service}:${account}`);
    }
  };
}

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

  it("sanitizes compatible provider base URL metadata", async () => {
    const root = await tempDir();
    const settingsPath = path.join(root, "ai-engine-settings.json");

    const saved = await writeAiEngineSettings(settingsPath, {
      apiKey: {
        baseUrl: " https://user:pass@models.example.test/v1/?api_key=url-secret#fragment ",
        hasKey: true,
        model: "compatible-model",
        provider: "compatible",
        rawKey: "provider-token-secret"
      },
      externalAgent: {
        customCommand: "",
        selectedId: "codex-cli"
      },
      mode: "htmlslide-agent"
    });

    expect(saved.apiKey).toMatchObject({
      baseUrl: "https://models.example.test/v1",
      hasKey: true,
      model: "compatible-model",
      provider: "compatible"
    });

    const raw = await readFile(settingsPath, "utf8");
    expect(raw).toContain("https://models.example.test/v1");
    expect(raw).not.toContain("provider-token-secret");
    expect(raw).not.toContain("url-secret");
    expect(raw).not.toContain("user:pass");

    const openAi = await writeAiEngineSettings(settingsPath, {
      apiKey: {
        baseUrl: "https://models.example.test/v1",
        hasKey: true,
        model: "gpt-5-mini",
        provider: "openai"
      },
      mode: "htmlslide-agent"
    });

    expect(openAi.apiKey.baseUrl).toBeUndefined();
  });

  it("stores raw API keys in the credential store while keeping settings JSON secret-free", async () => {
    const root = await tempDir();
    const settingsPath = path.join(root, "ai-engine-settings.json");
    const credentialStore = createFakeCredentialStore();

    const saved = await saveAiEngineSettings(
      settingsPath,
      {
        apiKeyInput: "sk-test-secret",
        settings: {
          apiKey: {
            apiKeyInput: "sk-should-not-survive",
            hasKey: true,
            model: "gpt-5.1",
            provider: "openai",
            rawKey: "sk-another-secret"
          },
          externalAgent: {
            customCommand: "",
            selectedId: "codex-cli"
          },
          mode: "htmlslide-agent",
          token: "bearer-secret"
        }
      },
      credentialStore
    );

    expect(saved).toMatchObject({
      apiKey: {
        hasKey: true,
        model: "gpt-5.1",
        provider: "openai"
      },
      mode: "htmlslide-agent"
    });
    expect(credentialStore.entries.get("app.htmlslide.ai-key:provider:openai")).toBe("sk-test-secret");

    const raw = await readFile(settingsPath, "utf8");
    expect(raw).not.toContain("sk-test-secret");
    expect(raw).not.toContain("sk-should-not-survive");
    expect(raw).not.toContain("sk-another-secret");
    expect(raw).not.toContain("bearer-secret");

    await expect(readAiEngineCredentialStatus(settingsPath, credentialStore)).resolves.toMatchObject({
      available: true,
      hasStoredKey: true,
      provider: "openai"
    });
  });

  it("clears stored credentials and key metadata on request", async () => {
    const root = await tempDir();
    const settingsPath = path.join(root, "ai-engine-settings.json");
    const credentialStore = createFakeCredentialStore();

    await saveAiEngineSettings(
      settingsPath,
      {
        apiKeyInput: "sk-test-secret",
        settings: {
          apiKey: {
            hasKey: true,
            model: "gpt-5.1",
            provider: "openai"
          },
          mode: "htmlslide-agent"
        }
      },
      credentialStore
    );

    const cleared = await saveAiEngineSettings(
      settingsPath,
      {
        clearKey: true,
        settings: {
          apiKey: {
            hasKey: false,
            model: "gpt-5.1",
            provider: "openai"
          },
          mode: "htmlslide-agent"
        }
      },
      credentialStore
    );

    expect(cleared.apiKey.hasKey).toBe(false);
    expect(credentialStore.entries.has("app.htmlslide.ai-key:provider:openai")).toBe(false);
  });

  it("removes stale provider credentials when provider changes without a new key", async () => {
    const root = await tempDir();
    const settingsPath = path.join(root, "ai-engine-settings.json");
    const credentialStore = createFakeCredentialStore();

    await saveAiEngineSettings(
      settingsPath,
      {
        apiKeyInput: "sk-openai-secret",
        settings: {
          apiKey: {
            hasKey: true,
            model: "gpt-5.1",
            provider: "openai"
          },
          mode: "htmlslide-agent"
        }
      },
      credentialStore
    );

    const changed = await saveAiEngineSettings(
      settingsPath,
      {
        settings: {
          apiKey: {
            hasKey: false,
            model: "claude-sonnet-4-5",
            provider: "anthropic"
          },
          mode: "htmlslide-agent"
        }
      },
      credentialStore
    );

    expect(changed).toMatchObject({
      apiKey: {
        hasKey: false,
        provider: "anthropic"
      }
    });
    expect(credentialStore.entries.has("app.htmlslide.ai-key:provider:openai")).toBe(false);
    expect(credentialStore.entries.has("app.htmlslide.ai-key:provider:anthropic")).toBe(false);
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

      if (invocation.command === "codex" && invocation.args.join(" ") === "login status") {
        return {
          exitCode: 1,
          stderr: "login required\n",
          stdout: ""
        };
      }

      if (invocation.command === "codex" && invocation.args.join(" ") === "exec --help") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "--sandbox --ephemeral --ignore-user-config --skip-git-repo-check --json\n"
        };
      }

      if (invocation.command === "gemini" && invocation.args.includes("--version")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "gemini 0.9.0\n"
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
    expect(statuses.find((status) => status.id === "codex-cli")?.capabilities.headlessRun).toBe(true);
    expect(statuses.find((status) => status.id === "gemini-cli")).toMatchObject({
      authenticated: false,
      installed: true,
      status: "unavailable",
      summary: "Gemini CLI detected. Authentication depends on interactive sign-in, GEMINI_API_KEY, or Vertex AI environment, so validate it manually before release claims.",
      version: "gemini 0.9.0"
    });
    expect(statuses.find((status) => status.id === "gemini-cli")?.capabilities.detectAuthenticated).toBe(false);
    expect(statuses.find((status) => status.id === "gemini-cli")?.capabilities.headlessRun).toBe(false);
    expect(statuses.find((status) => status.id === "generic")).toMatchObject({
      status: "unavailable"
    });
    expect(statuses.find((status) => status.id === "generic")?.capabilities.detectAuthenticated).toBe(false);
  });

  it("marks Claude and Codex ready only after their fixed headless flags are verified", async () => {
    const invocations: string[] = [];
    const runner: ExternalAgentDetectorRunner = async (invocation) => {
      const args = invocation.args.join(" ");
      invocations.push(`${invocation.command} ${args}`);
      if (args === "--version") {
        return { exitCode: 0, stderr: "", stdout: `${invocation.command} 9.9.9\n` };
      }
      if (invocation.command === "claude" && args === "auth status") {
        return { exitCode: 0, stderr: "", stdout: "authenticated\n" };
      }
      if (invocation.command === "claude" && args === "--help") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "--setting-sources --strict-mcp-config --disable-slash-commands --no-chrome --no-session-persistence\n"
        };
      }
      if (invocation.command === "codex" && args === "login status") {
        return { exitCode: 0, stderr: "", stdout: "authenticated\n" };
      }
      if (invocation.command === "codex" && args === "exec --help") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "--sandbox --ephemeral --ignore-user-config --skip-git-repo-check --json\n"
        };
      }
      throw new Error(`Unexpected detector invocation: ${invocation.command} ${args}`);
    };

    const statuses = await detectExternalAgentStatuses({ runner });

    expect(statuses.find((status) => status.id === "claude-code")).toMatchObject({
      authenticated: true,
      status: "ready"
    });
    expect(statuses.find((status) => status.id === "codex-cli")).toMatchObject({
      authenticated: true,
      status: "ready"
    });
    expect(invocations).toContain("claude --help");
    expect(invocations).toContain("codex exec --help");
  });

  it("keeps an authenticated CLI unavailable when required headless flags are missing", async () => {
    const runner: ExternalAgentDetectorRunner = async (invocation) => {
      const args = invocation.args.join(" ");
      if (invocation.command === "claude") {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      }
      if (invocation.command === "codex" && args === "--version") {
        return { exitCode: 0, stderr: "", stdout: "codex 0.1.0\n" };
      }
      if (invocation.command === "codex" && args === "login status") {
        return { exitCode: 0, stderr: "", stdout: "authenticated\n" };
      }
      if (invocation.command === "codex" && args === "exec --help") {
        return { exitCode: 0, stderr: "", stdout: "old exec help\n" };
      }
      if (invocation.command === "gemini" && args === "--version") {
        return { exitCode: 0, stderr: "", stdout: "gemini 0.9.0\n" };
      }
      throw new Error(`Unexpected detector invocation: ${invocation.command} ${args}`);
    };

    const statuses = await detectExternalAgentStatuses({ runner });
    const codex = statuses.find((status) => status.id === "codex-cli");

    expect(codex).toMatchObject({ authenticated: true, status: "unavailable" });
    expect(codex?.capabilities.headlessRun).toBe(false);
    expect(codex?.summary).toContain("missing required headless flags");
  });
});
