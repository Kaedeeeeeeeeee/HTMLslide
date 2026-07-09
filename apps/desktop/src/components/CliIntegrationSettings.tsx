import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { Copy, RefreshCcw, Terminal, Trash2, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { DesktopCliIntegrationState } from "../desktop-api";
import type { OperationStatus } from "../model";

interface CliIntegrationSettingsPanelProps {
  operationStatus: OperationStatus;
  state?: DesktopCliIntegrationState;
  onCopyManualCommand: () => void;
  onInstall: () => void;
  onRefresh: () => void;
  onUninstall: () => void;
}

export function CliIntegrationSettingsPanel({
  onCopyManualCommand,
  onInstall,
  onRefresh,
  onUninstall,
  operationStatus,
  state
}: CliIntegrationSettingsPanelProps): ReactNode {
  const busy = operationStatus.kind === "running";
  const status = state?.status ?? "failed";

  return (
    <section className="cli-settings-card">
      <PanelHeader
        actions={<StatusPill tone={cliStatusTone(status)}>{state?.installed ? status : "not installed"}</StatusPill>}
        eyebrow="Settings"
        title="CLI Integration"
      />

      <div className="cli-settings-summary">
        <span className="cli-settings-summary__icon">
          <Terminal />
        </span>
        <div>
          <strong>{state?.message ?? "HTMLslide CLI integration has not been checked yet."}</strong>
          {state?.suggestedFix ? <small>{state.suggestedFix}</small> : null}
        </div>
      </div>

      <dl className="cli-settings-details">
        <div>
          <dt>Path</dt>
          <dd>
            <code>{state?.targetPath ?? "Unknown"}</code>
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{state ? `${state.mode} / ${state.available ? "available" : "missing"}` : "Unknown"}</dd>
        </div>
        <div>
          <dt>PATH</dt>
          <dd>{state?.onPath ? "Available on PATH" : "Target directory not on PATH"}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{state?.updatedAt ? new Date(state.updatedAt).toLocaleString() : "Not checked"}</dd>
        </div>
      </dl>

      <div className="settings-actions">
        <Button
          disabled={busy || state?.available === false}
          icon={<Wrench />}
          onClick={onInstall}
          variant="primary"
        >
          Reinstall CLI
        </Button>
        <Button
          disabled={busy || state?.available === false}
          icon={<Trash2 />}
          onClick={onUninstall}
          variant="secondary"
        >
          Uninstall CLI
        </Button>
        <Button
          disabled={busy}
          icon={<RefreshCcw />}
          onClick={onRefresh}
        >
          Refresh Status
        </Button>
        <Button
          disabled={!state}
          icon={<Copy />}
          onClick={onCopyManualCommand}
          variant="ghost"
        >
          Copy Manual Install
        </Button>
      </div>

      <p
        aria-atomic="true"
        aria-label="CLI integration operation status"
        aria-live="polite"
        className={operationStatus.kind === "failed" ? "settings-note is-danger" : "settings-note"}
        role="status"
      >
        {operationStatus.message}
      </p>
    </section>
  );
}

function cliStatusTone(status: DesktopCliIntegrationState["status"]): "danger" | "info" | "neutral" | "success" | "warning" {
  if (status === "passed") {
    return "success";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "failed") {
    return "danger";
  }
  return "neutral";
}
