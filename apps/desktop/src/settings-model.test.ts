import { describe, expect, it } from "vitest";
import {
  buildAiEngineSettingsUpdate,
  createDefaultAiEngineSettings,
  createDefaultExternalAgentStatuses,
  formatRedactedKeyStatus,
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
  });
});
