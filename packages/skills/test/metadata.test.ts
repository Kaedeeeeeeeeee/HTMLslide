import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../test-fixtures/skills/", import.meta.url));

function readSkillFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, name, "SKILL.md"), "utf8");
}

describe("skill metadata parsing and validation", () => {
  it("parses valid SKILL.md frontmatter into typed metadata", () => {
    const result = parseSkillMarkdown(readSkillFixture("valid-deck-skill"));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.issues.map((issue) => issue.message).join("\n"));
    }

    expect(result.document.metadata).toMatchObject({
      name: "deck-architect-test",
      version: "0.1.0",
      license: "MIT",
      entrypoint: "SKILL.md",
      supportedDeckSchema: ["0.1.0"],
      riskLevel: "low",
      installTargets: ["global", "project"],
      deck: {
        type: "planning",
        output: "html-slide",
        viewport: "1920x1080",
        risk: {
          scripts: false,
          network: false,
          remoteAssets: false,
          writesExports: false,
          writesSecrets: false,
          modifiesSource: true
        }
      }
    });
    expect(result.document.metadata.deck.preview).toEqual({
      type: "html",
      entry: "assets/preview.html"
    });
    expect(result.document.body).toContain("# Deck Architect Test");
  });

  it("rejects unsupported licenses", () => {
    const result = parseSkillMarkdown(readSkillFixture("invalid-license"));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("invalid-license unexpectedly parsed");
    }
    expect(result.issues.map((issue) => issue.code)).toContain("invalid-license");
  });

  it("rejects unsupported risk levels", () => {
    const result = parseSkillMarkdown(readSkillFixture("invalid-risk"));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("invalid-risk unexpectedly parsed");
    }
    expect(result.issues.map((issue) => issue.code)).toContain("invalid-risk-level");
  });
});
