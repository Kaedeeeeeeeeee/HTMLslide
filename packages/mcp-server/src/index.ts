import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportDeck, type CompilerProjectInput, type ExportResult } from "@htmlslide/compiler";
import { loadDeckProject, type LoadedDeckProject } from "@htmlslide/core";
import { HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import { checkProject, type CheckReport } from "@htmlslide/linter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

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
  implemented: boolean;
  deprecated?: boolean;
};

export type HtmlslideMcpServerOptions = {
  projectRoot: string;
};

export type HtmlslideMcpStartResult = {
  status: "started";
  projectRoot: string;
  registeredToolCount: number;
  implementedToolCount: number;
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

export const implementedHtmlslideMcpTools: readonly HtmlslideMcpTool[] = [
  "project_get_manifest",
  "project_list_slides",
  "slide_read",
  "slide_write",
  "notes_read",
  "notes_write",
  "theme_read",
  "theme_write",
  "check_deck",
  "export_pdf",
  "read_deck",
  "list_slides",
  "read_slide",
  "write_slide"
];

export const deprecatedHtmlslideMcpTools: readonly HtmlslideMcpTool[] = [
  "read_deck",
  "export_deck",
  "list_slides",
  "read_slide",
  "write_slide"
];

const implementedToolNames = new Set<HtmlslideMcpTool>(implementedHtmlslideMcpTools);
const deprecatedToolNames = new Set<HtmlslideMcpTool>(deprecatedHtmlslideMcpTools);

const defineTool = (name: HtmlslideMcpTool, safety: ToolSafety, description: string): ToolDescriptor => ({
  name,
  safety,
  description,
  implemented: implementedToolNames.has(name),
  ...(deprecatedToolNames.has(name) ? { deprecated: true } : {})
});

export const htmlslideTools: ToolDescriptor[] = [
  defineTool("project_get_manifest", "read-only", "Read deck.json and return normalized project metadata."),
  defineTool("project_list_slides", "read-only", "List slide ids, titles, source paths, notes paths, and durations."),
  defineTool("slide_read", "read-only", "Read one slide source fragment within the project boundary."),
  defineTool("slide_write", "project-write", "Write one slide source fragment and append a write audit entry."),
  defineTool("notes_read", "read-only", "Read speaker notes Markdown for one slide."),
  defineTool("notes_write", "project-write", "Write speaker notes Markdown and append a write audit entry."),
  defineTool("theme_read", "read-only", "Read project theme CSS or token files."),
  defineTool("theme_write", "project-write", "Write project theme CSS or token files and append a write audit entry."),
  defineTool("render_slide", "read-only", "Render one fixed-viewport slide for preview or QA."),
  defineTool("render_deck", "read-only", "Build a fixed-viewport render document for the whole deck."),
  defineTool("check_deck", "read-only", "Run HTMLslide checks and return a machine-readable report."),
  defineTool("get_check_report", "read-only", "Read the latest .htmlslide/reports/check-report.json."),
  defineTool("export_pdf", "project-write", "Export a PDF artifact inside the project exports folder."),
  defineTool("export_deckpkg", "project-write", "Export a deckpkg artifact inside the project exports folder."),
  defineTool("checkpoint_create", "project-write", "Create a project checkpoint before an agent run."),
  defineTool("checkpoint_diff", "read-only", "Return a checkpoint diff summary."),
  defineTool("checkpoint_revert", "dangerous", "Revert project files to a checkpoint after explicit user authorization."),
  defineTool("skill_list", "read-only", "List installed HTMLslide skills."),
  defineTool("skill_get_instructions", "read-only", "Read installed skill instructions for the active project."),
  defineTool("read_deck", "read-only", "Deprecated alias for project_get_manifest."),
  defineTool("export_deck", "project-write", "Deprecated alias that exports PDF, HTML, thumbnails, and deckpkg artifacts."),
  defineTool("list_slides", "read-only", "Deprecated alias for project_list_slides."),
  defineTool("read_slide", "read-only", "Deprecated alias for slide_read."),
  defineTool("write_slide", "project-write", "Deprecated alias for slide_write.")
];

export const summarizeHtmlslideMcpTools = () => ({
  registeredToolCount: htmlslideTools.length,
  implementedToolCount: htmlslideTools.filter((tool) => tool.implemented).length
});

type JsonObject = Record<string, unknown>;

type ToolInputSchema = {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
};

const emptyToolInputSchema: ToolInputSchema = {
  type: "object",
  properties: {}
};

const pathToolInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Project-relative path accepted by the selected HTMLslide MCP tool."
    }
  },
  required: ["path"]
};

const writeToolInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Project-relative path accepted by the selected HTMLslide MCP write tool."
    },
    content: {
      type: "string",
      description: "UTF-8 text content to write."
    }
  },
  required: ["path", "content"]
};

const toolInputSchemas: Partial<Record<HtmlslideMcpTool, ToolInputSchema>> = {
  notes_read: pathToolInputSchema,
  notes_write: writeToolInputSchema,
  read_slide: pathToolInputSchema,
  slide_read: pathToolInputSchema,
  slide_write: writeToolInputSchema,
  theme_read: pathToolInputSchema,
  theme_write: writeToolInputSchema,
  write_slide: writeToolInputSchema
};

const toProtocolTool = (tool: ToolDescriptor): Tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toolInputSchemas[tool.name] ?? emptyToolInputSchema,
  annotations: {
    destructiveHint: tool.safety === "dangerous",
    idempotentHint: tool.safety === "read-only",
    openWorldHint: false,
    readOnlyHint: tool.safety === "read-only",
    title: tool.name
  },
  _meta: {
    deprecated: Boolean(tool.deprecated),
    implemented: tool.implemented,
    safety: tool.safety
  }
});

const toProtocolToolResult = (result: HtmlslideMcpToolResult): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(result, null, 2)
    }
  ],
  structuredContent: {
    result: result as JsonObject
  }
});

const toProtocolToolError = (error: unknown): CallToolResult => ({
  content: [
    {
      type: "text",
      text: error instanceof Error ? error.message : String(error)
    }
  ],
  isError: true
});

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
      const toolSummary = summarizeHtmlslideMcpTools();
      return {
        status: "started",
        projectRoot,
        ...toolSummary,
        toolCount: toolSummary.registeredToolCount
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

export const createHtmlslideMcpProtocolServer = (options: HtmlslideMcpServerOptions): Server => {
  const harness = createHtmlslideMcpServer(options);
  const server = new Server(
    {
      name: "htmlslide",
      version: HTMLSLIDE_APP_VERSION
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: "Use HTMLslide MCP tools only against the configured deck project root."
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: harness.listTools().filter((tool) => tool.implemented).map(toProtocolTool)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = htmlslideTools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return toProtocolToolError(new Error(`Unknown HTMLslide MCP tool: ${request.params.name}`));
    }
    if (!tool.implemented) {
      return toProtocolToolError(new Error(`HTMLslide MCP tool is planned but not implemented: ${tool.name}`));
    }

    try {
      return toProtocolToolResult(
        await harness.callTool(tool.name, request.params.arguments as Record<string, unknown> | undefined)
      );
    } catch (error) {
      return toProtocolToolError(error);
    }
  });

  return server;
};

export const startHtmlslideMcpStdioServer = async (options: HtmlslideMcpServerOptions): Promise<void> => {
  const harness = createHtmlslideMcpServer(options);
  await harness.start();
  const server = createHtmlslideMcpProtocolServer(options);
  await server.connect(new StdioServerTransport());
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
