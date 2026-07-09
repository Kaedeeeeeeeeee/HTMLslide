import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const requiredTemplates = {
  ".github/ISSUE_TEMPLATE/bug_report.yml": [
    "name: Bug report",
    "labels:",
    "- bug",
    "id: area",
    "id: steps",
    "id: expected",
    "id: actual",
    "id: version",
    "id: platform",
    "id: diagnostics",
    "id: privacy",
    "htmlslide doctor --json",
    "API keys",
    "provider tokens",
    "private deck content"
  ],
  ".github/ISSUE_TEMPLATE/deck_rendering_bug.yml": [
    "name: Deck rendering bug",
    "- rendering",
    "- bug",
    "id: version",
    "id: output",
    "id: deck",
    "id: commands",
    "id: expected",
    "id: actual",
    "id: privacy",
    "htmlslide export <project>",
    "private deck content"
  ],
  ".github/ISSUE_TEMPLATE/external_agent_integration_bug.yml": [
    "name: External agent integration bug",
    "- external-agent",
    "- bug",
    "id: version",
    "id: platform",
    "id: adapter",
    "id: workflow",
    "id: steps",
    "id: expected",
    "id: actual",
    "id: boundary",
    "id: diagnostics",
    "id: privacy",
    "htmlslide agent validate-provider",
    "MCP --status",
    "raw provider prompts"
  ],
  ".github/ISSUE_TEMPLATE/feature_request.yml": [
    "name: Feature request",
    "- enhancement",
    "id: problem",
    "id: proposal",
    "id: area",
    "id: local_first_boundary",
    "id: acceptance"
  ],
  ".github/ISSUE_TEMPLATE/skill_contribution.yml": [
    "name: Skill contribution",
    "- skill",
    "id: contribution_type",
    "id: skill_name",
    "id: license",
    "id: scripts",
    "id: boundaries",
    "id: fixtures",
    "id: tests",
    "external network access",
    "compatible license"
  ],
  ".github/ISSUE_TEMPLATE/config.yml": [
    "blank_issues_enabled: false",
    "Security vulnerability",
    "security/advisories/new",
    "Report exploitable vulnerabilities privately."
  ],
  ".github/pull_request_template.md": [
    "# Summary",
    "# Tests",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm docs:build",
    "# Security and Data Boundaries",
    "No API keys",
    "No undeclared external network access",
    "Project-boundary behavior"
  ]
};

const requiredIssueFields = {
  ".github/ISSUE_TEMPLATE/bug_report.yml": [
    "summary",
    "area",
    "steps",
    "expected",
    "actual",
    "version",
    "platform",
    "diagnostics",
    "privacy"
  ],
  ".github/ISSUE_TEMPLATE/deck_rendering_bug.yml": [
    "summary",
    "version",
    "output",
    "deck",
    "commands",
    "expected",
    "actual",
    "platform",
    "privacy"
  ],
  ".github/ISSUE_TEMPLATE/external_agent_integration_bug.yml": [
    "summary",
    "version",
    "platform",
    "adapter",
    "workflow",
    "steps",
    "expected",
    "actual",
    "boundary",
    "diagnostics",
    "privacy"
  ],
  ".github/ISSUE_TEMPLATE/feature_request.yml": [
    "problem",
    "proposal",
    "area",
    "local_first_boundary",
    "acceptance"
  ],
  ".github/ISSUE_TEMPLATE/skill_contribution.yml": [
    "contribution_type",
    "skill_name",
    "use_case",
    "license",
    "scripts",
    "boundaries",
    "fixtures",
    "tests"
  ]
};

const failures = [];

function issueFieldBlock(contents, fieldId) {
  const pattern = new RegExp(`\\n\\s+id: ${fieldId}\\n[\\s\\S]*?(?=\\n\\s+- type:|\\n*$)`, "u");
  return contents.match(pattern)?.[0] ?? "";
}

function issueFieldIsRequired(contents, fieldId) {
  const block = issueFieldBlock(contents, fieldId);
  return /\n\s+required: true(?:\n|$)/u.test(block);
}

for (const [relativePath, requiredSnippets] of Object.entries(requiredTemplates)) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing issue template: ${relativePath}`);
    continue;
  }

  const contents = await readFile(absolutePath, "utf8");
  for (const snippet of requiredSnippets) {
    if (!contents.includes(snippet)) {
      failures.push(`${relativePath} must include: ${snippet}`);
    }
  }

  const requiredFields = requiredIssueFields[relativePath] ?? [];
  for (const fieldId of requiredFields) {
    if (!issueFieldIsRequired(contents, fieldId)) {
      failures.push(`${relativePath} field ${fieldId} must be required.`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Issue template contract passed (${Object.keys(requiredTemplates).length} templates).\n`);
}
