import { Button, PanelHeader, StatusPill } from "@htmlslide/shared-ui";
import {
  BookOpen,
  FolderOpen,
  GalleryVerticalEnd,
  Import,
  Layers3,
  Plus,
  Settings,
  Sparkles
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { AiEngineSettingsDraft, AiEngineSettings, ExternalAgentStatus } from "../settings-model";
import type { LibrarySection, NewDeckDraft, OperationStatus, ProjectSummary } from "../model";
import { AiEngineSettingsPanel } from "./AiEngineSettings";

interface ProjectLibraryProps {
  activeSection: LibrarySection;
  aiEngineSettings: AiEngineSettings;
  aiEngineStatus: OperationStatus;
  externalAgentStatuses: ExternalAgentStatus[];
  operationStatus: OperationStatus;
  projects: ProjectSummary[];
  workspacePath?: string;
  onLibrarySectionChange: (section: LibrarySection) => void;
  onRefreshExternalAgents: () => void;
  onSaveAiEngineSettings: (draft: AiEngineSettingsDraft) => void;
  onChooseWorkspace: () => void;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
}

const navItems = [
  { icon: GalleryVerticalEnd, id: "recent", label: "Recent" },
  { icon: Layers3, id: "templates", label: "Templates" },
  { icon: Sparkles, id: "skills", label: "Skills" },
  { icon: BookOpen, id: "ai-engines", label: "AI Engines" },
  { icon: Settings, id: "settings", label: "Settings" }
] as const;

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
  externalAgentStatuses,
  operationStatus,
  onLibrarySectionChange,
  onRefreshExternalAgents,
  onSaveAiEngineSettings,
  onChooseWorkspace,
  onNewDeck,
  onOpenFolder,
  onOpenProject,
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
            onChooseWorkspace={onChooseWorkspace}
            onNewDeck={onNewDeck}
            onOpenFolder={onOpenFolder}
            onOpenProject={onOpenProject}
            operationStatus={operationStatus}
            projects={projects}
            workspacePath={workspacePath}
          />
        ) : null}

        {activeSection === "ai-engines" || activeSection === "settings" ? (
          <AiEngineSettingsPanel
            onRefreshExternalAgents={onRefreshExternalAgents}
            onSaveSettings={onSaveAiEngineSettings}
            operationStatus={aiEngineStatus}
            settings={aiEngineSettings}
            statuses={externalAgentStatuses}
          />
        ) : null}

        {activeSection === "templates" || activeSection === "skills" ? (
          <section className="library-empty">
            <Layers3 />
            <h2>{activeSection === "templates" ? "Templates" : "Skills"}</h2>
            <p>This library area is queued for a later phase.</p>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function RecentProjects({
  onChooseWorkspace,
  onNewDeck,
  onOpenFolder,
  onOpenProject,
  operationStatus,
  projects,
  workspacePath
}: {
  projects: ProjectSummary[];
  workspacePath?: string;
  onChooseWorkspace: () => void;
  onNewDeck: (draft: NewDeckDraft) => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
  operationStatus: OperationStatus;
}): ReactNode {
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [title, setTitle] = useState("Untitled Deck");
  const [folderName, setFolderName] = useState("untitled-deck");
  const [folderEdited, setFolderEdited] = useState(false);
  const validationMessage = validateNewDeckDraft({ folderName, title });
  const busy = operationStatus.kind === "running" && operationStatus.message === "Creating deck";
  const canCreate = !busy && validationMessage === undefined;

  const openNewDeckPanel = (): void => {
    setCreatingDeck(true);
  };

  const closeNewDeckPanel = (): void => {
    setCreatingDeck(false);
  };

  const updateTitle = (nextTitle: string): void => {
    setTitle(nextTitle);
    if (!folderEdited) {
      setFolderName(slugifyDeckFolder(nextTitle));
    }
  };

  const submitNewDeck = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canCreate) {
      return;
    }

    onNewDeck({
      folderName: folderName.trim(),
      title: title.trim()
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
          <label className="settings-field">
            <span>Deck title</span>
            <input
              autoFocus
              onChange={(event) => updateTitle(event.currentTarget.value)}
              value={title}
            />
          </label>
          <label className="settings-field">
            <span>Folder</span>
            <input
              onChange={(event) => {
                setFolderEdited(true);
                setFolderName(event.currentTarget.value);
              }}
              spellCheck={false}
              value={folderName}
            />
          </label>
          <div className="new-deck-panel__path">
            <span>Target</span>
            <code>{workspacePath ? `${workspacePath}/${folderName || "deck-folder"}` : folderName || "deck-folder"}</code>
          </div>
          <div className="new-deck-panel__actions">
            <Button
              disabled={!canCreate}
              icon={<Plus />}
              type="submit"
              variant="primary"
            >
              {busy ? "Creating" : "Create Deck"}
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
                <Button
                  onClick={() => onOpenProject(project.id)}
                  size="sm"
                  variant="secondary"
                >
                  Open
                </Button>
              </footer>
            </article>
          ))}
        </div>
      )}
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

function validateNewDeckDraft(draft: NewDeckDraft): string | undefined {
  const title = draft.title.trim();
  const folderName = draft.folderName.trim();

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

  return undefined;
}
