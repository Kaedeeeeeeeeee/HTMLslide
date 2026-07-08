import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type IssueSeverity = "error" | "warning" | "suggestion";

export type HtmlslideIssue = {
  slideId: string;
  severity: IssueSeverity;
  type:
    | "missing-slide-source"
    | "missing-notes"
    | "slide-id-mismatch"
    | "remote-asset"
    | "remote-font"
    | "text-overflow"
    | "safe-area-violation"
    | "title-too-long";
  selector?: string;
  message: string;
  measurement?: Record<string, number | string | boolean>;
  suggestedFix: string;
  agentInstruction: string;
};

export type CheckReport = {
  status: "passed" | "failed";
  projectPath: string;
  summary: {
    errors: number;
    warnings: number;
    suggestions: number;
    info: number;
  };
  issues: HtmlslideIssue[];
};

export type LintSlideInput = {
  id: string;
  title: string;
  sourcePath: string;
  notesPath?: string;
};

export type LintProjectInput = {
  projectPath: string;
  slides: LintSlideInput[];
  writeReport?: boolean;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const countBySeverity = (issues: HtmlslideIssue[], severity: IssueSeverity): number =>
  issues.filter((issue) => issue.severity === severity).length;

const checkSlideSource = async (projectPath: string, slide: LintSlideInput): Promise<HtmlslideIssue[]> => {
  const issues: HtmlslideIssue[] = [];
  const sourcePath = path.resolve(projectPath, slide.sourcePath);
  if (!(await exists(sourcePath))) {
    return [
      {
        slideId: slide.id,
        severity: "error",
        type: "missing-slide-source",
        message: `Slide source is missing: ${slide.sourcePath}`,
        suggestedFix: "Create the missing slide HTML fragment or remove it from deck.json.",
        agentInstruction: `Create ${slide.sourcePath} for slide ${slide.id}, or update deck.json to point at an existing source file.`
      }
    ];
  }

  const html = await readFile(sourcePath, "utf8");
  const slideIdMatch = html.match(/data-slide-id=["']([^"']+)["']/);
  if (!slideIdMatch) {
    issues.push({
      slideId: slide.id,
      severity: "error",
      type: "slide-id-mismatch",
      selector: ".slide",
      message: "Slide fragment is missing data-slide-id.",
      suggestedFix: "Add data-slide-id to the root slide section.",
      agentInstruction: `Add data-slide-id="${slide.id}" to the root <section> for slide ${slide.id}.`
    });
  } else if (slideIdMatch[1] !== slide.id) {
    issues.push({
      slideId: slide.id,
      severity: "error",
      type: "slide-id-mismatch",
      selector: ".slide",
      message: `data-slide-id is ${slideIdMatch[1]}, expected ${slide.id}.`,
      suggestedFix: "Keep deck.json and slide source ids identical.",
      agentInstruction: `Change the root slide data-slide-id to "${slide.id}" without changing the deck.json id.`
    });
  }

  if (/https?:\/\//i.test(html)) {
    issues.push({
      slideId: slide.id,
      severity: "warning",
      type: "remote-asset",
      message: "Slide source references a remote URL.",
      suggestedFix: "Move assets into the project assets folder and reference them locally.",
      agentInstruction: `Replace remote URLs in slide ${slide.id} with project-local assets.`
    });
  }

  if (/@import\s+url\(|fonts\.googleapis|fonts\.gstatic/i.test(html)) {
    issues.push({
      slideId: slide.id,
      severity: "warning",
      type: "remote-font",
      message: "Slide source appears to reference remote fonts.",
      suggestedFix: "Bundle fonts locally or use system fonts.",
      agentInstruction: `Remove remote font references from slide ${slide.id}.`
    });
  }

  if (slide.title.length > 72) {
    issues.push({
      slideId: slide.id,
      severity: "suggestion",
      type: "title-too-long",
      selector: "h1",
      message: "Slide title is long for a presentation viewport.",
      measurement: { titleLength: slide.title.length },
      suggestedFix: "Shorten the title or split the slide.",
      agentInstruction: `Shorten the title for slide ${slide.id} while preserving the main claim.`
    });
  }

  return issues;
};

export const checkProject = async (project: LintProjectInput): Promise<CheckReport> => {
  const issues = (
    await Promise.all(
      project.slides.map(async (slide) => {
        const slideIssues = await checkSlideSource(project.projectPath, slide);
        if (!slide.notesPath) {
          slideIssues.push({
            slideId: slide.id,
            severity: "warning",
            type: "missing-notes",
            message: "Slide has no speaker notes file.",
            suggestedFix: "Add notes/<slide-id>.md and reference it from deck.json.",
            agentInstruction: `Create speaker notes for slide ${slide.id} and reference them in deck.json.`
          });
        } else if (!(await exists(path.resolve(project.projectPath, slide.notesPath)))) {
          slideIssues.push({
            slideId: slide.id,
            severity: "warning",
            type: "missing-notes",
            message: `Speaker notes file is missing: ${slide.notesPath}`,
            suggestedFix: "Create the missing notes Markdown file.",
            agentInstruction: `Create ${slide.notesPath} with concise speaker notes for slide ${slide.id}.`
          });
        }
        return slideIssues;
      })
    )
  ).flat();

  const report: CheckReport = {
    status: countBySeverity(issues, "error") > 0 ? "failed" : "passed",
    projectPath: project.projectPath,
    summary: {
      errors: countBySeverity(issues, "error"),
      warnings: countBySeverity(issues, "warning"),
      suggestions: countBySeverity(issues, "suggestion"),
      info: 0
    },
    issues
  };

  if (project.writeReport) {
    const reportPath = path.join(project.projectPath, ".htmlslide", "reports", "check-report.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
};
