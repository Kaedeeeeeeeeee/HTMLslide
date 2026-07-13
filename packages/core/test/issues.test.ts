import { describe, expect, it } from "vitest";
import {
  mergeIssueSummaries,
  sortIssuesDeterministically,
  statusFromIssueSummary,
  summarizeIssues
} from "../src/index.js";

describe("issue aggregation", () => {
  it("summarizes severities and derives the failed status", () => {
    const summary = summarizeIssues([
      { severity: "info", type: "info", message: "Info" },
      { severity: "warning", type: "warning", message: "Warning" },
      { severity: "error", type: "error", message: "Error" }
    ]);

    expect(summary).toEqual({ errors: 1, warnings: 1, info: 1 });
    expect(statusFromIssueSummary(summary)).toBe("failed");
    expect(statusFromIssueSummary({ errors: 0, warnings: 2, info: 1 })).toBe("passed");
  });

  it("merges summaries without mutating the inputs", () => {
    const first = { errors: 1, warnings: 2, info: 3 };
    const second = { errors: 4, warnings: 5, info: 6 };

    expect(mergeIssueSummaries(first, second)).toEqual({ errors: 5, warnings: 7, info: 9 });
    expect(first).toEqual({ errors: 1, warnings: 2, info: 3 });
    expect(second).toEqual({ errors: 4, warnings: 5, info: 6 });
  });

  it("sorts issues deterministically by severity, slide, path, and message", () => {
    const issues = [
      { severity: "warning" as const, type: "remote-font", message: "Font", path: "theme.css" },
      { severity: "error" as const, type: "text-overflow", message: "Overflow", slideId: "002" },
      { severity: "error" as const, type: "missing-file", message: "Missing", slideId: "001", path: "slides/a.html" }
    ];

    expect(sortIssuesDeterministically(issues)).toEqual([issues[2], issues[1], issues[0]]);
    expect(issues[0].path).toBe("theme.css");
  });
});
