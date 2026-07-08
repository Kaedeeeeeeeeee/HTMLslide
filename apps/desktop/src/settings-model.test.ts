import { describe, expect, it } from "vitest";
import {
  buildAiEngineSettingsUpdate,
  createDefaultAiEngineSettings,
  formatRedactedKeyStatus,
  normalizeAiEngineSettings
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
      hasKey: true,
      model: "gpt-5.1",
      provider: "openai",
      updatedAt: "2026-07-09T00:00:00.000Z"
    });
    expect(JSON.stringify(settings)).not.toContain("sk-test-secret");
    expect(formatRedactedKeyStatus(settings)).toBe("OpenAI key marked present");
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
        model: "claude-sonnet-4.5",
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
});
