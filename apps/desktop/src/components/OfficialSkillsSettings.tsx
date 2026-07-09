import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { Sparkles, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { DesktopOfficialSkillsState } from "../desktop-api";
import type { OperationStatus } from "../model";

interface OfficialSkillsSettingsPanelProps {
  operationStatus: OperationStatus;
  state?: DesktopOfficialSkillsState;
  onInstall: () => void;
}

export function OfficialSkillsSettingsPanel({
  onInstall,
  operationStatus,
  state
}: OfficialSkillsSettingsPanelProps): ReactNode {
  const busy = operationStatus.kind === "running";
  const pending = (state?.missing.length ?? 0) + (state?.stale.length ?? 0);
  const skillNames = state?.names ?? [];

  return (
    <section className="cli-settings-card">
      <PanelHeader
        actions={<StatusPill tone={skillsStatusTone(state?.status)}>{state?.installed ? "installed" : "needs install"}</StatusPill>}
        eyebrow="Official Pack"
        title="HTMLslide Skills"
      />

      <div className="cli-settings-summary">
        <span className="cli-settings-summary__icon">
          <Sparkles />
        </span>
        <div>
          <strong>{state?.message ?? "Official skills have not been checked yet."}</strong>
          {state?.suggestedFix ? <small>{state.suggestedFix}</small> : null}
        </div>
      </div>

      <dl className="cli-settings-details">
        <div>
          <dt>Installed</dt>
          <dd>{state ? `${state.installedCount} / ${state.skillCount}` : "Unknown"}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>{state ? `${pending} missing or stale` : "Unknown"}</dd>
        </div>
        <div>
          <dt>Directory</dt>
          <dd>
            <code>{state?.skillsDir ?? "Unknown"}</code>
          </dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>{state?.updatedAt ? new Date(state.updatedAt).toLocaleString() : "Not checked"}</dd>
        </div>
      </dl>

      {skillNames.length > 0 ? (
        <ul className="official-skills-list" aria-label="Official HTMLslide skills">
          {skillNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}

      <div className="settings-actions">
        <Button
          disabled={busy || state?.available === false}
          icon={<Wrench />}
          onClick={onInstall}
          variant="primary"
        >
          Install Official Skills
        </Button>
      </div>

      <p className={operationStatus.kind === "failed" ? "settings-note is-danger" : "settings-note"}>
        {operationStatus.message}
      </p>
    </section>
  );
}

function skillsStatusTone(status: DesktopOfficialSkillsState["status"] | undefined): "danger" | "info" | "neutral" | "success" | "warning" {
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
