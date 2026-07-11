import { describe, expect, it } from "vitest";
import {
  buildExternalAgentReadiness,
  buildAiEngineSettingsUpdate,
  createDefaultAiEngineSettings,
  createDefaultExternalAgentStatuses,
  formatRedactedKeyStatus,
  isExternalAgentRunnableByHtmlslide,
  normalizeAiEngineSettings,
  selectedExternalAgentStatus
} from "./settings-model";

describe("AI engine settings model", () => {
  it("turns transient API key input into redacted metadata only", () => {
    const settings = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        apiKeyInput: "sk-test-secret",
        externalAgentId: "codex-cli",
        mode: "htmlslide-agent",
        model: "gpt-5.1",
        provider: "openai"
      },
      "2026-07-09T00:00:00.000Z"
    );

    expect(settings.apiKey).toEqual({
      baseUrl: undefined,
      hasKey: true,
      model: "gpt-5.1",
      provider: "openai",
      updatedAt: "2026-07-09T00:00:00.000Z"
    });
    expect(JSON.stringify(settings)).not.toContain("sk-test-secret");
    expect(formatRedactedKeyStatus(settings)).toBe("OpenAI key saved");
  });

  it("preserves compatible provider base URLs as metadata only", () => {
    const compatible = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        apiKeyInput: "provider-token-secret",
        baseUrl: " https://user:pass@models.example.test/v1/?api_key=url-secret#fragment ",
        externalAgentId: "codex-cli",
        mode: "htmlslide-agent",
        model: "compatible-model",
        provider: "compatible"
      },
      "2026-07-09T00:02:00.000Z"
    );

    expect(compatible.apiKey).toMatchObject({
      baseUrl: "https://models.example.test/v1",
      hasKey: true,
      model: "compatible-model",
      provider: "compatible"
    });
    expect(JSON.stringify(compatible)).not.toContain("provider-token-secret");
    expect(JSON.stringify(compatible)).not.toContain("url-secret");
    expect(JSON.stringify(compatible)).not.toContain("user:pass");

    const switched = buildAiEngineSettingsUpdate(
      compatible,
      {
        baseUrl: "https://models.example.test/v1",
        externalAgentId: "codex-cli",
        mode: "htmlslide-agent",
        model: "gpt-5-mini",
        provider: "openai"
      },
      "2026-07-09T00:03:00.000Z"
    );

    expect(switched.apiKey.baseUrl).toBeUndefined();
  });

  it("clears key metadata when provider changes without a new key", () => {
    const current = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        apiKeyInput: "sk-test-secret",
        externalAgentId: "codex-cli",
        mode: "htmlslide-agent",
        model: "gpt-5.1",
        provider: "openai"
      },
      "2026-07-09T00:00:00.000Z"
    );

    const changedProvider = buildAiEngineSettingsUpdate(
      current,
      {
        externalAgentId: "codex-cli",
        mode: "htmlslide-agent",
        model: "claude-sonnet-4-5",
        provider: "anthropic"
      },
      "2026-07-09T00:05:00.000Z"
    );

    expect(changedProvider.apiKey.hasKey).toBe(false);
    expect(changedProvider.apiKey.provider).toBe("anthropic");
  });

  it("normalizes unknown persisted settings into the safe alpha shape", () => {
    const normalized = normalizeAiEngineSettings({
      apiKey: {
        hasKey: true,
        key: "should-not-survive",
        model: "  ",
        provider: "unknown"
      },
      mode: "unsafe",
      token: "also-not-safe"
    });

    expect(normalized).toMatchObject({
      apiKey: {
        baseUrl: undefined,
        hasKey: true,
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
    expect(JSON.stringify(normalized)).not.toContain("should-not-survive");
    expect(JSON.stringify(normalized)).not.toContain("also-not-safe");
  });

  it("keeps Gemini CLI selectable without marking it headless-ready by default", () => {
    const settings = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        externalAgentId: "gemini-cli",
        mode: "external-agent",
        model: "gpt-5-mini",
        provider: "openai"
      },
      "2026-07-09T00:08:00.000Z"
    );

    const status = selectedExternalAgentStatus(settings, createDefaultExternalAgentStatuses());

    expect(settings.externalAgent.selectedId).toBe("gemini-cli");
    expect(status).toMatchObject({
      authenticated: false,
      command: "gemini",
      id: "gemini-cli",
      installed: false,
      status: "not-installed"
    });
    expect(status.capabilities.detectAuthenticated).toBe(false);
    expect(status.capabilities.headlessRun).toBe(false);
  });

  it("marks a saved Generic command as ready for headless workspace runs", () => {
    const settings = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        customCommand: "my-agent --cwd {{projectPath}} --prompt-file {{promptFile}}",
        externalAgentId: "generic",
        mode: "external-agent",
        model: "gpt-5-mini",
        provider: "openai"
      },
      "2026-07-09T00:10:00.000Z"
    );

    const status = selectedExternalAgentStatus(settings, createDefaultExternalAgentStatuses());

    expect(status).toMatchObject({
      authenticated: true,
      command: "my-agent --cwd {{projectPath}} --prompt-file {{promptFile}}",
      id: "generic",
      installed: true,
      status: "ready",
      summary: "Generic command template saved"
    });
    expect(status.capabilities.headlessRun).toBe(true);
    expect(status.capabilities.readDiff).toBe(true);
    expect(status.capabilities.cancelRun).toBe(true);
  });

  it("builds readiness guidance for a configured Generic command", () => {
    const settings = buildAiEngineSettingsUpdate(
      createDefaultAiEngineSettings(),
      {
        customCommand: "agent --project {{projectPath}} --prompt-file {{promptFile}} --writes {{writeManifest}}",
        externalAgentId: "generic",
        mode: "external-agent",
        model: "gpt-5-mini",
        provider: "openai"
      },
      "2026-07-09T00:12:00.000Z"
    );
    const status = selectedExternalAgentStatus(settings, createDefaultExternalAgentStatuses());
    const readiness = buildExternalAgentReadiness(status);

    expect(readiness.title).toBe("Ready for HTMLslide runs");
    expect(readiness.detail).toContain("check, export, and show the diff review");
    expect(readiness.nextStep).toContain("review reported source writes");
    expect(isExternalAgentRunnableByHtmlslide(status)).toBe(true);
    expect(readiness.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTMLslide run", tone: "success", value: "Enabled" }),
        expect.objectContaining({ label: "Diff review", tone: "success", value: "Enabled" }),
        expect.objectContaining({ label: "Permissions", value: "User-defined command" }),
        expect.objectContaining({ label: "Cancel", tone: "success", value: "Enabled" })
      ])
    );
  });

  it.each([
    ["claude-code", "Claude Code"],
    ["codex-cli", "Codex CLI"]
  ] as const)("marks a capable authenticated %s installation as built-in ready", (id, label) => {
    const baseStatus = createDefaultExternalAgentStatuses().find((item) => item.id === id)!;
    const status = {
      ...baseStatus,
      authenticated: true,
      capabilities: {
        ...baseStatus.capabilities,
        cancelRun: true,
        headlessRun: true,
        readDiff: true
      },
      checkedAt: "2026-07-11T00:13:00.000Z",
      installed: true,
      status: "ready" as const,
      summary: "Detected and authenticated",
      version: `${baseStatus.command} 1.2.3`
    };
    const readiness = buildExternalAgentReadiness(status);

    expect(isExternalAgentRunnableByHtmlslide(status)).toBe(true);
    expect(readiness.title).toBe("Ready for HTMLslide runs");
    expect(readiness.detail).toContain(`built-in ${label} adapter`);
    expect(readiness.detail).toContain("keep a checkpoint");
    expect(readiness.nextStep).toContain("review the checkpoint diff");
    expect(readiness.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Auth", tone: "success", value: "Authenticated" }),
        expect.objectContaining({ label: "HTMLslide run", tone: "success", value: "Enabled" }),
        expect.objectContaining({ label: "Diff review", tone: "success", value: "Enabled" }),
        expect.objectContaining({
          label: "Permissions",
          value: id === "claude-code" ? "Read/write tools only" : "Isolated workspace-write"
        }),
        expect.objectContaining({ label: "Cancel", tone: "success", value: "Enabled" })
      ])
    );
  });

  it("requires both built-in run capabilities", () => {
    const baseStatus = createDefaultExternalAgentStatuses().find((item) => item.id === "codex-cli")!;
    const status = {
      ...baseStatus,
      authenticated: true,
      capabilities: {
        ...baseStatus.capabilities,
        headlessRun: true,
        readDiff: false
      },
      installed: true,
      status: "ready" as const
    };
    const readiness = buildExternalAgentReadiness(status);

    expect(isExternalAgentRunnableByHtmlslide(status)).toBe(false);
    expect(readiness.title).toBe("Built-in run unavailable");
    expect(readiness.detail).toContain("did not report both headless run and diff review capabilities");
    expect(readiness.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTMLslide run", tone: "warning", value: "Unavailable" }),
        expect.objectContaining({ label: "Diff review", tone: "neutral", value: "Not enabled" })
      ])
    );
  });

  it("requires built-in agents to be installed and authenticated", () => {
    const baseStatus = createDefaultExternalAgentStatuses().find((item) => item.id === "claude-code")!;
    const capableStatus = {
      ...baseStatus,
      capabilities: {
        ...baseStatus.capabilities,
        headlessRun: true,
        readDiff: true
      }
    };
    const notInstalled = {
      ...capableStatus,
      authenticated: false,
      installed: false,
      status: "not-installed" as const
    };
    const notAuthenticated = {
      ...capableStatus,
      authenticated: false,
      installed: true,
      status: "not-authenticated" as const
    };

    expect(isExternalAgentRunnableByHtmlslide(notInstalled)).toBe(false);
    expect(buildExternalAgentReadiness(notInstalled).title).toBe("Install required");
    expect(isExternalAgentRunnableByHtmlslide(notAuthenticated)).toBe(false);
    expect(buildExternalAgentReadiness(notAuthenticated).title).toBe("Login required");
  });

  it("keeps Gemini detection-only even if detection reports run capabilities", () => {
    const baseStatus = createDefaultExternalAgentStatuses().find((item) => item.id === "gemini-cli")!;
    const status = {
      ...baseStatus,
      authenticated: true,
      capabilities: {
        ...baseStatus.capabilities,
        headlessRun: true,
        readDiff: true
      },
      installed: true,
      status: "ready" as const,
      version: "gemini 1.2.3"
    };
    const readiness = buildExternalAgentReadiness(status);

    expect(isExternalAgentRunnableByHtmlslide(status)).toBe(false);
    expect(readiness.title).toBe("Detected for manual validation");
    expect(readiness.detail).toContain("Gemini CLI remains detection-only");
    expect(readiness.nextStep).toContain("Claude Code, Codex CLI, or a configured Generic command");
    expect(readiness.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTMLslide run", tone: "warning", value: "Detection only" }),
        expect.objectContaining({ label: "Diff review", tone: "neutral", value: "Not enabled" })
      ])
    );
  });
});
