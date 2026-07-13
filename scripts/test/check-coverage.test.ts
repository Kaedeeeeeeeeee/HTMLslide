import { describe, expect, it } from "vitest";
import { runCoverageGates } from "./check-coverage.mjs";

describe("coverage gate runner", () => {
  it("runs every declared scope and returns the measured line coverage", async () => {
    const commands: string[][] = [];
    const result = await runCoverageGates({
      temporaryRoot: "/tmp/htmlslide-coverage-test",
      runCommand: (args) => {
        commands.push(args);
        return { status: 0 };
      },
      readSummary: async (reportDirectory) => ({
        total: { lines: { pct: reportDirectory.includes("linter") ? 80.04 : 88.02 } }
      })
    });

    expect(result).toEqual([
      { name: "core", lines: 88.02, threshold: 85 },
      { name: "linter", lines: 80.04, threshold: 80 },
      { name: "agent-adapters", lines: 88.02, threshold: 80 }
    ]);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("--coverage.include=packages/core/src/**/*.ts");
    expect(commands[1]).toContain("packages/linter/test/checker.test.ts");
    expect(commands[2]).toContain("packages/agent-adapters/test/agent-adapters.test.ts");
  });

  it("fails closed when one scope falls below its threshold", async () => {
    await expect(
      runCoverageGates({
        temporaryRoot: "/tmp/htmlslide-coverage-test",
        runCommand: () => ({ status: 0 }),
        readSummary: async (reportDirectory) => ({
          total: { lines: { pct: reportDirectory.includes("linter") ? 79.99 : 88.02 } }
        })
      })
    ).rejects.toThrow("linter line coverage is 79.99%; required at least 80%.");
  });
});
