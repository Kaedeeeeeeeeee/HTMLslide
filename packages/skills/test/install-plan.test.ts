import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateLicenseCompatibility, parseSkillMarkdown, planSkillInstall } from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../test-fixtures/skills/", import.meta.url));

function readSkillFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, name, "SKILL.md"), "utf8");
}

describe("skill install planning", () => {
  it("treats official bundle license compatibility more strictly than project installs", () => {
    expect(evaluateLicenseCompatibility("BSD-3-Clause").compatibility).toBe("compatible");
    expect(evaluateLicenseCompatibility("BSD-3-Clause", "official-bundle").compatibility).toBe("incompatible");
  });

  it("plans a global install without reading the real home directory", () => {
    const markdown = readSkillFixture("valid-deck-skill");
    const parsed = parseSkillMarkdown(markdown);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
    }

    const plan = planSkillInstall({
      metadata: parsed.document.metadata,
      markdown,
      target: { kind: "global", homeDir: "/tmp/htmlslide-home" }
    });

    expect(plan.target).toBe("global");
    expect(plan.filesToWrite.map((file) => file.path)).toEqual([
      "/tmp/htmlslide-home/.htmlslide/skills/deck-architect-test/SKILL.md"
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.installable).toBe(true);
  });

  it("accepts a resolved HTMLslide state directory for desktop reuse", () => {
    const markdown = readSkillFixture("valid-deck-skill");
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
    }

    const plan = planSkillInstall({
      metadata: parsed.document.metadata,
      markdown,
      target: { kind: "global", htmlslideHomeDir: "/tmp/htmlslide-state" }
    });

    expect(plan.filesToWrite.map((file) => file.path)).toEqual([
      "/tmp/htmlslide-state/skills/deck-architect-test/SKILL.md"
    ]);
  });

  it("rejects unsupported and empty target selections in the pure plan", () => {
    const markdown = readSkillFixture("valid-deck-skill");
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
    }

    const unsupported = planSkillInstall({
      metadata: { ...parsed.document.metadata, installTargets: ["project"] },
      markdown,
      target: { kind: "global", homeDir: "/tmp/htmlslide-home" }
    });
    expect(unsupported.installable).toBe(false);
    expect(unsupported.filesToWrite).toEqual([]);
    expect(unsupported.warnings.at(-1)?.code).toBe("unsupported-install-target");

    const empty = planSkillInstall({
      metadata: parsed.document.metadata,
      markdown,
      target: { kind: "project", projectRoot: "/tmp/htmlslide-project", locations: [] }
    });
    expect(empty.installable).toBe(false);
    expect(empty.filesToWrite).toEqual([]);
    expect(empty.warnings.at(-1)).toMatchObject({ code: "invalid-project-location", severity: "error" });
  });

  it("plans project install files and reports risk and license warnings", () => {
    const markdown = readSkillFixture("scripted-third-party");
    const parsed = parseSkillMarkdown(markdown);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
    }

    const plan = planSkillInstall({
      metadata: parsed.document.metadata,
      markdown,
      target: {
        kind: "project",
        projectRoot: "/tmp/htmlslide-project",
        locations: ["project", "codex", "claude"]
      }
    });

    expect(plan.target).toBe("project");
    expect(plan.filesToWrite.map((file) => file.path)).toEqual([
      "/tmp/htmlslide-project/skills/project/scripted-third-party/SKILL.md",
      "/tmp/htmlslide-project/.agents/skills/htmlslide/scripted-third-party/SKILL.md",
      "/tmp/htmlslide-project/.claude/skills/htmlslide/scripted-third-party/SKILL.md"
    ]);
    expect(plan.filesToWrite.every((file) => file.content === markdown)).toBe(true);
    expect(plan.license.compatibility).toBe("review-required");
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      "contains-scripts",
      "uses-network",
      "remote-assets",
      "high-risk",
      "license-review-required"
    ]);
    expect(plan.installable).toBe(true);
  });
});
