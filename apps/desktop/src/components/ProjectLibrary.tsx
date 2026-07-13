import { Button, IconButton, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import {
  MAX_SOURCE_MATERIAL_BYTES_PER_FILE,
  MAX_SOURCE_MATERIAL_BYTES_TOTAL,
  MAX_SOURCE_MATERIAL_COUNT
} from "@htmlslide/core/source-material-limits";
import type { SpeakerNotesMode } from "@htmlslide/core";
import { listBuiltInDeckTemplates } from "@htmlslide/core/templates";
import {
  BookOpen,
  Bot,
  Check,
  Code2,
  FilePlus2,
  FolderOpen,
  GalleryVerticalEnd,
  Import,
  Layers3,
  MonitorPlay,
  Paperclip,
  Plus,
  Settings,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import {
  externalAgentModeDescription,
  formatRedactedKeyStatus,
  isExternalAgentRunnableByHtmlslide,
  selectedExternalAgentStatus,
  type AiEngineSettingsDraft,
  type AiEngineSettings,
  type ExternalAgentStatus
} from "../settings-model";
import type {
  DesktopCliIntegrationState,
  DesktopExternalAgentConnectionState,
  DesktopOfficialSkillsState,
  DesktopProjectAgentSkillsState,
  DesktopSourceFileSelection
} from "../desktop-api";
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
  activeProjectPath?: string;
  externalAgentConnection?: DesktopExternalAgentConnectionState;
  projectAgentSkillsStatus?: DesktopProjectAgentSkillsState;
  operationStatus: OperationStatus;
  projects: ProjectSummary[];
  workspacePath?: string;
  onCliIntegrationCopyManualCommand: () => void;
  onCliIntegrationInstall: () => void;
  onCliIntegrationRefresh: () => void;
  onCliIntegrationUninstall: () => void;
  onInstallOfficialSkills: () => void;
  onRemoveOfficialSkill: (skillName: string) => void;
  onLibrarySectionChange: (section: LibrarySection) => void;
  onRefreshExternalAgents: () => void;
  onTestExternalAgent: (agentId: ExternalAgentStatus["id"]) => void;
  onInstallProjectAgentSkills: (agentId: ExternalAgentStatus["id"]) => void;
  onSaveAiEngineSettings: (draft: AiEngineSettingsDraft) => Promise<boolean> | void;
  onChooseWorkspace: () => void;
  onChooseSourceFiles: () => Promise<DesktopSourceFileSelection[]>;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenDeckPackage: () => void;
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

const outputOptions: Array<{ id: NewDeckOutputFormat; label: string; locked?: boolean }> = [
  { id: "pdf", label: "PDF" },
  { id: "html", label: "HTML" },
  { id: "deckpkg", label: "deckpkg" },
  { id: "thumbnails", label: "Thumbnails" },
  { id: "speakerNotes", label: "Notes JSON", locked: true }
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
  activeProjectPath,
  aiEngineSettings,
  aiEngineStatus,
  cliIntegration,
  cliIntegrationStatus,
  externalAgentStatuses,
  externalAgentConnection,
  officialSkills,
  officialSkillsStatus,
  operationStatus,
  onCliIntegrationCopyManualCommand,
  onCliIntegrationInstall,
  onCliIntegrationRefresh,
  onCliIntegrationUninstall,
  onInstallOfficialSkills,
  onRemoveOfficialSkill,
  onLibrarySectionChange,
  onRefreshExternalAgents,
  onTestExternalAgent,
  onInstallProjectAgentSkills,
  onSaveAiEngineSettings,
  onChooseSourceFiles,
  onChooseWorkspace,
  onNewDeck,
  onOpenDeckPackage,
  onOpenFolder,
  onOpenProject,
  onRemoveProject,
  projects,
  projectAgentSkillsStatus,
  workspacePath
}: ProjectLibraryProps): ReactNode {
  return (
    <main aria-label="HTMLslide project library" className="library-shell">
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
              aria-current={activeSection === item.id ? "page" : undefined}
              className={activeSection === item.id ? "library-nav__item is-selected" : "library-nav__item"}
              key={item.label}
              onClick={() => onLibrarySectionChange(item.id)}
              type="button"
            >
              <item.icon aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="library-main">
        <div hidden={activeSection !== "recent"}>
          <RecentProjects
            aiEngineSettings={aiEngineSettings}
            externalAgentStatuses={externalAgentStatuses}
            onChooseSourceFiles={onChooseSourceFiles}
            onChooseWorkspace={onChooseWorkspace}
            onNewDeck={onNewDeck}
            onOpenDeckPackage={onOpenDeckPackage}
            onOpenFolder={onOpenFolder}
            onOpenProject={onOpenProject}
            onRemoveProject={onRemoveProject}
            operationStatus={operationStatus}
            projects={projects}
            workspacePath={workspacePath}
          />
        </div>

        {activeSection === "ai-engines" ? (
          <AiEngineSettingsPanel
            connection={externalAgentConnection}
            onRefreshExternalAgents={onRefreshExternalAgents}
            onTestExternalAgent={onTestExternalAgent}
            onInstallProjectAgentSkills={onInstallProjectAgentSkills}
            onSaveSettings={onSaveAiEngineSettings}
            operationStatus={aiEngineStatus}
            projectPath={activeProjectPath}
            projectSkills={projectAgentSkillsStatus}
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
              onRemove={onRemoveOfficialSkill}
              operationStatus={officialSkillsStatus}
              state={officialSkills}
            />
            <AiEngineSettingsPanel
              connection={externalAgentConnection}
              onRefreshExternalAgents={onRefreshExternalAgents}
              onTestExternalAgent={onTestExternalAgent}
              onInstallProjectAgentSkills={onInstallProjectAgentSkills}
              onSaveSettings={onSaveAiEngineSettings}
              operationStatus={aiEngineStatus}
              projectPath={activeProjectPath}
              projectSkills={projectAgentSkillsStatus}
              settings={aiEngineSettings}
              statuses={externalAgentStatuses}
            />
          </section>
        ) : null}

        {activeSection === "skills" ? (
          <OfficialSkillsSettingsPanel
            onInstall={onInstallOfficialSkills}
            onRemove={onRemoveOfficialSkill}
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
  onChooseSourceFiles,
  onChooseWorkspace,
  onNewDeck,
  onOpenDeckPackage,
  onOpenFolder,
  onOpenProject,
  onRemoveProject,
  operationStatus,
  projects,
  workspacePath
}: {
  aiEngineSettings: AiEngineSettings;
  externalAgentStatuses: ExternalAgentStatus[];
  onChooseSourceFiles: () => Promise<DesktopSourceFileSelection[]>;
  projects: ProjectSummary[];
  workspacePath?: string;
  onChooseWorkspace: () => void;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenDeckPackage: () => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  operationStatus: OperationStatus;
}): ReactNode {
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [draft, setDraft] = useState<NewDeckDraft>(() => createDefaultNewDeckDraft());
  const [folderEdited, setFolderEdited] = useState(false);
  const [addingTextSource, setAddingTextSource] = useState(false);
  const [sourceName, setSourceName] = useState("Reference notes");
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState<string | undefined>();
  const sourceIdRef = useRef(0);
  const newDeckTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedExternalStatus = selectedExternalAgentStatus(aiEngineSettings, externalAgentStatuses);
  const selectedExternalRunnable =
    aiEngineSettings.mode === "external-agent" && isExternalAgentRunnableByHtmlslide(selectedExternalStatus);
  const validationMessage = validateNewDeckDraft(draft, {
    hasApiKey: aiEngineSettings.apiKey.hasKey,
    selectedExternalReady: selectedExternalRunnable
  });
  const newDeckStatusId = "new-deck-status";
  const busy = operationStatus.kind === "running" && operationStatus.message === "Creating deck";
  const canCreate = !busy && validationMessage === undefined;
  const statusMessage = validationMessage ?? (operationStatus.kind === "failed" ? operationStatus.message : undefined);
  const feedbackMessage = busy ? operationStatus.message : statusMessage;
  const engineOptions = buildNewDeckEngineOptions({
    apiKeyStatus: formatRedactedKeyStatus(aiEngineSettings),
    hasApiKey: aiEngineSettings.apiKey.hasKey,
    selectedExternalStatus,
    selectedExternalRunnable
  });
  const selectedEngine = engineOptions.find((engine) => engine.id === draft.generationMode) ?? engineOptions[0]!;

  const openNewDeckPanel = (event?: MouseEvent<HTMLButtonElement>): void => {
    newDeckTriggerRef.current = event?.currentTarget ?? null;
    setCreatingDeck(true);
  };

  const closeNewDeckPanel = (): void => {
    setCreatingDeck(false);
    newDeckTriggerRef.current?.focus();
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
    if (output === "speakerNotes") {
      return;
    }

    setDraft((current) => ({
      ...current,
      outputs: current.outputs.includes(output)
        ? current.outputs.filter((item) => item !== output)
        : [...current.outputs, output]
    }));
  };

  const addSourceFiles = async (): Promise<void> => {
    setSourceError(undefined);
    try {
      const selections = await onChooseSourceFiles();
      if (selections.length === 0) {
        return;
      }
      setDraft((current) => {
        const existingPaths = new Set(
          current.sources
            .filter((source) => source.kind === "file")
            .map((source) => source.path)
        );
        const nextSources = selections
          .filter((selection) => !existingPaths.has(selection.path))
          .map((selection) => ({
            id: `file-${sourceIdRef.current++}`,
            kind: "file" as const,
            name: selection.name,
            path: selection.path,
            size: selection.size
          }));
        return nextSources.length > 0
          ? { ...current, sources: [...current.sources, ...nextSources] }
          : current;
      });
    } catch (error: unknown) {
      setSourceError(error instanceof Error ? error.message : String(error));
    }
  };

  const addTextSource = (): void => {
    const trimmedName = sourceName.trim();
    if (trimmedName.length === 0) {
      setSourceError("Name the pasted source before adding it.");
      return;
    }
    if (trimmedName === "." || trimmedName === ".." || /[\\/\0]/u.test(trimmedName)) {
      setSourceError("Source name must be one plain file name without path separators.");
      return;
    }
    if (sourceText.trim().length === 0) {
      setSourceError("Paste some source text before adding it.");
      return;
    }
    if (sourceByteLength({ content: sourceText, kind: "text" }) > MAX_SOURCE_MATERIAL_BYTES_PER_FILE) {
      setSourceError("Pasted source text exceeds the 25 MiB per-source limit.");
      return;
    }
    setDraft((current) => ({
      ...current,
      sources: [
        ...current.sources,
        {
          content: sourceText,
          id: `text-${sourceIdRef.current++}`,
          kind: "text",
          name: trimmedName
        }
      ]
    }));
    setAddingTextSource(false);
    setSourceName("Reference notes");
    setSourceText("");
    setSourceError(undefined);
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
              onClick={(event) => openNewDeckPanel(event)}
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
              icon={<MonitorPlay />}
              onClick={onOpenDeckPackage}
              title="Open an exported HTMLslide deck package"
            >
              Open deckpkg
            </Button>
            <Button
              icon={<Import />}
              onClick={(event) => openNewDeckPanel(event)}
              title="Start a new deck with source material"
            >
              Import sources
            </Button>
          </>
        }
        eyebrow={workspacePath ? `Workspace: ${workspacePath}` : "Recent workspaces"}
        title="Projects"
        titleId="library-title"
      />

      {creatingDeck ? (
        <form
          aria-busy={busy}
          aria-describedby={feedbackMessage ? newDeckStatusId : undefined}
          aria-labelledby="new-deck-title"
          className="new-deck-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              closeNewDeckPanel();
            }
          }}
          onSubmit={submitNewDeck}
        >
          <div className="new-deck-panel__title">
            <Plus />
            <div>
              <strong id="new-deck-title">New Deck</strong>
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
            aria-labelledby="new-deck-sources-title"
            className="new-deck-sources"
          >
            <div className="new-deck-section-label">
              <span id="new-deck-sources-title">Sources</span>
              <small>Staged into assets/sources when the deck is created</small>
            </div>
            <div className="new-deck-source-actions">
              <Button
                icon={<Paperclip />}
                onClick={() => void addSourceFiles()}
                type="button"
                variant="secondary"
              >
                Add files
              </Button>
              <Button
                icon={<FilePlus2 />}
                onClick={() => {
                  setAddingTextSource(true);
                  setSourceError(undefined);
                }}
                type="button"
                variant="ghost"
              >
                Paste text
              </Button>
            </div>
            {addingTextSource ? (
              <div className="new-deck-source-editor">
                <label className="settings-field">
                  <span>Source name</span>
                  <input
                    onChange={(event) => setSourceName(event.currentTarget.value)}
                    value={sourceName}
                  />
                </label>
                <label className="settings-field">
                  <span>Source text</span>
                  <textarea
                    autoFocus
                    onChange={(event) => setSourceText(event.currentTarget.value)}
                    placeholder="Paste notes, a transcript, a brief, or webpage text."
                    rows={5}
                    value={sourceText}
                  />
                </label>
                <div className="new-deck-source-editor__actions">
                  <Button
                    icon={<Plus />}
                    onClick={addTextSource}
                    type="button"
                    variant="primary"
                  >
                    Add source
                  </Button>
                  <Button
                    onClick={() => setAddingTextSource(false)}
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {draft.sources.length > 0 ? (
              <ul className="new-deck-source-list">
                {draft.sources.map((source) => (
                  <li key={source.id}>
                    <span className="new-deck-source-list__icon">
                      {source.kind === "file" ? <Paperclip aria-hidden="true" /> : <FilePlus2 aria-hidden="true" />}
                    </span>
                    <span className="new-deck-source-list__copy">
                      <strong>{source.name}</strong>
                      <small>{source.kind === "file" ? formatSourceSize(source.size) : "Pasted text"}</small>
                    </span>
                    <IconButton
                      icon={<X />}
                      label={`Remove ${source.name}`}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        sources: current.sources.filter((candidate) => candidate.id !== source.id)
                      }))}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="new-deck-sources__empty">No source material added.</p>
            )}
            {sourceError ? (
              <p
                aria-live="assertive"
                className="settings-note is-danger"
                role="alert"
              >
                {sourceError}
              </p>
            ) : null}
          </section>
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
                onChange={(event) => updateDraft("speakerNotes", event.currentTarget.value as SpeakerNotesMode)}
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
                  disabled={option.locked}
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
              aria-busy={busy}
              aria-describedby={feedbackMessage ? newDeckStatusId : undefined}
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
            {feedbackMessage ? (
              <p
                aria-live={busy ? "polite" : "assertive"}
                className={busy ? "settings-note" : "settings-note is-danger"}
                id={newDeckStatusId}
                role={busy ? "status" : "alert"}
              >
                {feedbackMessage}
              </p>
            ) : null}
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
              onClick={(event) => openNewDeckPanel(event)}
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
              icon={<MonitorPlay />}
              onClick={onOpenDeckPackage}
              title="Open an exported HTMLslide deck package"
            >
              Open deckpkg
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
                aria-label={`Open ${project.title}, ${project.slideCount} slides`}
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
                  <IconButton
                    icon={<Trash2 />}
                    label={`Remove ${project.title}`}
                    onClick={() => onRemoveProject(project.id)}
                  />
                  <Button
                    aria-label={`Open ${project.title}`}
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
        titleId="templates-title"
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

function formatSourceSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      ? undefined
      : "Connect an authenticated Claude Code or Codex CLI, or configure a ready Generic command, before using Coding Agent generation.";
  }

  if (!draft.outputs.some((output) => output !== "speakerNotes")) {
    return "Choose at least one output.";
  }

  if (draft.sources.length > MAX_SOURCE_MATERIAL_COUNT) {
    return `Choose no more than ${MAX_SOURCE_MATERIAL_COUNT} source materials.`;
  }

  const oversizedSource = draft.sources.find((source) => sourceByteLength(source) > MAX_SOURCE_MATERIAL_BYTES_PER_FILE);
  if (oversizedSource) {
    return `Source ${oversizedSource.name} exceeds the 25 MiB per-source limit.`;
  }

  const totalSourceBytes = draft.sources.reduce((total, source) => total + sourceByteLength(source), 0);
  if (totalSourceBytes > MAX_SOURCE_MATERIAL_BYTES_TOTAL) {
    return "Source materials exceed the 200 MiB total limit.";
  }

  return undefined;
}

function sourceByteLength(source: { kind: "file"; size: number } | { kind: "text"; content: string }): number {
  return source.kind === "file" ? source.size : new TextEncoder().encode(source.content).byteLength;
}

function buildNewDeckEngineOptions({
  apiKeyStatus,
  hasApiKey,
  selectedExternalStatus,
  selectedExternalRunnable
}: {
  apiKeyStatus: string;
  hasApiKey: boolean;
  selectedExternalStatus: ExternalAgentStatus;
  selectedExternalRunnable: boolean;
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
      description: externalAgentModeDescription,
      detail: externalAgentDeckCreationDetail(selectedExternalStatus, selectedExternalRunnable),
      icon: <Code2 />,
      status: selectedExternalRunnable
        ? "ready"
        : selectedExternalStatus.status === "ready"
          ? "manual validation"
          : selectedExternalStatus.status.replace("-", " "),
      tone: selectedExternalRunnable
        ? "success"
        : selectedExternalStatus.status === "not-authenticated"
          ? "warning"
          : selectedExternalStatus.status === "ready"
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

function externalAgentDeckCreationDetail(
  selectedExternalStatus: ExternalAgentStatus,
  selectedExternalRunnable: boolean
): string {
  if (selectedExternalRunnable) {
    return `${selectedExternalStatus.label} is ready for New Deck and existing workspace runs.`;
  }

  if (selectedExternalStatus.status === "ready") {
    return `${selectedExternalStatus.label} is detected, but this build does not expose the capabilities required for HTMLslide generation.`;
  }

  return `${selectedExternalStatus.label} is ${selectedExternalStatus.status.replace("-", " ")}. Refresh or configure it in AI Engines.`;
}
