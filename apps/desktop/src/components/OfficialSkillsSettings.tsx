import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { Sparkles, Trash2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  DesktopOfficialSkillInstallTarget,
  DesktopOfficialSkillSummary,
  DesktopOfficialSkillsState
} from "../desktop-api";
import type { OperationStatus } from "../model";

type SkillStatusFilter = "all" | DesktopOfficialSkillSummary["status"];

interface OfficialSkillsSettingsPanelProps {
  operationStatus: OperationStatus;
  state?: DesktopOfficialSkillsState;
  projectPath?: string;
  onInstall: (target: DesktopOfficialSkillInstallTarget) => void;
  onRemove: (skillName: string, target: DesktopOfficialSkillInstallTarget) => void;
}

const statusFilters = [
  { id: "all", label: "All" },
  { id: "missing", label: "Missing" },
  { id: "stale", label: "Stale" },
  { id: "installed", label: "Installed" }
] satisfies Array<{ id: SkillStatusFilter; label: string }>;

export function OfficialSkillsSettingsPanel({
  onInstall,
  onRemove,
  operationStatus,
  projectPath,
  state
}: OfficialSkillsSettingsPanelProps): ReactNode {
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [installTarget, setInstallTarget] = useState<DesktopOfficialSkillInstallTarget>("global");
  const [expandedSkillName, setExpandedSkillName] = useState<string | undefined>();
  const busy = operationStatus.kind === "running";
  const skills = state?.skills ?? [];
  const projectTargetAvailable = Boolean(
    projectPath &&
    state?.projectPath === projectPath &&
    skills.some((skill) => skill.targets.project?.available)
  );
  const selectedTarget: DesktopOfficialSkillInstallTarget = installTarget === "project" && projectTargetAvailable
    ? "project"
    : "global";
  const selectedTargetState = (skill: DesktopOfficialSkillSummary) =>
    skill.targets[selectedTarget] ?? skill.targets.global;
  const pending = skills.filter((skill) => {
    const target = selectedTargetState(skill);
    return target.status === "missing" || target.status === "stale";
  }).length;
  const selectedTargetStatus: DesktopOfficialSkillsState["status"] = selectedTarget === "project"
    ? !projectTargetAvailable
      ? "warning"
      : state?.projectInstalledCount === state?.skillCount && pending === 0
        ? "passed"
        : "warning"
    : state?.status ?? "info";
  const selectedTargetMessage = selectedTarget === "project"
    ? projectTargetAvailable
      ? pending === 0
        ? `${state?.projectInstalledCount ?? 0} project skills installed.`
        : `${pending} project skill${pending === 1 ? "" : "s"} need installation or update.`
      : "Open a local deck project to inspect project skill state."
    : state?.message ?? "Official skills have not been checked yet.";
  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(skills.map((skill) => skill.type))).sort();
    return ["all", ...types];
  }, [skills]);
  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) =>
        (statusFilter === "all" || selectedTargetState(skill).status === statusFilter) &&
        (typeFilter === "all" || skill.type === typeFilter)
      ),
    [selectedTarget, skills, statusFilter, typeFilter]
  );
  const lowRiskCount = skills.filter((skill) => skill.riskLevel === "low").length;
  const mediumRiskCount = skills.filter((skill) => skill.riskLevel === "medium").length;

  return (
    <section className="cli-settings-card">
      <PanelHeader
        actions={<StatusPill tone={skillsStatusTone(selectedTargetStatus)}>
          {selectedTarget === "project"
            ? `${state?.projectInstalledCount ?? 0} / ${state?.skillCount ?? 0} project`
            : state?.installed ? "installed" : "needs install"}
        </StatusPill>}
        eyebrow="Official Pack"
        title="HTMLslide Skills"
      />

      <div className="cli-settings-summary">
        <span className="cli-settings-summary__icon">
          <Sparkles />
        </span>
        <div>
          <strong>{selectedTargetMessage}</strong>
          {state?.suggestedFix ? <small>{state.suggestedFix}</small> : null}
        </div>
      </div>

      <dl className="cli-settings-details">
        <div>
          <dt>Installed</dt>
          <dd>{state
            ? `${selectedTarget === "project" ? state.projectInstalledCount ?? 0 : state.installedCount} / ${state.skillCount}`
            : "Unknown"}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{selectedTarget === "project" ? "Active project" : "Global"}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>{state ? `${pending} missing or stale` : "Unknown"}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>{state ? `${lowRiskCount} low / ${mediumRiskCount} medium` : "Unknown"}</dd>
        </div>
        <div>
          <dt>Types</dt>
          <dd>{state ? `${Math.max(typeOptions.length - 1, 0)} deck categories` : "Unknown"}</dd>
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

      {skills.length > 0 ? (
        <section className="official-skills-library" aria-label="Official skills library">
          <div className="official-skills-toolbar">
            <div className="official-skills-filter" aria-label="Choose official skill install target">
              <button
                aria-pressed={selectedTarget === "global"}
                className={selectedTarget === "global" ? "official-skills-filter__button is-selected" : "official-skills-filter__button"}
                onClick={() => setInstallTarget("global")}
                type="button"
              >
                Global
              </button>
              <button
                aria-pressed={selectedTarget === "project"}
                className={selectedTarget === "project" ? "official-skills-filter__button is-selected" : "official-skills-filter__button"}
                disabled={!projectTargetAvailable}
                onClick={() => setInstallTarget("project")}
                title={projectTargetAvailable ? `Install into ${projectPath}` : "Open a local deck project to enable project skills"}
                type="button"
              >
                Active project
              </button>
            </div>
            <div className="official-skills-filter" aria-label="Filter official skills by install state">
              {statusFilters.map((filter) => (
                <button
                  aria-pressed={statusFilter === filter.id}
                  className={statusFilter === filter.id ? "official-skills-filter__button is-selected" : "official-skills-filter__button"}
                  key={filter.id}
                  onClick={() => setStatusFilter(filter.id)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="official-skills-type-filter">
              <span>Type</span>
              <select
                onChange={(event) => setTypeFilter(event.currentTarget.value)}
                value={typeFilter}
              >
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type === "all" ? "All deck types" : formatSkillType(type)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {filteredSkills.length > 0 ? (
            <ul className="official-skills-list" aria-label="Official HTMLslide skills">
              {filteredSkills.map((skill) => {
                const detailsId = `official-skill-${skill.name}-details`;
                const expanded = expandedSkillName === skill.name;
                const targetState = selectedTargetState(skill);
                return (
                  <li
                    aria-label={`${skill.name} ${targetState.status}`}
                    className={`official-skill-row is-${targetState.status}`}
                    key={skill.name}
                  >
                    <div className="official-skill-row__main">
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                    </div>
                    <div className="official-skill-row__meta" aria-label={`${skill.name} metadata`}>
                      <span>{formatSkillType(skill.type)}</span>
                      <span>{skill.riskLevel} risk</span>
                      <span>{skill.license}</span>
                      <span>{skill.version}</span>
                      {targetState.integrity !== "missing" ? <span>{targetState.integrity}</span> : null}
                    </div>
                    <div className="official-skill-row__actions">
                      <StatusPill tone={skillStatusTone(targetState.status)}>{targetState.status}</StatusPill>
                      <Button
                        aria-controls={detailsId}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Close" : "Inspect"} ${skill.name}`}
                        onClick={() => setExpandedSkillName(expanded ? undefined : skill.name)}
                        size="sm"
                        variant="quiet"
                      >
                        {expanded ? "Close" : "Inspect"}
                      </Button>
                      {targetState.status !== "missing" ? (
                        <Button
                          aria-label={`${targetState.removeEnabled ? "Remove" : "Remove unavailable"} ${skill.name}`}
                          disabled={busy || !targetState.removeEnabled}
                          icon={<Trash2 />}
                          onClick={() => onRemove(skill.name, selectedTarget)}
                          size="sm"
                          title={targetState.removeDisabledReason ?? `Remove ${skill.name}`}
                          variant={targetState.removeEnabled ? "danger" : "quiet"}
                        >
                          {targetState.removeEnabled ? "Remove" : "Remove unavailable"}
                        </Button>
                      ) : null}
                    </div>
                    {expanded ? (
                      <div className="official-skill-row__details" id={detailsId}>
                        <dl className="official-skill-inspection">
                          <div>
                            <dt>Target</dt>
                            <dd>{selectedTarget === "project" ? "Active project" : "Global"}</dd>
                          </div>
                          <div>
                            <dt>Author</dt>
                            <dd>{skill.author}</dd>
                          </div>
                          <div>
                            <dt>Version</dt>
                            <dd>{skill.version}</dd>
                          </div>
                          <div>
                            <dt>Entrypoint</dt>
                            <dd>{skill.entrypoint}</dd>
                          </div>
                          <div>
                            <dt>Schema</dt>
                            <dd>{skill.supportedDeckSchema.join(", ")}</dd>
                          </div>
                          <div>
                            <dt>Output</dt>
                            <dd>{skill.output}</dd>
                          </div>
                          <div>
                            <dt>Viewport</dt>
                            <dd>{skill.viewport}</dd>
                          </div>
                          <div>
                            <dt>Supports</dt>
                            <dd>{skill.supports.join(", ")}</dd>
                          </div>
                          <div>
                            <dt>Install targets</dt>
                            <dd>{skill.installTargets.join(", ")}</dd>
                          </div>
                          <div>
                            <dt>Install path</dt>
                            <dd>
                              <code>{targetState.installPath}</code>
                            </dd>
                          </div>
                        </dl>
                        <div className="official-skill-risk-flags" aria-label={`${skill.name} risk flags`}>
                          {Object.entries(skill.risk).map(([key, value]) => (
                            <span className={value ? "is-enabled" : undefined} key={key}>
                              {formatRiskFlag(key)}: {value ? "yes" : "no"}
                            </span>
                          ))}
                        </div>
                        <pre className="official-skill-preview" aria-label={`${skill.name} markdown preview`} tabIndex={0}>
                          <code>{skill.markdownPreview}</code>
                        </pre>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="settings-note">No official skills match the current filters.</p>
          )}
        </section>
      ) : null}

      <div className="settings-actions">
        <Button
          disabled={busy || state?.available === false || (selectedTarget === "project" && !projectTargetAvailable)}
          icon={<Wrench />}
          onClick={() => onInstall(selectedTarget)}
          variant="primary"
        >
          Install Official Skills
        </Button>
      </div>

      <p
        aria-atomic="true"
        aria-label="Official skills operation status"
        aria-live="polite"
        className={operationStatus.kind === "failed" ? "settings-note is-danger" : "settings-note"}
        role="status"
      >
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

function skillStatusTone(status: DesktopOfficialSkillSummary["status"]): "neutral" | "success" | "warning" {
  if (status === "installed") {
    return "success";
  }
  if (status === "stale") {
    return "warning";
  }
  return "neutral";
}

function formatSkillType(type: string): string {
  return type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRiskFlag(flag: string): string {
  return flag
    .replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`)
    .replace(/^./, (match) => match.toUpperCase());
}
