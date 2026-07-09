import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { KeyRound, Plug, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  aiEngineModes,
  apiKeyProviders,
  buildExternalAgentReadiness,
  externalAgentOptions,
  formatRedactedKeyStatus,
  selectedExternalAgentStatus,
  type AiEngineMode,
  type AiEngineSettings,
  type AiEngineSettingsDraft,
  type ApiKeyProvider,
  type ExternalAgentId,
  type ExternalAgentReadiness,
  type ExternalAgentStatus
} from "../settings-model";
import type { OperationStatus } from "../model";

interface AiEngineSettingsPanelProps {
  settings: AiEngineSettings;
  statuses: ExternalAgentStatus[];
  operationStatus: OperationStatus;
  onRefreshExternalAgents: () => void;
  onSaveSettings: (draft: AiEngineSettingsDraft) => void;
}

export function AiEngineSettingsPanel({
  onRefreshExternalAgents,
  onSaveSettings,
  operationStatus,
  settings,
  statuses
}: AiEngineSettingsPanelProps): ReactNode {
  const [mode, setMode] = useState<AiEngineMode>(settings.mode);
  const [provider, setProvider] = useState<ApiKeyProvider>(settings.apiKey.provider);
  const [model, setModel] = useState(settings.apiKey.model);
  const [baseUrl, setBaseUrl] = useState(settings.apiKey.baseUrl ?? "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [externalAgentId, setExternalAgentId] = useState<ExternalAgentId>(settings.externalAgent.selectedId);
  const [customCommand, setCustomCommand] = useState(settings.externalAgent.customCommand);

  useEffect(() => {
    setMode(settings.mode);
    setProvider(settings.apiKey.provider);
    setModel(settings.apiKey.model);
    setBaseUrl(settings.apiKey.baseUrl ?? "");
    setExternalAgentId(settings.externalAgent.selectedId);
    setCustomCommand(settings.externalAgent.customCommand);
    setApiKeyInput("");
  }, [
    settings.apiKey.baseUrl,
    settings.apiKey.model,
    settings.apiKey.provider,
    settings.externalAgent.customCommand,
    settings.externalAgent.selectedId,
    settings.mode
  ]);

  const selectedStatus = useMemo(
    () =>
      selectedExternalAgentStatus(
        {
          ...settings,
          externalAgent: {
            ...settings.externalAgent,
            selectedId: externalAgentId
          }
        },
        statuses
      ),
    [externalAgentId, settings, statuses]
  );
  const keyStatus = formatRedactedKeyStatus(settings);
  const externalAgentReadiness = useMemo(() => buildExternalAgentReadiness(selectedStatus), [selectedStatus]);

  const save = (clearKey = false): void => {
    onSaveSettings({
      apiKeyInput,
      baseUrl,
      clearKey,
      customCommand,
      externalAgentId,
      mode,
      model,
      provider
    });
    setApiKeyInput("");
  };

  return (
    <section className="ai-settings">
      <PanelHeader
        actions={
          <StatusPill
            aria-atomic="true"
            aria-label="AI engine operation status"
            aria-live="polite"
            role="status"
            tone={operationStatus.kind === "failed" ? "danger" : operationStatus.kind === "success" ? "success" : "info"}
          >
            {operationStatus.message}
          </StatusPill>
        }
        eyebrow="Settings"
        title="AI Engines"
      />

      <section className="ai-settings__modes" aria-label="AI engine modes">
        {aiEngineModes.map((item) => (
          <button
            aria-pressed={mode === item.id}
            className={mode === item.id ? "ai-mode-card is-selected" : "ai-mode-card"}
            key={item.id}
            onClick={() => setMode(item.id)}
            type="button"
          >
            <strong>{item.label}</strong>
            <span>{item.description}</span>
          </button>
        ))}
      </section>

      <div className="ai-settings__grid">
        <section className="ai-settings-card">
          <PanelHeader
            actions={<StatusPill tone={settings.apiKey.hasKey ? "success" : "neutral"}>{keyStatus}</StatusPill>}
            eyebrow="HTMLslide Agent"
            title="API Key Metadata"
          />
          <div className="settings-form">
            <label className="settings-field">
              <span>Provider</span>
              <select
                onChange={(event) => setProvider(event.currentTarget.value as ApiKeyProvider)}
                value={provider}
              >
                {apiKeyProviders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-field">
              <span>Model</span>
              <input
                onChange={(event) => setModel(event.currentTarget.value)}
                placeholder={apiKeyProviders.find((item) => item.id === provider)?.defaultModel}
                value={model}
              />
            </label>

            {provider === "compatible" ? (
              <label className="settings-field">
                <span>Base URL</span>
                <input
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                  placeholder="https://api.openai.com/v1"
                  value={baseUrl}
                />
              </label>
            ) : null}

            <label className="settings-field">
              <span>API key</span>
              <input
                autoComplete="off"
                onChange={(event) => setApiKeyInput(event.currentTarget.value)}
                placeholder={settings.apiKey.hasKey ? "******** key saved" : "Paste provider API key"}
                type="password"
                value={apiKeyInput}
              />
            </label>

            <p className="settings-note">Raw key text is sent only to Electron credential storage; project settings keep metadata.</p>

            <div className="settings-actions">
              <Button
                icon={<Save />}
                onClick={() => save(false)}
                variant="primary"
              >
                {apiKeyInput.trim().length > 0 ? "Save Key" : "Save Settings"}
              </Button>
              <Button
                icon={<Trash2 />}
                onClick={() => save(true)}
                variant="ghost"
              >
                Clear Key
              </Button>
            </div>
          </div>
        </section>

        <section className="ai-settings-card">
          <PanelHeader
            actions={<StatusPill tone={agentStatusTone(selectedStatus.status)}>{selectedStatus.status.replace("-", " ")}</StatusPill>}
            eyebrow="Connect Coding Agent"
            title="External Agent"
          />

          <div className="external-agent-list">
            {externalAgentOptions.map((item) => {
              const status = statuses.find((entry) => entry.id === item.id);
              return (
                <button
                  aria-pressed={externalAgentId === item.id}
                  className={externalAgentId === item.id ? "external-agent-item is-selected" : "external-agent-item"}
                  key={item.id}
                  onClick={() => setExternalAgentId(item.id)}
                  type="button"
                >
                  <span className="external-agent-item__icon">
                    {item.id === "generic" ? <Plug /> : <KeyRound />}
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{status?.summary ?? "Not checked yet"}</small>
                  </span>
                  <StatusPill tone={status ? agentStatusTone(status.status) : "neutral"}>
                    {status?.status.replace("-", " ") ?? "unknown"}
                  </StatusPill>
                </button>
              );
            })}
          </div>

          <ExternalAgentReadinessPanel readiness={externalAgentReadiness} />

          <label className="settings-field">
            <span>Generic command</span>
            <input
              disabled={externalAgentId !== "generic"}
              onChange={(event) => setCustomCommand(event.currentTarget.value)}
              placeholder="my-agent --cwd {{projectPath}} --prompt-file {{promptFile}}"
              value={customCommand}
            />
          </label>

          <div className="settings-actions">
            <Button
              icon={<Save />}
              onClick={() => save(false)}
              variant="primary"
            >
              Save Selection
            </Button>
            <Button
              icon={<RefreshCcw />}
              onClick={onRefreshExternalAgents}
            >
              Refresh Status
            </Button>
          </div>
        </section>
      </div>
    </section>
  );
}

function ExternalAgentReadinessPanel({ readiness }: { readiness: ExternalAgentReadiness }): ReactNode {
  return (
    <section className="external-agent-readiness" aria-label="External agent connection guide">
      <div className="external-agent-readiness__summary">
        <strong>{readiness.title}</strong>
        <span>{readiness.detail}</span>
      </div>
      <dl className="external-agent-readiness__items">
        {readiness.items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>
              <StatusPill tone={item.tone}>{item.value}</StatusPill>
            </dd>
          </div>
        ))}
      </dl>
      <p>{readiness.nextStep}</p>
    </section>
  );
}

function agentStatusTone(status: ExternalAgentStatus["status"]): "danger" | "neutral" | "success" | "warning" {
  if (status === "ready") {
    return "success";
  }

  if (status === "not-authenticated") {
    return "warning";
  }

  if (status === "unavailable") {
    return "danger";
  }

  return "neutral";
}
