import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadDeckProject,
  normalizeDeckPath,
  ProjectLoadError,
  resolveProjectRelativePath,
  resolveProjectRoot,
  tryLoadDeckProject
} from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../test-fixtures/decks/", import.meta.url));

function fixturePath(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

describe("project loading", () => {
  it("loads a full project and resolves slide and theme files", async () => {
    const project = await loadDeckProject(fixturePath("valid-full"));

    expect(project.deck.id).toBe("deck_valid_full");
    expect(project.projectRoot).toBe(fixturePath("valid-full"));
    expect(project.deckPath).toBe(path.join(fixturePath("valid-full"), "deck.json"));
    expect(project.slides.map((slide) => slide.id)).toEqual(["001-title", "002-structure"]);
    expect(project.slides[0].sourcePath).toBe(path.join(fixturePath("valid-full"), "slides", "001-title.html"));
    expect(project.slides[0].notesPath).toBe(path.join(fixturePath("valid-full"), "notes", "001-title.md"));
    expect(project.theme?.cssPath).toBe(path.join(fixturePath("valid-full"), "theme", "theme.css"));
    expect(project.theme?.tokensPath).toBe(path.join(fixturePath("valid-full"), "theme", "tokens.json"));
  });

  it("accepts deck.json as the load target", async () => {
    const project = await loadDeckProject(path.join(fixturePath("valid-minimal"), "deck.json"));

    expect(project.projectRoot).toBe(fixturePath("valid-minimal"));
    expect(project.deck.title).toBe("Valid Minimal Deck");
  });

  it("finds the project root from a nested source file", async () => {
    const nestedSlidePath = path.join(fixturePath("valid-minimal"), "slides", "001-title.html");

    await expect(resolveProjectRoot(nestedSlidePath)).resolves.toBe(fixturePath("valid-minimal"));
  });

  it("reports missing slide source files with project-loader issues", async () => {
    try {
      await loadDeckProject(fixturePath("invalid-missing-slide-source"));
      throw new Error("Expected loadDeckProject to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectLoadError);
      const projectError = error as ProjectLoadError;
      expect(projectError.code).toBe("MISSING_PROJECT_FILE");
      expect(projectError.issues).toEqual([
        {
          severity: "error",
          type: "missing-file",
          path: "slides/001-missing.html",
          slideId: "001-missing",
          message: "Missing slide source: slides/001-missing.html.",
          suggestedFix: "Create slides/001-missing.html or update deck.json to point at an existing project file."
        }
      ]);
    }
  });

  it("can skip file verification when callers only need manifest resolution", async () => {
    const project = await loadDeckProject(fixturePath("invalid-missing-slide-source"), {
      verifyFiles: false
    });

    expect(project.deck.id).toBe("deck_missing_slide_source");
    expect(project.slides[0].sourcePath).toBe(
      path.join(fixturePath("invalid-missing-slide-source"), "slides", "001-missing.html")
    );
  });

  it("returns structured failures from tryLoadDeckProject", async () => {
    const result = await tryLoadDeckProject(fixturePath("invalid-duplicate-slide-id"));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid duplicate fixture to fail");
    }

    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.issues.map((issue) => issue.path)).toContain("slides.1.id");
  });

  it("classifies an unsupported schema version separately from other validation failures", async () => {
    const result = await tryLoadDeckProject(fixturePath("invalid-unsupported-schema"));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected unsupported schema fixture to fail");
    }

    expect(result.error.code).toBe("INCOMPATIBLE_SCHEMA");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ type: "schema-validation", path: "schemaVersion" })
    );
  });

  it("reports malformed deck JSON as a structured invalid-json issue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-core-"));
    try {
      await fs.writeFile(path.join(root, "deck.json"), '{"schemaVersion":');
      const result = await tryLoadDeckProject(root);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected malformed deck JSON to fail");
      }
      expect(result.error.code).toBe("INVALID_JSON");
      expect(result.issues).toEqual([
        expect.objectContaining({ type: "invalid-json", path: "deck.json" })
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports unreadable deck paths as structured project-read-failed issues", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-core-"));
    try {
      await fs.mkdir(path.join(root, "deck.json"));
      const result = await tryLoadDeckProject(root);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected directory-backed deck.json to fail");
      }
      expect(result.error.code).toBe("DECK_READ_FAILED");
      expect(result.issues).toEqual([
        expect.objectContaining({ type: "project-read-failed", path: "deck.json" })
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("classifies deck read permission failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslide-core-"));
    const deckPath = path.join(root, "deck.json");
    try {
      await fs.writeFile(deckPath, '{"schemaVersion":"0.1.0"}');
      await fs.chmod(deckPath, 0o000);
      const result = await tryLoadDeckProject(root);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected unreadable deck.json to fail");
      }
      expect(result.error.code).toBe("PERMISSION_DENIED");
      expect(result.issues).toEqual([
        expect.objectContaining({ type: "permission-denied", path: "deck.json" })
      ]);
    } finally {
      await fs.chmod(deckPath, 0o600).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("project path helpers", () => {
  it("normalizes safe deck paths", () => {
    expect(normalizeDeckPath("slides/001-title.html")).toBe("slides/001-title.html");
  });

  it("resolves project-relative paths inside the project root", () => {
    expect(resolveProjectRelativePath(fixturePath("valid-minimal"), "slides/001-title.html")).toBe(
      path.join(fixturePath("valid-minimal"), "slides", "001-title.html")
    );
  });

  it.each(["/tmp/slide.html", "slides/../secret.html", "slides//001-title.html", "https://example.com/a.html"])(
    "rejects unsafe deck path %s",
    (unsafePath) => {
      expect(() => normalizeDeckPath(unsafePath)).toThrow();
    }
  );
});
