import { describe, expect, it } from "vitest";
import { createAuditEntry, htmlslideTools, isProjectRelativePathSafe } from "../src/index";

describe("HTMLslide MCP tool registry", () => {
  it("lists planned tools and deprecated aliases", () => {
    const toolNames = new Set(htmlslideTools.map((tool) => tool.name));

    expect(toolNames).toContain("project_get_manifest");
    expect(toolNames).toContain("slide_write");
    expect(toolNames).toContain("export_pdf");
    expect(toolNames).toContain("checkpoint_revert");
    expect(toolNames).toContain("read_deck");
  });

  it("marks destructive checkpoint revert as dangerous", () => {
    expect(htmlslideTools.find((tool) => tool.name === "checkpoint_revert")?.safety).toBe("dangerous");
  });
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
