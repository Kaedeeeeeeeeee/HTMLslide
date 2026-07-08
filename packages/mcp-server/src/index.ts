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
  | "check_deck"
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
  if (relativePath.startsWith("/") || relativePath.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath)) {
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
