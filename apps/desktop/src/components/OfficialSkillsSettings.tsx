import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { Sparkles, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DesktopOfficialSkillSummary, DesktopOfficialSkillsState } from "../desktop-api";
import type { OperationStatus } from "../model";

type SkillStatusFilter = "all" | DesktopOfficialSkillSummary["status"];

interface OfficialSkillsSettingsPanelProps {
  operationStatus: OperationStatus;
  state?: DesktopOfficialSkillsState;
  onInstall: () => void;
}

const statusFilters = [
  { id: "all", label: "All" },
  { id: "missing", label: "Missing" },
  { id: "stale", label: "Stale" },
  { id: "installed", label: "Installed" }
] satisfies Array<{ id: SkillStatusFilter; label: string }>;

export function OfficialSkillsSettingsPanel({
  onInstall,
  operationStatus,
  state
}: OfficialSkillsSettingsPanelProps): ReactNode {
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [expandedSkillName, setExpandedSkillName] = useState<string | undefined>();
  const busy = operationStatus.kind === "running";
  const pending = (state?.missing.length ?? 0) + (state?.stale.length ?? 0);
  const skills = state?.skills ?? [];
  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(skills.map((skill) => skill.type))).sort();
    return ["all", ...types];
  }, [skills]);
  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) =>
        (statusFilter === "all" || skill.status === statusFilter) &&
        (typeFilter === "all" || skill.type === typeFilter)
      ),
    [skills, statusFilter, typeFilter]
  );
  const lowRiskCount = skills.filter((skill) => skill.riskLevel === "low").length;
  const mediumRiskCount = skills.filter((skill) => skill.riskLevel === "medium").length;

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
                return (
                  <li
                    aria-label={`${skill.name} ${skill.status}`}
                    className={`official-skill-row is-${skill.status}`}
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
                    </div>
                    <div className="official-skill-row__actions">
                      <StatusPill tone={skillStatusTone(skill)}>{skill.status}</StatusPill>
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
                    </div>
                    {expanded ? (
                      <div className="official-skill-row__details" id={detailsId}>
                        <dl className="official-skill-inspection">
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
                              <code>{skill.installPath}</code>
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
                        <pre className="official-skill-preview" aria-label={`${skill.name} markdown preview`}>
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

function skillStatusTone(skill: DesktopOfficialSkillSummary): "neutral" | "success" | "warning" {
  if (skill.status === "installed") {
    return "success";
  }
  if (skill.status === "stale") {
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
