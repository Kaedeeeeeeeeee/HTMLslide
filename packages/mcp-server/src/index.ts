import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createFileCopyCheckpoint,
  diffFileCopyCheckpoint,
  revertFileCopyCheckpoint,
  type CheckpointMetadata,
  type FileCopyCheckpointDiff,
  type FileCopyCheckpointRevertResult
} from "@htmlslide/agent";
import {
  buildSlidePreviewDocument,
  exportDeck,
  type CompilerProjectInput,
  type ExportOptions,
  type ExportResult
} from "@htmlslide/compiler";
import {
  loadDeckProject,
  resolveProjectRelativePathInsideRealProject,
  type LoadedDeckProject
} from "@htmlslide/core";
import { HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import { checkProject, type CheckReport } from "@htmlslide/linter";
import { buildDeckHtml, type RenderDeck, type RenderMode } from "@htmlslide/renderer";
import { getOfficialSkill, OFFICIAL_SKILLS, type SkillMetadata } from "@htmlslide/skills";
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

export type RenderSlideResult = {
  projectRoot: string;
  mode: RenderMode;
  slideId: string;
  title: string;
  source: string;
  notes?: string;
  viewport: LoadedDeckProject["deck"]["viewport"];
  html: string;
};

export type RenderDeckResult = {
  projectRoot: string;
  mode: RenderMode;
  title: string;
  slideCount: number;
  viewport: LoadedDeckProject["deck"]["viewport"];
  html: string;
};

export type ExportPdfResult = {
  projectRoot: string;
  pdf: string;
  export: ExportResult;
  audit?: McpAuditEntry;
};

export type ExportDeckPackageResult = {
  projectRoot: string;
  deckpkg: string;
  export: ExportResult;
  audit: McpAuditEntry;
};

export type ExportDeckResult = {
  projectRoot: string;
  export: ExportResult;
  audit: McpAuditEntry;
};

export type SkillListResult = {
  skillCount: number;
  skills: SkillMetadata[];
};

export type SkillInstructionsResult = {
  skill: SkillMetadata;
  markdown: string;
};

export type CheckpointCreateResult = {
  checkpoint: CheckpointMetadata;
  audit: McpAuditEntry;
};

export type CheckpointRevertToolResult = FileCopyCheckpointRevertResult & {
  audit: McpAuditEntry;
};

export class McpExportCheckError extends Error {
  constructor(public readonly report: CheckReport) {
    super(
      `MCP export blocked by HTMLslide check: ${report.summary.errors} error(s), ` +
        `${report.summary.warnings} warning(s), and status "${report.status}".`
    );
    this.name = "McpExportCheckError";
  }
}

export type HtmlslideMcpToolResult =
  | ProjectManifestResult
  | ProjectSlideListResult
  | TextFileResult
  | WriteFileResult
  | RenderSlideResult
  | RenderDeckResult
  | CheckReport
  | ExportPdfResult
  | ExportDeckPackageResult
  | ExportDeckResult
  | SkillListResult
  | SkillInstructionsResult
  | CheckpointCreateResult
  | FileCopyCheckpointDiff
  | CheckpointRevertToolResult;

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
  "render_slide",
  "render_deck",
  "check_deck",
  "get_check_report",
  "export_pdf",
  "export_deckpkg",
  "checkpoint_create",
  "checkpoint_diff",
  "checkpoint_revert",
  "skill_list",
  "skill_get_instructions",
  "read_deck",
  "export_deck",
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
  defineTool("skill_list", "read-only", "List bundled official HTMLslide skills."),
  defineTool("skill_get_instructions", "read-only", "Read bundled official skill instructions."),
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

const renderModeProperty = {
  type: "string",
  enum: ["preview", "print", "present"],
  description: "Renderer mode. Defaults to preview."
};

const renderSlideInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    slideId: {
      type: "string",
      description: "Deck slide id to render."
    },
    mode: renderModeProperty
  },
  required: ["slideId"]
};

const renderDeckInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    mode: renderModeProperty
  }
};

const checkpointCreateInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    runId: {
      type: "string",
      description: "Stable run id for the checkpoint, for example run-0001."
    }
  },
  required: ["runId"]
};

const checkpointReferenceInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    checkpointId: {
      type: "string",
      description: "Checkpoint id, for example checkpoint-run-0001."
    },
    runId: {
      type: "string",
      description: "Run id used to create the checkpoint."
    }
  }
};

const checkpointRevertInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    checkpointId: {
      type: "string",
      description: "Checkpoint id, for example checkpoint-run-0001."
    },
    confirm: {
      type: "boolean",
      description: "Must be true to allow this destructive revert operation."
    },
    runId: {
      type: "string",
      description: "Run id used to create the checkpoint."
    }
  },
  required: ["confirm"]
};

const skillNameInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Official HTMLslide skill name."
    }
  },
  required: ["name"]
};

const toolInputSchemas: Partial<Record<HtmlslideMcpTool, ToolInputSchema>> = {
  checkpoint_create: checkpointCreateInputSchema,
  checkpoint_diff: checkpointReferenceInputSchema,
  checkpoint_revert: checkpointRevertInputSchema,
  notes_read: pathToolInputSchema,
  notes_write: writeToolInputSchema,
  read_slide: pathToolInputSchema,
  render_deck: renderDeckInputSchema,
  render_slide: renderSlideInputSchema,
  slide_read: pathToolInputSchema,
  slide_write: writeToolInputSchema,
  skill_get_instructions: skillNameInputSchema,
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
      text: error instanceof McpExportCheckError
        ? JSON.stringify({
            error: "export-blocked",
            message: error.message,
            check: error.report
          }, null, 2)
        : error instanceof Error ? error.message : String(error)
    }
  ],
  isError: true,
  ...(error instanceof McpExportCheckError
    ? {
        structuredContent: {
          result: {
            error: "export-blocked",
            message: error.message,
            check: error.report
          } as JsonObject
        }
      }
    : {})
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

export const writeMcpAuditEntry = async (entry: McpAuditEntry): Promise<McpAuditEntry> => {
  const logsPath = path.join(entry.projectPath, ".htmlslide", "logs");
  await mkdir(logsPath, { recursive: true });
  await appendFile(path.join(logsPath, "mcp-audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
};

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

        case "render_slide":
          return renderProjectSlide(projectRoot, readPathInput(input, "slideId"), readRenderModeInput(input));

        case "render_deck":
          return renderProjectDeck(projectRoot, readRenderModeInput(input));

        case "check_deck":
          return checkProject({
            projectPath: projectRoot,
            writeReport: true
          });

        case "get_check_report":
          return readLatestCheckReport(projectRoot);

        case "export_pdf": {
          const exported = await exportLoadedDeck(projectRoot, {
            pdf: true,
            html: false,
            deckpkg: false,
            thumbnails: false
          });
          if (!exported.artifacts.pdf) {
            throw new Error("PDF export did not produce an artifact.");
          }
          const audit = await writeMcpAuditEntry(createAuditEntry({
            action: "write",
            projectPath: projectRoot,
            summary: `Exported PDF artifact ${path.relative(projectRoot, exported.artifacts.pdf)}.`,
            targetPath: path.relative(projectRoot, exported.artifacts.pdf),
            tool: name
          }));
          return {
            projectRoot,
            pdf: exported.artifacts.pdf,
            export: exported,
            audit
          };
        }

        case "export_deckpkg": {
          const exported = await exportLoadedDeck(projectRoot, {
            pdf: false,
            html: false,
            deckpkg: true,
            thumbnails: false
          });
          if (!exported.artifacts.deckpkg) {
            throw new Error("deckpkg export did not produce an artifact.");
          }
          const audit = await writeMcpAuditEntry(createAuditEntry({
            action: "write",
            projectPath: projectRoot,
            summary: `Exported deckpkg artifact ${path.relative(projectRoot, exported.artifacts.deckpkg)}.`,
            targetPath: path.relative(projectRoot, exported.artifacts.deckpkg),
            tool: name
          }));
          return {
            projectRoot,
            deckpkg: exported.artifacts.deckpkg,
            export: exported,
            audit
          };
        }

        case "export_deck": {
          const exported = await exportLoadedDeck(projectRoot, {
            pdf: true,
            html: true,
            deckpkg: true,
            thumbnails: true
          });
          const audit = await writeMcpAuditEntry(createAuditEntry({
            action: "write",
            projectPath: projectRoot,
            summary: "Exported full deck artifact set.",
            targetPath: path.relative(projectRoot, exported.exportsPath),
            tool: name
          }));
          return {
            projectRoot,
            export: exported,
            audit
          };
        }

        case "checkpoint_create": {
          const checkpoint = await createFileCopyCheckpoint({
            projectRoot,
            runId: readPathInput(input, "runId")
          });
          const audit = await writeMcpAuditEntry(createAuditEntry({
            action: "checkpoint",
            projectPath: projectRoot,
            summary: `Created checkpoint ${checkpoint.id}.`,
            targetPath: path.relative(projectRoot, path.join(projectRoot, ".htmlslide", "checkpoints", checkpoint.runId, "manifest.json")),
            tool: name
          }));
          return {
            checkpoint,
            audit
          };
        }

        case "checkpoint_diff":
          return diffFileCopyCheckpoint(readCheckpointReferenceInput(projectRoot, input));

        case "checkpoint_revert": {
          if (input.confirm !== true) {
            throw new Error("checkpoint_revert requires confirm: true.");
          }
          const reverted = await revertFileCopyCheckpoint(readCheckpointReferenceInput(projectRoot, input));
          const audit = await writeMcpAuditEntry(createAuditEntry({
            action: "dangerous",
            projectPath: projectRoot,
            summary: `Reverted checkpoint ${reverted.checkpoint.id}.`,
            targetPath: path.relative(projectRoot, path.join(projectRoot, ".htmlslide", "checkpoints", reverted.checkpoint.runId, "manifest.json")),
            tool: name
          }));
          return {
            ...reverted,
            audit
          };
        }

        case "skill_list":
          return {
            skillCount: OFFICIAL_SKILLS.length,
            skills: OFFICIAL_SKILLS.map((skill) => skill.metadata)
          };

        case "skill_get_instructions": {
          const skillName = readPathInput(input, "name");
          const skill = getOfficialSkill(skillName);
          if (!skill) {
            throw new Error(`Unknown official HTMLslide skill: ${skillName}`);
          }
          return {
            skill: skill.metadata,
            markdown: skill.markdown
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
  const filePath = await resolveToolProjectPath(projectRoot, relativePath, requiredPrefix);
  return {
    path: relativePath,
    content: await readFile(filePath, "utf8")
  };
};

const renderProjectDeck = async (projectRoot: string, mode: RenderMode): Promise<RenderDeckResult> => {
  const { deck } = await buildMcpRenderableDeck(projectRoot);
  return {
    projectRoot,
    mode,
    title: deck.title,
    slideCount: deck.slides.length,
    viewport: deck.viewport,
    html: buildMcpRenderHtml(deck, mode)
  };
};

const renderProjectSlide = async (
  projectRoot: string,
  slideId: string,
  mode: RenderMode
): Promise<RenderSlideResult> => {
  if (mode === "preview") {
    const project = await loadDeckProject(projectRoot, { verifyFiles: false });
    if (!project.deck.slides.some((slide) => slide.id === slideId)) {
      throw new Error(`No slide found with id ${slideId}.`);
    }
    const preview = await buildSlidePreviewDocument(projectRoot, { slideId });
    return {
      projectRoot: preview.projectRoot,
      mode,
      slideId: preview.slideId,
      title: preview.title,
      source: preview.sourcePath,
      notes: preview.notes,
      viewport: preview.viewport,
      html: preview.htmlDocument
    };
  }

  const { deck, sources } = await buildMcpRenderableDeck(projectRoot);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  const source = sources.get(slideId);
  if (!slide || !source) {
    throw new Error(`No slide found with id ${slideId}.`);
  }
  const singleSlideDeck: RenderDeck = {
    ...deck,
    slides: [slide]
  };

  return {
    projectRoot,
    mode,
    slideId: slide.id,
    title: slide.title,
    source,
    notes: slide.notes,
    viewport: deck.viewport,
    html: buildMcpRenderHtml(singleSlideDeck, mode)
  };
};

const buildMcpRenderHtml = (deck: RenderDeck, mode: RenderMode): string =>
  `${buildDeckHtml(deck, {
    mode,
    includeNotesPanel: true,
    includeRuntimeScript: true
  })}\n`;

const buildMcpRenderableDeck = async (
  projectRoot: string
): Promise<{ deck: RenderDeck; sources: Map<string, string> }> => {
  const project = await loadDeckProject(projectRoot);
  const themeCss = project.theme?.cssPath ? await readFile(project.theme.cssPath, "utf8") : undefined;
  const sources = new Map<string, string>();
  const slides = await Promise.all(
    project.slides.map(async (projectSlide) => {
      sources.set(projectSlide.id, projectSlide.slide.source);
      return {
        id: projectSlide.id,
        title: projectSlide.slide.title,
        html: await readFile(projectSlide.sourcePath, "utf8"),
        notes: projectSlide.notesPath ? await readFile(projectSlide.notesPath, "utf8") : undefined
      };
    })
  );

  return {
    deck: {
      title: project.deck.title,
      language: project.deck.language,
      viewport: project.deck.viewport,
      safeArea: project.deck.safeArea,
      themeCss,
      slides
    },
    sources
  };
};

const readLatestCheckReport = async (projectRoot: string): Promise<CheckReport> => {
  const reportPath = path.join(projectRoot, ".htmlslide", "reports", "check-report.json");
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as CheckReport;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error("No HTMLslide check report found. Run check_deck before get_check_report.");
    }
    throw error;
  }
};

const writeProjectTextFile = async (
  projectRoot: string,
  relativePath: string,
  content: string,
  requiredPrefix: string,
  tool: HtmlslideMcpTool
): Promise<WriteFileResult> => {
  const filePath = await resolveToolProjectPath(projectRoot, relativePath, requiredPrefix);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  const audit = await writeMcpAuditEntry(createAuditEntry({
    action: "write",
    projectPath: projectRoot,
    summary: `Wrote ${relativePath}.`,
    targetPath: relativePath,
    tool
  }));
  return {
    path: relativePath,
    bytes: Buffer.byteLength(content, "utf8"),
    audit
  };
};

const resolveToolProjectPath = async (
  projectRoot: string,
  relativePath: string,
  requiredPrefix: string
): Promise<string> => {
  if (!isProjectRelativePathSafe(relativePath) || !relativePath.startsWith(requiredPrefix)) {
    throw new Error(`Invalid project path for MCP tool: ${relativePath}`);
  }

  try {
    return await resolveProjectRelativePathInsideRealProject(projectRoot, relativePath);
  } catch (error) {
    if (error instanceof Error && error.name === "ProjectPathError") {
      throw new Error(`Invalid project path for MCP tool: ${relativePath}`);
    }
    throw error;
  }
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

const readRenderModeInput = (input: Record<string, unknown>): RenderMode => {
  const value = input.mode;
  if (value === undefined) {
    return "preview";
  }
  if (value === "preview" || value === "print" || value === "present") {
    return value;
  }
  throw new Error("MCP render tool mode must be preview, print, or present.");
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const readOptionalStringInput = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MCP tool input ${key} must be a non-empty string when provided.`);
  }
  return value;
};

const readCheckpointReferenceInput = (projectRoot: string, input: Record<string, unknown>) => ({
  projectRoot,
  checkpointId: readOptionalStringInput(input, "checkpointId"),
  runId: readOptionalStringInput(input, "runId")
});

const exportLoadedDeck = async (projectRoot: string, options: ExportOptions): Promise<ExportResult> => {
  const report = await checkProject({
    projectPath: projectRoot,
    writeReport: true
  });
  if (report.status !== "passed" || report.summary.errors > 0) {
    throw new McpExportCheckError(report);
  }

  const project = await loadDeckProject(projectRoot);
  return exportDeck(toCompilerInput(project), options);
};

const toCompilerInput = (project: LoadedDeckProject): CompilerProjectInput => ({
  projectPath: project.projectRoot,
  title: project.deck.title,
  language: project.deck.language,
  viewport: project.deck.viewport,
  safeArea: project.deck.safeArea,
  themeCssPath: project.deck.theme?.css,
  themeTokensPath: project.deck.theme?.tokens,
  slides: project.deck.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    sourcePath: slide.source,
    notesPath: slide.notes,
    durationSec: slide.durationSec
  }))
});
