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

export function ProjectLibrary({ onOpenProject, projects }: ProjectLibraryProps): ReactNode {
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
                onClick={() => onOpenProject(projects[0]?.id ?? "demo-alpha")}
                variant="primary"
              >
                New Deck
              </Button>
              <Button icon={<FolderOpen />}>Open Folder</Button>
              <Button icon={<Import />}>Import</Button>
            </>
          }
          eyebrow="Recent workspaces"
          title="Projects"
        />

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
      </section>
    </main>
  );
}
