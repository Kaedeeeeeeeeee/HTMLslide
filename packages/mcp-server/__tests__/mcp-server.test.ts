import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createAuditEntry, createHtmlslideMcpServer, htmlslideTools, isProjectRelativePathSafe } from "../src/index";

const fixtureRoot = fileURLToPath(new URL("../../test-fixtures/decks/", import.meta.url));
const repoRoot = path.resolve(fixtureRoot, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cliBin = path.join(repoRoot, "packages", "cli", "src", "bin", "htmlslide.ts");

const withTempFixture = async <T>(fixtureName: string, callback: (projectPath: string) => Promise<T>): Promise<T> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-mcp-"));
  const projectPath = path.join(tempRoot, fixtureName);
  await cp(path.join(fixtureRoot, fixtureName), projectPath, { recursive: true });

  try {
    return await callback(projectPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const readStructuredToolResult = <T>(result: CallToolResult): T =>
  (result.structuredContent as { result: T }).result;

describe("HTMLslide MCP tool registry", () => {
  it("lists planned tools and deprecated aliases", () => {
    const toolNames = new Set(htmlslideTools.map((tool) => tool.name));

    expect(toolNames).toContain("project_get_manifest");
    expect(toolNames).toContain("slide_write");
    expect(toolNames).toContain("export_pdf");
    expect(toolNames).toContain("checkpoint_revert");
    expect(toolNames).toContain("read_deck");
    expect(htmlslideTools.find((tool) => tool.name === "export_deckpkg")).toMatchObject({
      implemented: true
    });
    expect(htmlslideTools.find((tool) => tool.name === "checkpoint_revert")).toMatchObject({
      implemented: true
    });
    expect(htmlslideTools.find((tool) => tool.name === "skill_list")).toMatchObject({
      implemented: true
    });
    expect(htmlslideTools.find((tool) => tool.name === "slide_write")).toMatchObject({
      implemented: true
    });
    expect(htmlslideTools.find((tool) => tool.name === "render_slide")).toMatchObject({
      implemented: false
    });
    expect(htmlslideTools.find((tool) => tool.name === "read_deck")).toMatchObject({
      deprecated: true,
      implemented: true
    });
    expect(htmlslideTools.find((tool) => tool.name === "export_deck")).toMatchObject({
      deprecated: true,
      implemented: true
    });
  });

  it("marks destructive checkpoint revert as dangerous", () => {
    expect(htmlslideTools.find((tool) => tool.name === "checkpoint_revert")?.safety).toBe("dangerous");
  });
});

describe("HTMLslide MCP in-process server", () => {
  it("starts against a deck project and lists tools", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });
      const started = await server.start();

      expect(started).toMatchObject({
        implementedToolCount: htmlslideTools.filter((tool) => tool.implemented).length,
        projectRoot: projectPath,
        registeredToolCount: htmlslideTools.length,
        status: "started",
        toolCount: htmlslideTools.length
      });
      expect(server.listTools().map((tool) => tool.name)).toEqual(htmlslideTools.map((tool) => tool.name));
    });
  });

  it("runs read-only tools inside the project boundary", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });
      const manifest = await server.callTool("project_get_manifest");
      const slideList = await server.callTool("project_list_slides");
      const slide = await server.callTool("slide_read", {
        path: "slides/001-clean.html"
      });

      expect(manifest).toMatchObject({
        deck: {
          title: "Linter Valid Clean"
        },
        projectRoot: projectPath
      });
      expect(slideList).toMatchObject({
        slides: [
          {
            id: "001-clean",
            source: "slides/001-clean.html",
            title: "Local QA Clean Slide"
          }
        ]
      });
      expect(slide).toMatchObject({
        content: expect.stringContaining('data-slide-id="001-clean"'),
        path: "slides/001-clean.html"
      });
    });
  });

  it("allows source writes and rejects write paths outside the tool scope", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });
      const content = '<section class="slide" data-slide-id="001-clean"><h1>Edited by MCP</h1></section>\n';
      const written = await server.callTool("slide_write", {
        content,
        path: "slides/001-clean.html"
      });

      expect(written).toMatchObject({
        audit: {
          action: "write",
          targetPath: "slides/001-clean.html",
          tool: "slide_write"
        },
        bytes: Buffer.byteLength(content, "utf8"),
        path: "slides/001-clean.html"
      });
      await expect(readFile(path.join(projectPath, "slides", "001-clean.html"), "utf8")).resolves.toBe(content);
      await expect(server.callTool("slide_write", {
        content,
        path: "../outside.html"
      })).rejects.toThrow("Invalid project path");
      await expect(server.callTool("slide_write", {
        content,
        path: "exports/001-clean.html"
      })).rejects.toThrow("Invalid project path");
    });
  });

  it("returns a schema-versioned check report", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });
      const report = await server.callTool("check_deck");

      expect(report).toMatchObject({
        projectPath,
        schemaVersion: "0.1.0",
        status: "passed",
        summary: {
          errors: 0
        }
      });
    });
  });

  it("creates a PDF artifact inside exports", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });
      const exported = await server.callTool("export_pdf");

      expect(exported).toMatchObject({
        audit: {
          action: "write",
          targetPath: "exports/linter-valid-clean.pdf",
          tool: "export_pdf"
        },
        export: {
          artifacts: {
            pdf: path.join(projectPath, "exports", "linter-valid-clean.pdf")
          }
        },
        pdf: path.join(projectPath, "exports", "linter-valid-clean.pdf"),
        projectRoot: projectPath
      });
      const pdfStat = await stat(path.join(projectPath, "exports", "linter-valid-clean.pdf"));
      expect(pdfStat.size).toBeGreaterThan(0);
      await expect(readFile(path.join(projectPath, ".htmlslide", "logs", "mcp-audit.jsonl"), "utf8")).resolves.toContain(
        "\"tool\":\"export_pdf\""
      );
    });
  });

  it("reads check reports, exports deckpkg, exposes skills, and manages checkpoints", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });

      await expect(server.callTool("get_check_report")).rejects.toThrow("Run check_deck before get_check_report");

      const checked = await server.callTool("check_deck");
      expect(checked).toMatchObject({
        status: "passed"
      });
      const report = await server.callTool("get_check_report");
      expect(report).toMatchObject({
        projectPath,
        status: "passed"
      });

      const deckpkg = await server.callTool("export_deckpkg");
      expect(deckpkg).toMatchObject({
        audit: {
          action: "write",
          targetPath: "exports/linter-valid-clean.deckpkg",
          tool: "export_deckpkg"
        },
        deckpkg: path.join(projectPath, "exports", "linter-valid-clean.deckpkg")
      });
      const deckpkgStat = await stat(path.join(projectPath, "exports", "linter-valid-clean.deckpkg"));
      expect(deckpkgStat.size).toBeGreaterThan(0);

      const fullExport = await server.callTool("export_deck");
      expect(fullExport).toMatchObject({
        audit: {
          action: "write",
          tool: "export_deck"
        },
        export: {
          artifacts: {
            deckpkg: path.join(projectPath, "exports", "linter-valid-clean.deckpkg"),
            html: path.join(projectPath, "exports", "linter-valid-clean.html"),
            pdf: path.join(projectPath, "exports", "linter-valid-clean.pdf")
          }
        }
      });
      expect((fullExport as { export: { artifacts: { thumbnails?: string[] } } }).export.artifacts.thumbnails).toHaveLength(1);

      const skills = await server.callTool("skill_list");
      expect(skills).toMatchObject({
        skillCount: expect.any(Number),
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: "deck-architect"
          })
        ])
      });
      const skill = await server.callTool("skill_get_instructions", {
        name: "deck-architect"
      });
      expect(skill).toMatchObject({
        markdown: expect.stringContaining("# deck-architect"),
        skill: {
          name: "deck-architect"
        }
      });
      await expect(server.callTool("skill_get_instructions", {
        name: "missing-skill"
      })).rejects.toThrow("Unknown official HTMLslide skill");

      const checkpointCreated = await server.callTool("checkpoint_create", {
        runId: "run-mcp"
      });
      expect(checkpointCreated).toMatchObject({
        audit: {
          action: "checkpoint",
          tool: "checkpoint_create"
        },
        checkpoint: {
          id: "checkpoint-run-mcp",
          runId: "run-mcp"
        }
      });

      await server.callTool("slide_write", {
        content: '<section class="slide" data-slide-id="001-clean"><h1>Changed after checkpoint</h1></section>\n',
        path: "slides/001-clean.html"
      });
      const checkpointDiff = await server.callTool("checkpoint_diff", {
        checkpointId: "checkpoint-run-mcp"
      });
      expect(checkpointDiff).toMatchObject({
        summary: {
          changed: 1
        }
      });

      await expect(server.callTool("checkpoint_revert", {
        checkpointId: "checkpoint-run-mcp"
      })).rejects.toThrow("confirm: true");

      const checkpointReverted = await server.callTool("checkpoint_revert", {
        checkpointId: "checkpoint-run-mcp",
        confirm: true
      });
      expect(checkpointReverted).toMatchObject({
        audit: {
          action: "dangerous",
          tool: "checkpoint_revert"
        },
        restored: expect.arrayContaining(["slides/001-clean.html"])
      });
      await expect(readFile(path.join(projectPath, "slides", "001-clean.html"), "utf8")).resolves.toContain(
        "Local QA Clean Slide"
      );
      const auditLog = await readFile(path.join(projectPath, ".htmlslide", "logs", "mcp-audit.jsonl"), "utf8");
      expect(auditLog).toContain("\"tool\":\"checkpoint_create\"");
      expect(auditLog).toContain("\"tool\":\"slide_write\"");
      expect(auditLog).toContain("\"tool\":\"checkpoint_revert\"");
    });
  });

  it("denies invalid read paths before touching the filesystem", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const server = createHtmlslideMcpServer({ projectRoot: projectPath });

      await expect(server.callTool("slide_read", {
        path: "/tmp/secret.html"
      })).rejects.toThrow("Invalid project path");
      await expect(server.callTool("notes_read", {
        path: "slides/001-clean.html"
      })).rejects.toThrow("Invalid project path");
    });
  });
});

describe("HTMLslide MCP stdio server", () => {
  it("serves implemented tools through the CLI stdio transport", async () => {
    await withTempFixture("linter-valid-clean", async (projectPath) => {
      const transport = new StdioClientTransport({
        args: [cliBin, "mcp", projectPath],
        command: tsxBin,
        cwd: repoRoot,
        stderr: "pipe"
      });
      const stderrChunks: Buffer[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk));
      });

      const client = new Client({
        name: "htmlslide-mcp-test-client",
        version: "0.0.0"
      });

      try {
        await client.connect(transport);

        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool) => tool.name);
        expect(toolNames).toContain("project_get_manifest");
        expect(toolNames).toContain("slide_read");
        expect(toolNames).toContain("check_deck");
        expect(toolNames).toContain("checkpoint_revert");
        expect(toolNames).not.toContain("render_slide");
        expect(tools.tools.find((tool) => tool.name === "project_get_manifest")?._meta).toMatchObject({
          implemented: true,
          safety: "read-only"
        });

        const manifest = readStructuredToolResult<{ deck: { title: string }; projectRoot: string }>(
          await client.callTool({
            name: "project_get_manifest"
          }) as CallToolResult
        );
        expect(manifest).toMatchObject({
          deck: {
            title: "Linter Valid Clean"
          },
          projectRoot: projectPath
        });

        const check = readStructuredToolResult<{ status: string }>(
          await client.callTool({
            name: "check_deck"
          }) as CallToolResult
        );
        expect(check.status).toBe("passed");

        const unsafeRead = await client.callTool({
          arguments: {
            path: "../outside.html"
          },
          name: "slide_read"
        }) as CallToolResult;
        expect(unsafeRead.isError).toBe(true);
        expect(unsafeRead.content[0]).toMatchObject({
          text: expect.stringContaining("Invalid project path"),
          type: "text"
        });
      } finally {
        await client.close();
      }

      expect(Buffer.concat(stderrChunks).toString("utf8")).not.toContain("MCP alpha harness ready");
    });
  }, 20000);
});

describe("MCP project path safety", () => {
  it.each(["slides/001-title.html", "notes/001-title.md", ".htmlslide/reports/check-report.json"])(
    "accepts safe project-relative path %s",
    (safePath) => {
      expect(isProjectRelativePathSafe(safePath)).toBe(true);
    }
  );

  it.each([
    "",
    " slides/001-title.html",
    "/tmp/secret",
    "C:/Users/secret",
    "https://example.com/slide.html",
    "slides/%2e%2e/secret.html",
    "slides/%2Fsecret.html",
    "slides/%",
    "slides/\0secret.html",
    "slides/../secret.html",
    "slides//001-title.html",
    "slides/./001-title.html",
    "slides\\001-title.html"
  ])("rejects unsafe project path %s", (unsafePath) => {
    expect(isProjectRelativePathSafe(unsafePath)).toBe(false);
  });
});

describe("MCP audit entries", () => {
  it("creates timestamped audit entries for write tools", () => {
    const entry = createAuditEntry({
      action: "write",
      tool: "slide_write",
      projectPath: "/tmp/demo",
      targetPath: "slides/001-title.html",
      summary: "Updated title slide"
    });

    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.tool).toBe("slide_write");
  });
});
