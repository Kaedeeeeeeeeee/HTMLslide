import {
  type SkillMarkdownParseResult,
  type SkillMetadataValidationOptions,
  type SkillValidationIssue
} from "./types.js";
import { validateSkillMetadata } from "./validation.js";

interface FrontmatterParts {
  rawFrontmatter: string;
  body: string;
}

interface ParserFrame {
  indent: number;
  value: Record<string, unknown> | unknown[];
}

function invalidFrontmatter(path: string, message: string): SkillValidationIssue {
  return { code: "invalid-frontmatter", path, message };
}

export function extractFrontmatter(markdown: string): FrontmatterParts | undefined {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      return {
        rawFrontmatter: lines.slice(1, index).join("\n"),
        body: lines.slice(index + 1).join("\n").trimStart()
      };
    }
  }

  return undefined;
}

function parseScalar(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function getIndent(rawLine: string): number {
  const whitespace = rawLine.match(/^\s*/)?.[0] ?? "";
  if (whitespace.includes("\t")) {
    throw new Error("Tabs are not supported in skill frontmatter indentation.");
  }
  return whitespace.length;
}

function nextNestedLine(lines: string[], currentIndex: number, parentIndent: number): string | undefined {
  for (let index = currentIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined || rawLine.trim().length === 0 || rawLine.trim().startsWith("#")) {
      continue;
    }
    if (getIndent(rawLine) <= parentIndent) {
      return undefined;
    }
    return rawLine.trim();
  }
  return undefined;
}

export function parseFrontmatterObject(rawFrontmatter: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: ParserFrame[] = [{ indent: -1, value: root }];
  const lines = rawFrontmatter.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined || rawLine.trim().length === 0 || rawLine.trim().startsWith("#")) {
      continue;
    }

    const indent = getIndent(rawLine);
    const trimmed = rawLine.trim();
    while (stack.length > 1) {
      const current = stack[stack.length - 1];
      if (current !== undefined && indent <= current.indent) {
        stack.pop();
      } else {
        break;
      }
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      throw new Error("Internal frontmatter parser error.");
    }

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(parent.value)) {
        throw new Error(`Unexpected list item at line ${index + 1}.`);
      }
      parent.value.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    if (Array.isArray(parent.value)) {
      throw new Error(`Unexpected mapping entry inside list at line ${index + 1}.`);
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(trimmed);
    if (match === null) {
      throw new Error(`Unsupported frontmatter syntax at line ${index + 1}.`);
    }

    const key = match[1];
    const rawValue = match[2];
    if (key === undefined) {
      throw new Error(`Missing key at line ${index + 1}.`);
    }

    if (rawValue === undefined || rawValue.length === 0) {
      const nestedLine = nextNestedLine(lines, index, indent);
      const child: Record<string, unknown> | unknown[] = nestedLine?.startsWith("- ") ? [] : {};
      parent.value[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent.value[key] = parseScalar(rawValue);
    }
  }

  return root;
}

export function parseSkillMarkdown(
  markdown: string,
  options: SkillMetadataValidationOptions = {}
): SkillMarkdownParseResult {
  const parts = extractFrontmatter(markdown);
  if (parts === undefined) {
    return {
      ok: false,
      issues: [invalidFrontmatter("", "SKILL.md must start with YAML frontmatter delimited by --- markers.")]
    };
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatterObject(parts.rawFrontmatter);
  } catch (error) {
    return {
      ok: false,
      rawFrontmatter: parts.rawFrontmatter,
      body: parts.body,
      issues: [
        invalidFrontmatter(
          "",
          error instanceof Error ? error.message : "Skill frontmatter could not be parsed."
        )
      ]
    };
  }

  const result = validateSkillMetadata(frontmatter, options);
  if (!result.ok) {
    return {
      ok: false,
      rawFrontmatter: parts.rawFrontmatter,
      body: parts.body,
      frontmatter,
      issues: result.issues
    };
  }

  return {
    ok: true,
    document: {
      metadata: result.metadata,
      body: parts.body,
      frontmatter,
      rawFrontmatter: parts.rawFrontmatter
    },
    issues: []
  };
}
