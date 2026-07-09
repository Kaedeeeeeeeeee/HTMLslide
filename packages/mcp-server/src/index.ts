import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportDeck, type CompilerProjectInput, type ExportResult } from "@htmlslide/compiler";
import { loadDeckProject, type LoadedDeckProject } from "@htmlslide/core";
import { checkProject, type CheckReport } from "@htmlslide/linter";

export type HtmlslideMcpTool =
  | "project_get_manifest"
  | "project_list_slides"
  | "slide_read"
  | "slide_write"
  | "notes_read"
  | "notes_write"
  | "theme_read"
  | "theme_write"
  | "render_slide"
  | "render_deck"
  | "check_deck"
  | "get_check_report"
  | "export_pdf"
  | "export_deckpkg"
  | "checkpoint_create"
  | "checkpoint_diff"
  | "checkpoint_revert"
  | "skill_list"
  | "skill_get_instructions"
  | "read_deck"
  | "export_deck"
  | "list_slides"
  | "read_slide"
  | "write_slide";

export type ToolSafety = "read-only" | "project-write" | "dangerous";

export type ToolDescriptor = {
  name: HtmlslideMcpTool;
  safety: ToolSafety;
  description: string;
};

export type HtmlslideMcpServerOptions = {
  projectRoot: string;
};

export type HtmlslideMcpStartResult = {
  status: "started";
  projectRoot: string;
  toolCount: number;
};

export type ProjectManifestResult = {
  projectRoot: string;
  deck: LoadedDeckProject["deck"];
};

export type ProjectSlideListResult = {
  slides: Array<{
    id: string;
    title: string;
    source: string;
    notes?: string;
    durationSec?: number;
  }>;
};

export type TextFileResult = {
  path: string;
  content: string;
};

export type WriteFileResult = {
  path: string;
  bytes: number;
  audit: McpAuditEntry;
};

export type ExportPdfResult = {
  projectRoot: string;
  pdf: string;
  export: ExportResult;
};

export type HtmlslideMcpToolResult =
  | ProjectManifestResult
  | ProjectSlideListResult
  | TextFileResult
  | WriteFileResult
  | CheckReport
  | ExportPdfResult;

export type HtmlslideMcpServer = {
  start(): Promise<HtmlslideMcpStartResult>;
  listTools(): ToolDescriptor[];
  callTool(name: HtmlslideMcpTool, input?: Record<string, unknown>): Promise<HtmlslideMcpToolResult>;
};

export const htmlslideTools: ToolDescriptor[] = [
  {
    name: "project_get_manifest",
    safety: "read-only",
    description: "Read deck.json and return normalized project metadata."
  },
  {
    name: "project_list_slides",
    safety: "read-only",
    description: "List slide ids, titles, source paths, notes paths, and durations."
  },
  {
    name: "slide_read",
    safety: "read-only",
    description: "Read one slide source fragment within the project boundary."
  },
  {
    name: "slide_write",
    safety: "project-write",
    description: "Write one slide source fragment and append a write audit entry."
  },
  {
    name: "notes_read",
    safety: "read-only",
    description: "Read speaker notes Markdown for one slide."
  },
  {
    name: "notes_write",
    safety: "project-write",
    description: "Write speaker notes Markdown and append a write audit entry."
  },
  {
    name: "theme_read",
    safety: "read-only",
    description: "Read project theme CSS or token files."
  },
  {
    name: "theme_write",
    safety: "project-write",
    description: "Write project theme CSS or token files and append a write audit entry."
  },
  {
    name: "render_slide",
    safety: "read-only",
    description: "Render one fixed-viewport slide for preview or QA."
  },
  {
    name: "render_deck",
    safety: "read-only",
    description: "Build a fixed-viewport render document for the whole deck."
  },
  {
    name: "check_deck",
    safety: "read-only",
    description: "Run HTMLslide checks and return a machine-readable report."
  },
  {
    name: "get_check_report",
    safety: "read-only",
    description: "Read the latest .htmlslide/reports/check-report.json."
  },
  {
    name: "export_pdf",
    safety: "project-write",
    description: "Export a PDF artifact inside the project exports folder."
  },
  {
    name: "export_deckpkg",
    safety: "project-write",
    description: "Export a deckpkg artifact inside the project exports folder."
  },
  {
    name: "checkpoint_create",
    safety: "project-write",
    description: "Create a project checkpoint before an agent run."
  },
  {
    name: "checkpoint_diff",
    safety: "read-only",
    description: "Return a checkpoint diff summary."
  },
  {
    name: "checkpoint_revert",
    safety: "dangerous",
    description: "Revert project files to a checkpoint after explicit user authorization."
  },
  {
    name: "skill_list",
    safety: "read-only",
    description: "List installed HTMLslide skills."
  },
  {
    name: "skill_get_instructions",
    safety: "read-only",
    description: "Read installed skill instructions for the active project."
  },
  {
    name: "read_deck",
    safety: "read-only",
    description: "Deprecated alias for project_get_manifest."
  },
  {
    name: "export_deck",
    safety: "project-write",
    description: "Deprecated alias that exports PDF, HTML, thumbnails, and deckpkg artifacts."
  },
  {
    name: "list_slides",
    safety: "read-only",
    description: "Deprecated alias for project_list_slides."
  },
  {
    name: "read_slide",
    safety: "read-only",
    description: "Deprecated alias for slide_read."
  },
  {
    name: "write_slide",
    safety: "project-write",
    description: "Deprecated alias for slide_write."
  }
];

export const isProjectRelativePathSafe = (relativePath: string): boolean => {
  if (relativePath.trim() !== relativePath || relativePath.length === 0) {
    return false;
  }
  if (
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath)
  ) {
    return false;
  }
  if (relativePath.includes("%")) {
    try {
      const decodedPath = decodeURIComponent(relativePath);
      if (decodedPath !== relativePath && !isPlainProjectRelativePathSafe(decodedPath)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return isPlainProjectRelativePathSafe(relativePath);
};

const isPlainProjectRelativePathSafe = (relativePath: string): boolean => {
  if (relativePath.includes("\0")) {
    return false;
  }
  return !relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..");
};

export type McpAuditAction = "write" | "checkpoint" | "dangerous";

export type McpAuditEntry = {
  action: McpAuditAction;
  tool: HtmlslideMcpTool;
  projectPath: string;
  targetPath?: string;
  createdAt: string;
  summary: string;
};

export const createAuditEntry = (entry: Omit<McpAuditEntry, "createdAt">): McpAuditEntry => ({
  ...entry,
  createdAt: new Date().toISOString()
});

export const createHtmlslideMcpServer = (options: HtmlslideMcpServerOptions): HtmlslideMcpServer => {
  const projectRoot = path.resolve(options.projectRoot);

  return {
    async start() {
      await loadDeckProject(projectRoot, { verifyFiles: false });
      return {
        status: "started",
        projectRoot,
        toolCount: htmlslideTools.length
      };
    },

    listTools() {
      return [...htmlslideTools];
    },

    async callTool(name, input = {}) {
      switch (name) {
        case "project_get_manifest":
        case "read_deck": {
          const project = await loadDeckProject(projectRoot, { verifyFiles: false });
          return {
            projectRoot: project.projectRoot,
            deck: project.deck
          };
        }

        case "project_list_slides":
        case "list_slides": {
          const project = await loadDeckProject(projectRoot, { verifyFiles: false });
          return {
            slides: project.deck.slides.map((slide) => ({
              id: slide.id,
              title: slide.title,
              source: slide.source,
              notes: slide.notes,
              durationSec: slide.durationSec
            }))
          };
        }

        case "slide_read":
        case "read_slide":
          return readProjectTextFile(projectRoot, readPathInput(input, "path"), "slides/");

        case "slide_write":
        case "write_slide":
          return writeProjectTextFile(projectRoot, readPathInput(input, "path"), readContentInput(input), "slides/", name);

        case "notes_read":
          return readProjectTextFile(projectRoot, readPathInput(input, "path"), "notes/");

        case "notes_write":
          return writeProjectTextFile(projectRoot, readPathInput(input, "path"), readContentInput(input), "notes/", name);

        case "theme_read":
          return readProjectTextFile(projectRoot, readPathInput(input, "path"), "theme/");

        case "theme_write":
          return writeProjectTextFile(projectRoot, readPathInput(input, "path"), readContentInput(input), "theme/", name);

        case "check_deck":
          return checkProject({
            projectPath: projectRoot,
            writeReport: true
          });

        case "export_pdf": {
          const project = await loadDeckProject(projectRoot);
          const exported = await exportDeck(toCompilerInput(project), {
            pdf: true,
            html: false,
            deckpkg: false,
            thumbnails: false
          });
          if (!exported.artifacts.pdf) {
            throw new Error("PDF export did not produce an artifact.");
          }
          return {
            projectRoot,
            pdf: exported.artifacts.pdf,
            export: exported
          };
        }

        default:
          throw new Error(`MCP tool ${name} is registered but not implemented in the in-process server harness.`);
      }
    }
  };
};

const readProjectTextFile = async (
  projectRoot: string,
  relativePath: string,
  requiredPrefix: string
): Promise<TextFileResult> => {
  const filePath = resolveToolProjectPath(projectRoot, relativePath, requiredPrefix);
  return {
    path: relativePath,
    content: await readFile(filePath, "utf8")
  };
};

const writeProjectTextFile = async (
  projectRoot: string,
  relativePath: string,
  content: string,
  requiredPrefix: string,
  tool: HtmlslideMcpTool
): Promise<WriteFileResult> => {
  const filePath = resolveToolProjectPath(projectRoot, relativePath, requiredPrefix);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return {
    path: relativePath,
    bytes: Buffer.byteLength(content, "utf8"),
    audit: createAuditEntry({
      action: "write",
      projectPath: projectRoot,
      summary: `Wrote ${relativePath}.`,
      targetPath: relativePath,
      tool
    })
  };
};

const resolveToolProjectPath = (projectRoot: string, relativePath: string, requiredPrefix: string): string => {
  if (!isProjectRelativePathSafe(relativePath) || !relativePath.startsWith(requiredPrefix)) {
    throw new Error(`Invalid project path for MCP tool: ${relativePath}`);
  }

  const resolved = path.resolve(projectRoot, ...relativePath.split("/"));
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`MCP tool path escapes the project root: ${relativePath}`);
  }

  return resolved;
};

const readPathInput = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MCP tool input must include a non-empty ${key} string.`);
  }
  return value;
};

const readContentInput = (input: Record<string, unknown>): string => {
  const value = input.content;
  if (typeof value !== "string") {
    throw new Error("MCP write tool input must include string content.");
  }
  return value;
};

const toCompilerInput = (project: LoadedDeckProject): CompilerProjectInput => ({
  projectPath: project.projectRoot,
  title: project.deck.title,
  language: project.deck.language,
  viewport: project.deck.viewport,
  safeArea: project.deck.safeArea,
  themeCssPath: project.deck.theme?.css,
  slides: project.deck.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    sourcePath: slide.source,
    notesPath: slide.notes,
    durationSec: slide.durationSec
  }))
});
