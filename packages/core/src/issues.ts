import { z } from "zod";

export const ISSUE_SEVERITIES = ["error", "warning", "info"] as const;

export const IssueSeveritySchema = z.enum(ISSUE_SEVERITIES);

export const HtmlslideIssueSchema = z
  .object({
    severity: IssueSeveritySchema,
    type: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1).optional(),
    slideId: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    suggestedFix: z.string().min(1).optional()
  })
  .strict();

export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;
export type HtmlslideIssue = z.infer<typeof HtmlslideIssueSchema>;

export interface IssueSummary {
  errors: number;
  warnings: number;
  info: number;
}

export type IssueStatus = "passed" | "failed";

export const EMPTY_ISSUE_SUMMARY: IssueSummary = Object.freeze({
  errors: 0,
  warnings: 0,
  info: 0
});

export function summarizeIssues(issues: readonly HtmlslideIssue[]): IssueSummary {
  return issues.reduce<IssueSummary>(
    (summary, issue) => {
      if (issue.severity === "error") {
        summary.errors += 1;
      } else if (issue.severity === "warning") {
        summary.warnings += 1;
      } else {
        summary.info += 1;
      }

      return summary;
    },
    { ...EMPTY_ISSUE_SUMMARY }
  );
}

export function statusFromIssueSummary(summary: IssueSummary): IssueStatus {
  return summary.errors > 0 ? "failed" : "passed";
}

export function mergeIssueSummaries(...summaries: readonly IssueSummary[]): IssueSummary {
  return summaries.reduce<IssueSummary>(
    (merged, summary) => ({
      errors: merged.errors + summary.errors,
      warnings: merged.warnings + summary.warnings,
      info: merged.info + summary.info
    }),
    { ...EMPTY_ISSUE_SUMMARY }
  );
}

export function sortIssuesDeterministically(issues: readonly HtmlslideIssue[]): HtmlslideIssue[] {
  return [...issues].sort((left, right) => {
    const leftKey = issueSortKey(left);
    const rightKey = issueSortKey(right);
    return leftKey.localeCompare(rightKey);
  });
}

function issueSortKey(issue: HtmlslideIssue): string {
  return [
    issue.severity,
    issue.slideId ?? "",
    issue.path ?? "",
    issue.type,
    issue.selector ?? "",
    issue.message
  ].join("\u0000");
}
