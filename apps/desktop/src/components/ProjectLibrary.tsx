import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import { listBuiltInDeckTemplates } from "@htmlslide/core/templates";
import {
  BookOpen,
  Bot,
  Check,
  Code2,
  FolderOpen,
  GalleryVerticalEnd,
  Import,
  Layers3,
  MonitorPlay,
  Plus,
  Settings,
  Sparkles,
  Trash2
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  formatRedactedKeyStatus,
  selectedExternalAgentStatus,
  type AiEngineSettingsDraft,
  type AiEngineSettings,
  type ExternalAgentStatus
} from "../settings-model";
import type { DesktopCliIntegrationState, DesktopOfficialSkillsState } from "../desktop-api";
import {
  createDefaultNewDeckDraft,
  type LibrarySection,
  type NewDeckDraft,
  type NewDeckGenerationMode,
  type NewDeckOutputFormat,
  type OperationStatus,
  type ProjectSummary
} from "../model";
import { AiEngineSettingsPanel } from "./AiEngineSettings";
import { CliIntegrationSettingsPanel } from "./CliIntegrationSettings";
import { OfficialSkillsSettingsPanel } from "./OfficialSkillsSettings";

interface ProjectLibraryProps {
  activeSection: LibrarySection;
  aiEngineSettings: AiEngineSettings;
  aiEngineStatus: OperationStatus;
  cliIntegration?: DesktopCliIntegrationState;
  cliIntegrationStatus: OperationStatus;
  officialSkills?: DesktopOfficialSkillsState;
  officialSkillsStatus: OperationStatus;
  externalAgentStatuses: ExternalAgentStatus[];
  operationStatus: OperationStatus;
  projects: ProjectSummary[];
  workspacePath?: string;
  onCliIntegrationCopyManualCommand: () => void;
  onCliIntegrationInstall: () => void;
  onCliIntegrationRefresh: () => void;
  onCliIntegrationUninstall: () => void;
  onInstallOfficialSkills: () => void;
  onLibrarySectionChange: (section: LibrarySection) => void;
  onRefreshExternalAgents: () => void;
  onSaveAiEngineSettings: (draft: AiEngineSettingsDraft) => void;
  onChooseWorkspace: () => void;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
}

const navItems = [
  { icon: GalleryVerticalEnd, id: "recent", label: "Recent" },
  { icon: Layers3, id: "templates", label: "Templates" },
  { icon: Sparkles, id: "skills", label: "Skills" },
  { icon: BookOpen, id: "ai-engines", label: "AI Engines" },
  { icon: Settings, id: "settings", label: "Settings" }
] as const;

const languageOptions = [
  { id: "auto", label: "Auto" },
  { id: "zh-CN", label: "Chinese" },
  { id: "en-US", label: "English" },
  { id: "ja-JP", label: "Japanese" }
] as const;

const audienceOptions = [
  { id: "general", label: "General" },
  { id: "executives", label: "Executives" },
  { id: "engineers", label: "Engineers" },
  { id: "investors", label: "Investors" },
  { id: "students", label: "Students" }
] as const;

const durationOptions = ["5", "10", "20", "30"] as const;
const slideCountOptions = ["auto", "3", "5", "8", "10"] as const;
const builtInDeckTemplates = listBuiltInDeckTemplates();

const toneOptions = [
  { id: "concise", label: "Concise" },
  { id: "executive", label: "Executive" },
  { id: "technical", label: "Technical" },
  { id: "academic", label: "Academic" },
  { id: "product-launch", label: "Product launch" }
] as const;

const designDirectionOptions = [
  { id: "auto", label: "Auto" },
  { id: "consulting-clean", label: "Consulting clean" },
  { id: "technical-dark", label: "Technical dark" },
  { id: "swiss-editorial", label: "Swiss editorial" },
  { id: "product-launch", label: "Product launch" },
  { id: "data-report", label: "Data report" }
] as const;

const speakerNotesOptions = [
  { id: "bullet-notes", label: "Bullet notes" },
  { id: "full-script", label: "Full script" },
  { id: "rehearsal-cues", label: "Rehearsal cues" },
  { id: "none", label: "None" }
] as const;

const outputOptions: Array<{ id: NewDeckOutputFormat; label: string }> = [
  { id: "pdf", label: "PDF" },
  { id: "html", label: "HTML" },
  { id: "deckpkg", label: "deckpkg" },
  { id: "thumbnails", label: "Thumbnails" },
  { id: "speakerNotes", label: "Notes JSON" }
];

function projectTone(status: ProjectSummary["status"]): "success" | "warning" | "danger" | "info" {
  if (status === "Ready") {
    return "success";
  }

  if (status === "Export failed" || status === "Missing files") {
    return "danger";
  }

  if (status === "External changes detected") {
    return "info";
  }

  return "warning";
}

export function ProjectLibrary({
  activeSection,
  aiEngineSettings,
  aiEngineStatus,
  cliIntegration,
  cliIntegrationStatus,
  externalAgentStatuses,
  officialSkills,
  officialSkillsStatus,
  operationStatus,
  onCliIntegrationCopyManualCommand,
  onCliIntegrationInstall,
  onCliIntegrationRefresh,
  onCliIntegrationUninstall,
  onInstallOfficialSkills,
  onLibrarySectionChange,
  onRefreshExternalAgents,
  onSaveAiEngineSettings,
  onChooseWorkspace,
  onNewDeck,
  onOpenFolder,
  onOpenProject,
  onRemoveProject,
  projects,
  workspacePath
}: ProjectLibraryProps): ReactNode {
  return (
    <main className="library-shell">
      <aside className="library-nav">
        <div className="brand-block">
          <span className="brand-mark">Hs</span>
          <div>
            <strong>HTMLslide</strong>
            <span>Project Library</span>
          </div>
        </div>
        <nav aria-label="Project library">
          {navItems.map((item) => (
            <button
              className={activeSection === item.id ? "library-nav__item is-selected" : "library-nav__item"}
              key={item.label}
              onClick={() => onLibrarySectionChange(item.id)}
              type="button"
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="library-main">
        {activeSection === "recent" ? (
          <RecentProjects
            aiEngineSettings={aiEngineSettings}
            externalAgentStatuses={externalAgentStatuses}
            onChooseWorkspace={onChooseWorkspace}
            onNewDeck={onNewDeck}
            onOpenFolder={onOpenFolder}
            onOpenProject={onOpenProject}
            onRemoveProject={onRemoveProject}
            operationStatus={operationStatus}
            projects={projects}
            workspacePath={workspacePath}
          />
        ) : null}

        {activeSection === "ai-engines" ? (
          <AiEngineSettingsPanel
            onRefreshExternalAgents={onRefreshExternalAgents}
            onSaveSettings={onSaveAiEngineSettings}
            operationStatus={aiEngineStatus}
            settings={aiEngineSettings}
            statuses={externalAgentStatuses}
          />
        ) : null}

        {activeSection === "settings" ? (
          <section className="settings-layout">
            <CliIntegrationSettingsPanel
              onCopyManualCommand={onCliIntegrationCopyManualCommand}
              onInstall={onCliIntegrationInstall}
              onRefresh={onCliIntegrationRefresh}
              onUninstall={onCliIntegrationUninstall}
              operationStatus={cliIntegrationStatus}
              state={cliIntegration}
            />
            <OfficialSkillsSettingsPanel
              onInstall={onInstallOfficialSkills}
              operationStatus={officialSkillsStatus}
              state={officialSkills}
            />
            <AiEngineSettingsPanel
              onRefreshExternalAgents={onRefreshExternalAgents}
              onSaveSettings={onSaveAiEngineSettings}
              operationStatus={aiEngineStatus}
              settings={aiEngineSettings}
              statuses={externalAgentStatuses}
            />
          </section>
        ) : null}

        {activeSection === "skills" ? (
          <OfficialSkillsSettingsPanel
            onInstall={onInstallOfficialSkills}
            operationStatus={officialSkillsStatus}
            state={officialSkills}
          />
        ) : null}

        {activeSection === "templates" ? (
          <TemplatesLibrary />
        ) : null}
      </section>
    </main>
  );
}

function RecentProjects({
  aiEngineSettings,
  externalAgentStatuses,
  onChooseWorkspace,
  onNewDeck,
  onOpenFolder,
  onOpenProject,
  onRemoveProject,
  operationStatus,
  projects,
  workspacePath
}: {
  aiEngineSettings: AiEngineSettings;
  externalAgentStatuses: ExternalAgentStatus[];
  projects: ProjectSummary[];
  workspacePath?: string;
  onChooseWorkspace: () => void;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  operationStatus: OperationStatus;
}): ReactNode {
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [draft, setDraft] = useState<NewDeckDraft>(() => createDefaultNewDeckDraft());
  const [folderEdited, setFolderEdited] = useState(false);
  const selectedExternalStatus = selectedExternalAgentStatus(aiEngineSettings, externalAgentStatuses);
  const validationMessage = validateNewDeckDraft(draft, {
    hasApiKey: aiEngineSettings.apiKey.hasKey,
    selectedExternalReady: selectedExternalStatus.status === "ready"
  });
  const busy = operationStatus.kind === "running" && operationStatus.message === "Creating deck";
  const canCreate = !busy && validationMessage === undefined;
  const engineOptions = buildNewDeckEngineOptions({
    apiKeyStatus: formatRedactedKeyStatus(aiEngineSettings),
    hasApiKey: aiEngineSettings.apiKey.hasKey,
    selectedExternalStatus
  });
  const selectedEngine = engineOptions.find((engine) => engine.id === draft.generationMode) ?? engineOptions[0]!;

  const openNewDeckPanel = (): void => {
    setCreatingDeck(true);
  };

  const closeNewDeckPanel = (): void => {
    setCreatingDeck(false);
  };

  const updateTitle = (nextTitle: string): void => {
    setDraft((current) => ({
      ...current,
      folderName: folderEdited ? current.folderName : slugifyDeckFolder(nextTitle),
      title: nextTitle
    }));
  };

  const updateDraft = <TKey extends keyof NewDeckDraft>(key: TKey, value: NewDeckDraft[TKey]): void => {
    setDraft((current) => ({
      ...current,
      [key]: value
    }));
  };

  const toggleOutput = (output: NewDeckOutputFormat): void => {
    setDraft((current) => ({
      ...current,
      outputs: current.outputs.includes(output)
        ? current.outputs.filter((item) => item !== output)
        : [...current.outputs, output]
    }));
  };

  const submitNewDeck = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canCreate) {
      return;
    }

    onNewDeck({
      ...draft,
      brief: draft.brief.trim(),
      folderName: draft.folderName.trim(),
      title: draft.title.trim()
    });
  };

  return (
    <>
      <PanelHeader
        actions={
          <>
            <Button
              icon={<Plus />}
              onClick={openNewDeckPanel}
              variant="primary"
            >
              New Deck
            </Button>
            <Button
              icon={<FolderOpen />}
              onClick={onOpenFolder}
            >
              Open Folder
            </Button>
            <Button icon={<Import />}>Import</Button>
          </>
        }
        eyebrow={workspacePath ? `Workspace: ${workspacePath}` : "Recent workspaces"}
        title="Projects"
      />

      {creatingDeck ? (
        <form
          className="new-deck-panel"
          onSubmit={submitNewDeck}
        >
          <div className="new-deck-panel__title">
            <Plus />
            <div>
              <strong>New Deck</strong>
              <span>{workspacePath ?? "Default workspace"}</span>
            </div>
          </div>
          <div className="new-deck-panel__basic">
            <label className="settings-field">
              <span>Deck title</span>
              <input
                autoFocus
                onChange={(event) => updateTitle(event.currentTarget.value)}
                value={draft.title}
              />
            </label>
            <label className="settings-field">
              <span>Folder</span>
              <input
                onChange={(event) => {
                  setFolderEdited(true);
                  updateDraft("folderName", event.currentTarget.value);
                }}
                spellCheck={false}
                value={draft.folderName}
              />
            </label>
            <label className="settings-field">
              <span>Template</span>
              <select
                onChange={(event) => updateDraft("templateId", event.currentTarget.value)}
                value={draft.templateId}
              >
                {builtInDeckTemplates.map((template) => (
                  <option
                    key={template.id}
                    value={template.id}
                  >
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="settings-field new-deck-panel__brief">
            <span>Brief</span>
            <textarea
              onChange={(event) => updateDraft("brief", event.currentTarget.value)}
              placeholder="Summarize the audience, story, source material, and desired outcome."
              value={draft.brief}
            />
          </label>
          <section
            aria-label="AI engine"
            className="new-deck-engines"
          >
            <div className="new-deck-section-label">
              <span>AI engine</span>
              <small>{selectedEngine.detail}</small>
            </div>
            <div className="new-deck-engine-grid">
              {engineOptions.map((engine) => (
                <button
                  aria-pressed={draft.generationMode === engine.id}
                  className={draft.generationMode === engine.id ? "new-deck-engine is-selected" : "new-deck-engine"}
                  key={engine.id}
                  onClick={() => updateDraft("generationMode", engine.id)}
                  type="button"
                >
                  <span className="new-deck-engine__icon">{engine.icon}</span>
                  <span>
                    <strong>{engine.label}</strong>
                    <small>{engine.description}</small>
                  </span>
                  <StatusPill tone={engine.tone}>{engine.status}</StatusPill>
                </button>
              ))}
            </div>
          </section>
          <div className="new-deck-panel__options">
            <label className="settings-field">
              <span>Language</span>
              <select
                onChange={(event) => updateDraft("language", event.currentTarget.value)}
                value={draft.language}
              >
                {languageOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Audience</span>
              <select
                onChange={(event) => updateDraft("audience", event.currentTarget.value)}
                value={draft.audience}
              >
                {audienceOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Duration</span>
              <select
                onChange={(event) => updateDraft("durationMinutes", event.currentTarget.value)}
                value={draft.durationMinutes}
              >
                {durationOptions.map((option) => (
                  <option
                    key={option}
                    value={option}
                  >
                    {option} min
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Slides</span>
              <select
                onChange={(event) => updateDraft("slideCount", event.currentTarget.value)}
                value={draft.slideCount}
              >
                {slideCountOptions.map((option) => (
                  <option
                    key={option}
                    value={option}
                  >
                    {option === "auto" ? "Auto" : option}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Tone</span>
              <select
                onChange={(event) => updateDraft("tone", event.currentTarget.value)}
                value={draft.tone}
              >
                {toneOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Design</span>
              <select
                onChange={(event) => updateDraft("designDirection", event.currentTarget.value)}
                value={draft.designDirection}
              >
                {designDirectionOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>Speaker notes</span>
              <select
                onChange={(event) => updateDraft("speakerNotes", event.currentTarget.value)}
                value={draft.speakerNotes}
              >
                {speakerNotesOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="new-deck-panel__outputs">
            <legend>Output</legend>
            {outputOptions.map((option) => (
              <label
                className={draft.outputs.includes(option.id) ? "new-deck-output is-selected" : "new-deck-output"}
                key={option.id}
              >
                <input
                  checked={draft.outputs.includes(option.id)}
                  onChange={() => toggleOutput(option.id)}
                  type="checkbox"
                />
                <Check />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="new-deck-panel__path">
            <span>Target</span>
            <code>
              {workspacePath
                ? `${workspacePath}/${draft.folderName || "deck-folder"}`
                : draft.folderName || "deck-folder"}
            </code>
          </div>
          <div className="new-deck-panel__actions">
            <Button
              disabled={!canCreate}
              icon={<Plus />}
              type="submit"
              variant="primary"
            >
              {busy ? "Creating" : draft.generationMode === "no-ai" ? "Create Deck" : "Create & Generate"}
            </Button>
            <Button
              disabled={busy}
              onClick={closeNewDeckPanel}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            {validationMessage ? <span>{validationMessage}</span> : null}
            {!validationMessage && operationStatus.kind === "failed" ? <span>{operationStatus.message}</span> : null}
          </div>
        </form>
      ) : null}

      {projects.length === 0 ? (
        <section className="library-empty">
          <FolderOpen />
          <h2>No deck projects yet</h2>
          <p>Create a local deck in the default workspace or open an existing folder with deck.json.</p>
          <div>
            <Button
              icon={<Plus />}
              onClick={openNewDeckPanel}
              variant="primary"
            >
              New Deck
            </Button>
            <Button
              icon={<FolderOpen />}
              onClick={onOpenFolder}
            >
              Open Folder
            </Button>
            <Button
              icon={<Settings />}
              onClick={onChooseWorkspace}
              variant="ghost"
            >
              Change Workspace
            </Button>
          </div>
        </section>
      ) : (
        <div className="library-grid">
          {projects.map((project) => (
            <article
              className="project-card"
              key={project.id}
            >
              <button
                className="project-card__preview"
                onClick={() => onOpenProject(project.id)}
                type="button"
              >
                <span>{project.slideCount}</span>
                <strong>{project.title}</strong>
              </button>
              <div className="project-card__body">
                <div>
                  <h3>{project.title}</h3>
                  <p>{project.path}</p>
                </div>
                <StatusPill tone={projectTone(project.status)}>{project.status}</StatusPill>
              </div>
              <footer>
                <span>Last opened {project.lastOpened}</span>
                <div className="project-card__actions">
                  <Button
                    icon={<Trash2 />}
                    onClick={() => onRemoveProject(project.id)}
                    size="sm"
                    variant="quiet"
                  >
                    Remove
                  </Button>
                  <Button
                    onClick={() => onOpenProject(project.id)}
                    size="sm"
                    variant={project.status === "Missing files" ? "secondary" : "primary"}
                  >
                    Open
                  </Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function TemplatesLibrary(): ReactNode {
  return (
    <>
      <PanelHeader
        eyebrow="Built-in starters"
        title="Templates"
      />
      <div className="library-grid">
        {builtInDeckTemplates.map((template) => (
          <article
            className="project-card"
            key={template.id}
          >
            <div className="project-card__preview">
              <span>{template.slideCount}</span>
              <strong>slides</strong>
            </div>
            <div className="project-card__body">
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <footer>
                <span>{template.summary}</span>
                <StatusPill tone="success">{template.id}</StatusPill>
              </footer>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function slugifyDeckFolder(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled-deck";
}

function validateNewDeckDraft(
  draft: NewDeckDraft,
  options: {
    hasApiKey: boolean;
    selectedExternalReady: boolean;
  }
): string | undefined {
  const title = draft.title.trim();
  const folderName = draft.folderName.trim();
  const brief = draft.brief.trim();

  if (title.length === 0) {
    return "Deck title is required.";
  }

  if (title.length > 120) {
    return "Deck title must be 120 characters or fewer.";
  }

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(folderName)) {
    return "Folder must use lowercase letters, numbers, dashes, underscores, or dots.";
  }

  if (folderName === "." || folderName === ".." || folderName.includes("..")) {
    return "Folder cannot contain path traversal segments.";
  }

  if (draft.generationMode === "htmlslide-agent" && !options.hasApiKey) {
    return "Save a provider API key in AI Engines before using HTMLslide Agent.";
  }

  if (draft.generationMode !== "no-ai" && brief.length === 0) {
    return "Brief is required before generation.";
  }

  if (draft.generationMode === "external-agent") {
    return options.selectedExternalReady
      ? "New Deck external-agent generation is still limited to existing workspaces. Choose HTMLslide Agent, No AI, or Local Mock."
      : "Configure and refresh a ready coding agent in AI Engines before using this path.";
  }

  if (draft.outputs.length === 0) {
    return "Choose at least one output.";
  }

  return undefined;
}

function buildNewDeckEngineOptions({
  apiKeyStatus,
  hasApiKey,
  selectedExternalStatus
}: {
  apiKeyStatus: string;
  hasApiKey: boolean;
  selectedExternalStatus: ExternalAgentStatus;
}): Array<{
  id: NewDeckGenerationMode;
  label: string;
  description: string;
  detail: string;
  status: string;
  tone: "danger" | "info" | "neutral" | "success" | "warning";
  icon: ReactNode;
}> {
  return [
    {
      id: "no-ai",
      label: "No AI",
      description: "Create a source project for preview, check, export, and presenter work.",
      detail: "Deck source will be created without running a generator.",
      icon: <MonitorPlay />,
      status: "Source only",
      tone: "neutral"
    },
    {
      id: "htmlslide-agent",
      label: "HTMLslide Agent",
      description: "Use a provider API key saved from AI Engines settings.",
      detail: hasApiKey
        ? "A provider key is saved; Create & Generate will run the desktop HTMLslide Agent path."
        : "Save a provider API key in AI Engines before provider-backed generation is enabled.",
      icon: <Bot />,
      status: hasApiKey ? "Key ready" : "Needs key",
      tone: hasApiKey ? "success" : "warning"
    },
    {
      id: "external-agent",
      label: "Coding Agent",
      description: "Use the selected Claude Code, Codex CLI, or compatible command.",
      detail:
        selectedExternalStatus.status === "ready"
          ? `${selectedExternalStatus.label} is ready for existing workspace runs. New Deck handoff is still queued.`
          : `${selectedExternalStatus.label} is ${selectedExternalStatus.status.replace("-", " ")}. Refresh or configure it in AI Engines.`,
      icon: <Code2 />,
      status: selectedExternalStatus.status.replace("-", " "),
      tone: selectedExternalStatus.status === "ready"
        ? "success"
        : selectedExternalStatus.status === "not-authenticated"
          ? "warning"
          : selectedExternalStatus.status === "unavailable"
            ? "danger"
            : "neutral"
    },
    {
      id: "mock-agent",
      label: "Local Mock",
      description: "Generate a deterministic local deck for alpha validation.",
      detail: `Deterministic local path for CI and offline validation. ${apiKeyStatus}.`,
      icon: <Sparkles />,
      status: "Available",
      tone: "info"
    }
  ];
}
