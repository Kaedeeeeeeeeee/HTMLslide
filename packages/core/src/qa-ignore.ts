import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectRelativePathInsideRealProject } from "./paths.js";

export const QA_IGNORE_RULES_PATH = ".htmlslide/qa-ignores.json";

export type QaIgnoreConfig = {
  version: 1;
  issueTypes: string[];
};

const emptyQaIgnoreConfig = (): QaIgnoreConfig => ({ version: 1, issueTypes: [] });

export const readQaIgnoreConfig = async (projectRoot: string): Promise<QaIgnoreConfig> => {
  const rulesPath = await resolveProjectRelativePathInsideRealProject(projectRoot, QA_IGNORE_RULES_PATH);
  try {
    const parsed = JSON.parse(await readFile(rulesPath, "utf8")) as Partial<QaIgnoreConfig>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.issueTypes) ||
      parsed.issueTypes.some((issueType) => typeof issueType !== "string" || issueType.trim().length === 0)
    ) {
      throw new Error("QA ignore rules must contain version 1 and a non-empty issueTypes array.");
    }
    return {
      issueTypes: [...new Set(parsed.issueTypes.map((issueType) => issueType.trim()))].sort(),
      version: 1
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyQaIgnoreConfig();
    }
    throw error;
  }
};

export const addQaIgnoreRule = async (projectRoot: string, issueType: string): Promise<QaIgnoreConfig> => {
  const normalizedIssueType = issueType.trim();
  if (normalizedIssueType.length === 0) {
    throw new Error("QA ignore rules require an issue type.");
  }
  const next = await readQaIgnoreConfig(projectRoot);
  if (!next.issueTypes.includes(normalizedIssueType)) {
    next.issueTypes.push(normalizedIssueType);
    next.issueTypes.sort();
  }
  const rulesPath = await resolveProjectRelativePathInsideRealProject(projectRoot, QA_IGNORE_RULES_PATH);
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
};
