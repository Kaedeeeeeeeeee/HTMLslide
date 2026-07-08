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
import type { ReactNode } from "react";
import type { ProjectSummary } from "../model";

interface ProjectLibraryProps {
  projects: ProjectSummary[];
  workspacePath?: string;
  onChooseWorkspace: () => void;
  onNewDeck: () => void;
  onOpenFolder: () => void;
  onOpenProject: (projectId: string) => void;
}

const navItems = [
  { icon: GalleryVerticalEnd, label: "Recent", selected: true },
  { icon: Layers3, label: "Templates", selected: false },
  { icon: Sparkles, label: "Skills", selected: false },
  { icon: BookOpen, label: "AI Engines", selected: false },
  { icon: Settings, label: "Settings", selected: false }
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
              className={item.selected ? "library-nav__item is-selected" : "library-nav__item"}
              key={item.label}
              type="button"
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="library-main">
        <PanelHeader
          actions={
            <>
              <Button
                icon={<Plus />}
                onClick={onNewDeck}
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

        {projects.length === 0 ? (
          <section className="library-empty">
            <FolderOpen />
            <h2>No deck projects yet</h2>
            <p>Create a local deck in the default workspace or open an existing folder with deck.json.</p>
            <div>
              <Button
                icon={<Plus />}
                onClick={onNewDeck}
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
      </section>
    </main>
  );
}
