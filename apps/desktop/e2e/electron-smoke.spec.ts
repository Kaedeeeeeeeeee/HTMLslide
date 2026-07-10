import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { readDeckPackage } from "@htmlslide/presenter";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readPdfPageCount, readPngSize } from "../../../packages/compiler/src/index";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(e2eDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const electronMain = path.join(desktopRoot, "dist", "electron", "main.js");
const sampleProjectPath = path.join(repoRoot, "packages", "test-fixtures", "decks", "valid-full");
const intentionalFailuresProjectPath = path.join(
  repoRoot,
  "packages",
  "test-fixtures",
  "decks",
  "linter-intentional-failures"
);
const textOverflowProjectPath = path.join(repoRoot, "packages", "test-fixtures", "decks", "linter-text-overflow");
const requireFromDesktop = createRequire(path.join(desktopRoot, "package.json"));
const electronExecutable = requireFromDesktop("electron") as string;
const execFile = promisify(execFileCallback);

async function exportDeckPackage(projectPath: string): Promise<string> {
  const cliBin = path.join(repoRoot, "packages", "cli", "dist", "bin", "htmlslide.js");
  await execFile(process.execPath, [cliBin, "export", projectPath, "--json"], {
    cwd: repoRoot,
    env: process.env
  });
  return path.join(projectPath, "exports", "valid-full-deck.deckpkg");
}

async function expectNoFrameworkOverlay(page: Page): Promise<void> {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator("[data-nextjs-dialog-overlay], #webpack-dev-server-client-overlay")).toHaveCount(0);
  await expect(
    page.getByText(/\[plugin:vite|Internal server error|Failed to resolve import|Failed to load module script/i)
  ).toHaveCount(0);
}

function collectBrowserErrors(page: Page): string[] {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });
  return browserErrors;
}

type FakeOpenAiServer = {
  baseUrl: string;
  calls: Array<{ method: string; path: string; stage?: string }>;
  close: () => Promise<void>;
};

async function startFakeOpenAiCompatibleServer(title: string): Promise<FakeOpenAiServer> {
  const calls: FakeOpenAiServer["calls"] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/v1/models/gpt-5-mini") {
        calls.push({ method, path: url.pathname });
        writeJson(response, 200, { id: "gpt-5-mini" });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(request);
        const requestBody = body as { messages?: Array<{ content?: string }> };
        const userContent = requestBody.messages?.[1]?.content ?? "{}";
        const userInput = JSON.parse(userContent) as { stage?: string };
        calls.push({ method, path: url.pathname, stage: userInput.stage });
        writeJson(response, 200, {
          choices: [
            {
              message: {
                content: JSON.stringify(fakeOpenAiStageOutput(userInput.stage, title))
              }
            }
          ],
          usage: {
            completion_tokens: 9,
            prompt_tokens: 13,
            total_tokens: 22
          }
        });
        return;
      }

      calls.push({ method, path: url.pathname });
      writeJson(response, 500, { error: { message: `Unexpected fake provider request: ${method} ${url.pathname}` } });
    } catch (error) {
      writeJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => closeServer(server)
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function fakeOpenAiStageOutput(stage: string | undefined, title: string): unknown {
  switch (stage) {
    case "brief":
      return {
        title,
        brief: "Build a provider-backed deck from the desktop wizard.",
        language: "en-US",
        audience: "reviewers",
        durationMinutes: 8
      };
    case "outline":
      return {
        title,
        language: "en-US",
        audience: "reviewers",
        durationMinutes: 8,
        slides: [{ id: "001-title", title, kind: "title", goal: "Prove provider-backed generation." }]
      };
    case "visual-direction":
      return {
        directions: [
          {
            id: "direction-e2e-provider",
            label: "Provider Proof",
            rationale: "A readable provider-backed smoke deck for release validation.",
            sampleSlideIds: ["001-title"],
            tokens: {
              accent: "#2357d9",
              background: "#ffffff",
              text: "#111827"
            }
          }
        ],
        selectedDirectionId: null
      };
    case "build":
      return {
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        notesChanged: ["001-title"],
        slidesChanged: ["001-title"],
        themeChanged: [],
        sourceWrites: byokE2eSourceWrites(title)
      };
    case "check":
      return {
        status: "passed",
        summary: { errors: 0, warnings: 0, info: 0 },
        issues: []
      };
    case "export":
      return {
        artifacts: [{ type: "pdf", path: "exports/provider-e2e.pdf" }]
      };
    case "review":
      return {
        summary: "Provider-backed desktop E2E deck is ready for review.",
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        issuesRemaining: 0,
        nextActions: ["Review deck"]
      };
    default:
      throw new Error(`Unexpected fake OpenAI stage: ${stage ?? "unknown"}`);
  }
}

function byokE2eSourceWrites(title: string): Array<{ path: string; content: string }> {
  return [
    {
      path: "deck.json",
      content: `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          id: "deck_byok_e2e",
          title,
          language: "en-US",
          aspectRatio: "16:9",
          viewport: { width: 1920, height: 1080 },
          slides: [
            {
              id: "001-title",
              title,
              source: "slides/001-title.html",
              notes: "notes/001-title.md",
              durationSec: 75,
              kind: "title",
              status: "ready"
            }
          ]
        },
        null,
        2
      )}\n`
    },
    {
      path: "slides/001-title.html",
      content: `<section class="slide" data-slide-id="001-title"><h1>${title}</h1><p>Provider-backed generation reached check and export from the desktop wizard.</p></section>\n`
    },
    {
      path: "notes/001-title.md",
      content: `# ${title}\n\nUse this talk track to confirm provider-backed generation, checkpoint review, check, and export all completed from the desktop wizard.\n`
    }
  ];
}

async function writeGenericExternalAgentScript(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    `
import fs from "node:fs";
import path from "node:path";

const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const promptFile = requireArg(args, "--prompt-file");
const manifestFile = requireArg(args, "--writes-manifest");
const slideFile = path.join(projectRoot, "slides", "001-title.html");
const prompt = fs.readFileSync(promptFile, "utf8");

if (!prompt.includes("Generic command")) {
  throw new Error("Prompt did not include the E2E Generic command brief.");
}

fs.writeFileSync(
  slideFile,
  '<section class="slide title-slide" data-slide-id="001-title"><p class="eyebrow">Generic external agent</p><h1>Edited by Generic E2E</h1><p class="subtitle">The configured command wrote this source slide, then HTMLslide checked and exported it.</p></section>\\n'
);
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["slides/001-title.html"] }, null, 2) + "\\n");
console.log("generic external agent wrote slides/001-title.html");
console.error("generic external agent manifest recorded");

function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}

function requireArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error("Missing " + name);
  }
  return value;
}
`,
    "utf8"
  );
}

async function writeReadyCodexCli(commandPath: string): Promise<void> {
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex 9.9.9");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("authenticated");
  process.exit(0);
}
console.error("unexpected codex e2e invocation: " + args.join(" "));
process.exit(1);
`,
    "utf8"
  );
  await chmod(commandPath, 0o755);
}

test.describe("HTMLslide desktop smoke", () => {
  let electronApp: ElectronApplication | undefined;
  let tempRoot: string | undefined;

  test.afterEach(async () => {
    if (electronApp) {
      await electronApp.close().catch(() => undefined);
      electronApp = undefined;
    }

    if (tempRoot) {
      await rm(tempRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      tempRoot = undefined;
    }
  });

  test("creates a new deck from the project library", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Welcome to HTMLslide" })).toBeVisible();
    const setupProgress = page.getByRole("list", { name: "Setup progress" });
    await expect(setupProgress.getByRole("listitem", { name: "Welcome to HTMLslide, current step" })).toHaveAttribute("aria-current", "step");
    await expect(setupProgress.getByRole("button")).toHaveCount(0);
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const libraryNav = page.getByRole("navigation", { name: "Project library" });
    const recentNav = libraryNav.getByRole("button", { name: "Recent", exact: true });
    const templatesNav = libraryNav.getByRole("button", { name: "Templates", exact: true });
    await expect(recentNav).toHaveAttribute("aria-current", "page");
    await templatesNav.click();
    await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
    await expect(templatesNav).toHaveAttribute("aria-current", "page");
    await expect(recentNav).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Two-slide local-first project")).toBeVisible();
    await recentNav.click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(recentNav).toHaveAttribute("aria-current", "page");
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();

    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    const templateSelect = newDeckPanel.getByLabel("Template");
    await expect(templateSelect).toHaveValue("default");
    await expect(templateSelect.locator("option")).toHaveText([
      "Default",
      "Swiss Editorial",
      "Consulting Clean",
      "Technical Dark",
      "Product Launch",
      "Data Report"
    ]);
    await expect(newDeckPanel.getByRole("button", { name: /No AI/ })).toHaveAttribute("aria-pressed", "true");
    await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
    const generationBlockedAlert = newDeckPanel.getByRole("alert");
    await expect(generationBlockedAlert).toHaveText("Save a provider API key in AI Engines before using HTMLslide Agent.");
    const createAndGenerateButton = newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true });
    await expect(createAndGenerateButton).toBeDisabled();
    const blockedAlertId = await generationBlockedAlert.getAttribute("id");
    expect(blockedAlertId).toBeTruthy();
    await expect(createAndGenerateButton).toHaveAttribute("aria-describedby", blockedAlertId ?? "");
    await newDeckPanel.getByRole("button", { name: /No AI/ }).click();
    await newDeckPanel.getByLabel("Deck title").fill("Investor Update");
    await expect(newDeckPanel.getByLabel("Folder")).toHaveValue("investor-update");
    await newDeckPanel.getByRole("button", { name: "Create Deck", exact: true }).click();

    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Investor Update" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("heading", { name: "Slides" })).toBeVisible();
    await expect(page.getByLabel(/slide preview/).first()).toBeVisible();

    const manifest = JSON.parse(await readFile(path.join(workspaceDir, "investor-update", "deck.json"), "utf8")) as {
      title?: string;
    };
    expect(manifest.title).toBe("Investor Update");
    await expectNoFrameworkOverlay(page);
  });

  test("saves fake API key metadata from AI Engines settings", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const fakeApiKey = "sk-e2e-fake-provider-key";
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_CREDENTIAL_STORE: "memory",
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await expect(page.getByRole("heading", { name: "API Key Metadata", exact: true })).toBeVisible();
    await expect(page.getByText("No provider key saved")).toBeVisible();
    const externalAgentList = page.locator(".external-agent-list");
    await expect(externalAgentList.getByRole("button", { name: /Claude Code/ })).toBeVisible();
    await expect(externalAgentList.getByRole("button", { name: /Codex CLI/ })).toBeVisible();
    await expect(externalAgentList.getByRole("button", { name: /Gemini CLI/ })).toBeVisible();
    await expect(externalAgentList.getByRole("button", { name: /Generic command/ })).toBeVisible();
    await page.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await page.getByLabel("API key").fill(fakeApiKey);
    await page.getByRole("button", { name: "Save Key", exact: true }).click();
    await expect(page.getByRole("status", { name: "AI engine operation status" })).toContainText("OpenAI key saved", { timeout: 30_000 });

    const savedSettingsText = await readFile(path.join(userDataDir, "ai-engine-settings.json"), "utf8");
    expect(savedSettingsText).toContain('"provider": "openai"');
    expect(savedSettingsText).toContain('"hasKey": true');
    expect(savedSettingsText).not.toContain(fakeApiKey);

    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await expect(newDeckPanel.getByText("Key ready")).toBeVisible();
    await expect(newDeckPanel.getByText("Save a provider API key in AI Engines before using HTMLslide Agent.")).toHaveCount(0);
    await expectNoFrameworkOverlay(page);
  });

  test("chooses a workspace before creating a deck", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const initialWorkspaceDir = path.join(tempRoot, "workspace-initial");
    const nextWorkspaceDir = path.join(tempRoot, "workspace-next");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(initialWorkspaceDir, { recursive: true });
    await mkdir(nextWorkspaceDir, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: initialWorkspaceDir,
        HTMLSLIDE_E2E_CHOOSE_WORKSPACE_PATH: nextWorkspaceDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByText(`Workspace: ${initialWorkspaceDir}`)).toBeVisible();

    await page.getByRole("button", { name: "Change Workspace", exact: true }).click();
    await expect(page.getByText(`Workspace: ${nextWorkspaceDir}`)).toBeVisible();
    const library = JSON.parse(await readFile(path.join(userDataDir, "library.json"), "utf8")) as {
      defaultWorkspace?: string;
    };
    expect(library.defaultWorkspace).toBe(nextWorkspaceDir);

    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await expect(newDeckPanel.locator(".new-deck-panel__title span")).toHaveText(nextWorkspaceDir);
    await newDeckPanel.getByLabel("Deck title").fill("Workspace Switch Deck");
    await expect(newDeckPanel.getByLabel("Folder")).toHaveValue("workspace-switch-deck");
    await newDeckPanel.getByRole("button", { name: "Create Deck", exact: true }).click();

    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Workspace Switch Deck" })).toBeVisible({
      timeout: 30_000
    });
    await expect(access(path.join(nextWorkspaceDir, "workspace-switch-deck", "deck.json"))).resolves.toBeUndefined();
    await expect(access(path.join(initialWorkspaceDir, "workspace-switch-deck", "deck.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expectNoFrameworkOverlay(page);
  });

  test("manages recent project entries from the project library", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const validProjectPath = path.join(workspaceDir, "recent-valid");
    const missingProjectPath = path.join(workspaceDir, "recent-missing");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, validProjectPath, { recursive: true });
    await cp(sampleProjectPath, missingProjectPath, { recursive: true });
    await rm(path.join(missingProjectPath, "slides", "002-structure.html"), { force: true });
    await writeFile(
      path.join(userDataDir, "library.json"),
      `${JSON.stringify({
        defaultWorkspace: workspaceDir,
        recentProjects: [
          {
            id: "proj_recent_valid",
            lastOpenedAt: "2026-07-08T00:00:00.000Z",
            path: validProjectPath,
            slideCount: 2,
            status: "Ready",
            title: "Recent Valid Deck"
          },
          {
            id: "proj_recent_missing",
            lastOpenedAt: "2026-07-08T00:00:00.000Z",
            path: missingProjectPath,
            slideCount: 2,
            status: "Needs check",
            title: "Recent Missing Deck"
          }
        ],
        version: 1
      }, null, 2)}\n`
    );

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    const validCard = page.locator("article.project-card").filter({ hasText: "Recent Valid Deck" });
    await expect(validCard).toBeVisible();
    await validCard.getByRole("button", { name: "Remove Recent Valid Deck", exact: true }).click();
    await expect(validCard).toHaveCount(0);
    expect(await readFile(path.join(validProjectPath, "deck.json"), "utf8")).toContain("Valid Full Deck");

    const missingCard = page.locator("article.project-card").filter({ hasText: "Recent Missing Deck" });
    await expect(missingCard).toBeVisible();
    await missingCard.getByRole("button", { name: "Open Recent Missing Deck", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.locator("article.project-card").filter({ hasText: "Missing files" })).toBeVisible();
    await expectNoFrameworkOverlay(page);
  });

  test("creates and generates a deck from the new deck wizard", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();

    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await newDeckPanel.getByLabel("Deck title").fill("Investor Demo");
    await newDeckPanel.getByLabel("Brief").fill("Create an investor update about Q3 growth, retention, and expansion risks.");
    await expect(newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ })).toBeVisible();
    await expect(newDeckPanel.getByRole("button", { name: /Coding Agent/ })).toBeVisible();
    await newDeckPanel.getByRole("button", { name: /Local Mock/ }).click();
    await newDeckPanel.getByLabel("Language").selectOption("en-US");
    await newDeckPanel.getByLabel("Audience").selectOption("investors");
    await newDeckPanel.getByLabel("Duration").selectOption("20");
    await newDeckPanel.getByLabel("Slides").selectOption("8");
    await newDeckPanel.getByLabel("Tone").selectOption("executive");
    await newDeckPanel.getByLabel("Design").selectOption("consulting-clean");
    await newDeckPanel.getByLabel("Speaker notes").selectOption("full-script");
    await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();

    await expect(page.getByText("Mock agent completed check and export")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Mock HTMLslide Deck" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reviewable outputs/ })).toBeVisible();
    const commandStatuses = page.getByRole("status", { name: "Agent command statuses" });
    await expect(commandStatuses).toContainText("generate");
    await expect(commandStatuses).toContainText("Mock generation complete");
    await expect(commandStatuses).toContainText("review");
    await expect(commandStatuses).toContainText("Ready for review");
    await expect(page.getByText("generate: Mock generation complete")).toBeVisible();
    await expect(page.getByText(/check: Check passed/)).toBeVisible();
    await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();

    const projectDir = path.join(workspaceDir, "investor-demo");
    const manifest = JSON.parse(await readFile(path.join(projectDir, "deck.json"), "utf8")) as {
      agent?: { lastRunId?: string };
      slides?: unknown[];
      title?: string;
    };
    expect(manifest.title).toBe("Mock HTMLslide Deck");
    expect(manifest.agent?.lastRunId).toMatch(/^run-/);
    expect(manifest.slides).toHaveLength(3);
    const agentReportText = await readFile(
      path.join(projectDir, ".htmlslide", "reports", "latest-agent-run.json"),
      "utf8"
    );
    const agentReport = JSON.parse(agentReportText) as {
      applied?: { slideIds?: string[] };
      outputs?: {
        build?: { slidesChanged?: string[] };
        outline?: { slides?: unknown[] };
        visualDirection?: { directions?: Array<{ id?: string }> };
      };
      providerId?: string;
      runId?: string;
    };
    expect(agentReport.providerId).toBe("htmlslide-mock");
    expect(agentReport.runId).toBe(manifest.agent?.lastRunId);
    expect(agentReport.outputs?.outline?.slides).toHaveLength(3);
    expect(agentReport.outputs?.visualDirection?.directions?.map((direction) => direction.id)).toEqual([
      "direction-editorial",
      "direction-systems"
    ]);
    expect(agentReport.outputs?.build?.slidesChanged).toEqual(["001-title", "002-workflow", "003-review"]);
    expect(agentReport.applied?.slideIds).toEqual(["001-title", "002-workflow", "003-review"]);
    expect(agentReportText).not.toContain('"content":');
    await expect(readFile(path.join(projectDir, "notes", "001-title.md"), "utf8")).resolves.toContain(
      "Deck title: Investor Demo"
    );
    await expectNoFrameworkOverlay(page);
  });

  test("generates a new deck through HTMLslide Agent with a local OpenAI-compatible provider", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const fakeProviderTitle = "BYOK Provider E2E Deck";
    const fakeApiKey = "sk-e2e-compatible-provider-key";
    const fakeProvider = await startFakeOpenAiCompatibleServer(fakeProviderTitle);
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    try {
      electronApp = await electron.launch({
        executablePath: electronExecutable,
        args: [electronMain],
        env: {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
          HOME: homeDir,
          HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
          HTMLSLIDE_E2E_CREDENTIAL_STORE: "memory",
          HTMLSLIDE_USER_DATA_DIR: userDataDir
        }
      });

      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "AI Engines", exact: true }).click();
      await page.getByRole("button", { name: /HTMLslide Agent/ }).click();
      await page.getByLabel("Provider").selectOption("compatible");
      await page.getByLabel("Model").fill("gpt-5-mini");
      await page.getByLabel("Base URL").fill(fakeProvider.baseUrl);
      await page.getByLabel("API key").fill(fakeApiKey);
      await page.getByRole("button", { name: "Save Key", exact: true }).click();
      await expect(page.getByRole("status", { name: "AI engine operation status" })).toContainText("OpenAI-compatible key saved", {
        timeout: 30_000
      });

      await page.getByRole("button", { name: "Recent", exact: true }).click();
      await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
      const newDeckPanel = page.locator(".new-deck-panel");
      await expect(newDeckPanel).toBeVisible();
      await newDeckPanel.getByLabel("Deck title").fill("Provider Demo");
      await newDeckPanel.getByLabel("Brief").fill("Create a provider-backed smoke deck with one title slide.");
      await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
      await expect(newDeckPanel.getByText("Key ready")).toBeVisible();
      await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();

      await expect(page.getByText("HTMLslide Agent completed check and export")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: fakeProviderTitle })).toBeVisible();
      await expect(page.getByText("generate: HTMLslide Agent complete")).toBeVisible();
      await expect(page.getByText(/check: Check passed/)).toBeVisible();
      await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
      await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();

      const stages = fakeProvider.calls.map((call) => call.stage).filter(Boolean);
      expect(fakeProvider.calls).toContainEqual({ method: "GET", path: "/v1/models/gpt-5-mini" });
      expect(stages).toEqual(["brief", "outline", "visual-direction", "build", "check", "export", "review"]);

      const projectDir = path.join(workspaceDir, "provider-demo");
      const settingsText = await readFile(path.join(userDataDir, "ai-engine-settings.json"), "utf8");
      expect(settingsText).toContain('"provider": "compatible"');
      expect(settingsText).toContain(fakeProvider.baseUrl);
      expect(settingsText).not.toContain(fakeApiKey);

      const manifestText = await readFile(path.join(projectDir, "deck.json"), "utf8");
      const manifest = JSON.parse(manifestText) as {
        slides?: unknown[];
        title?: string;
      };
      expect(manifest.title).toBe(fakeProviderTitle);
      expect(manifest.slides).toHaveLength(1);
      const slideText = await readFile(path.join(projectDir, "slides", "001-title.html"), "utf8");
      const notesText = await readFile(path.join(projectDir, "notes", "001-title.md"), "utf8");
      expect(slideText).toContain(fakeProviderTitle);
      expect(notesText).toContain("provider-backed generation");
      await expect(access(path.join(projectDir, "exports", "byok-provider-e2e-deck.pdf"))).resolves.toBeUndefined();
      await expect(access(path.join(projectDir, "exports", "byok-provider-e2e-deck.deckpkg"))).resolves.toBeUndefined();

      const agentReportText = await readFile(
        path.join(projectDir, ".htmlslide", "reports", "latest-agent-run.json"),
        "utf8"
      );
      const agentReport = JSON.parse(agentReportText) as {
        applied?: { filesChanged?: string[]; source?: string; writeCount?: number };
        outputs?: {
          build?: { sourceWriteCount?: number; sourceWritePaths?: string[] };
          outline?: { slides?: unknown[] };
          visualDirection?: { directions?: Array<{ id?: string }> };
        };
        providerId?: string;
        runId?: string;
        status?: string;
      };
      expect(agentReport).toMatchObject({
        providerId: "htmlslide-byok",
        status: "succeeded"
      });
      expect(agentReport.runId).toMatch(/^run-/);
      expect(agentReport.outputs?.outline?.slides).toHaveLength(1);
      expect(agentReport.outputs?.visualDirection?.directions?.map((direction) => direction.id)).toEqual([
        "direction-e2e-provider"
      ]);
      expect(agentReport.outputs?.build).toMatchObject({
        sourceWriteCount: 3,
        sourceWritePaths: ["deck.json", "slides/001-title.html", "notes/001-title.md"]
      });
      expect(agentReport.applied).toMatchObject({
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        source: "provider-source-writes",
        writeCount: 3
      });
      expect(agentReportText).not.toContain('"content":');
      for (const text of [settingsText, manifestText, slideText, notesText, agentReportText]) {
        expect(text).not.toContain(fakeApiKey);
      }
      await expectNoFrameworkOverlay(page);
    } finally {
      await fakeProvider.close();
    }
  });

  test("runs a configured Generic command external agent from the new deck wizard", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(workspaceDir, "generic-agent-demo");
    const fakeAgentScript = path.join(tempRoot, "fake-generic-agent.mjs");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeGenericExternalAgentScript(fakeAgentScript);
    const commandTemplate = `"${process.execPath}" "${fakeAgentScript}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await expect(page.getByRole("heading", { name: "AI Engines", exact: true })).toBeVisible();
    await page.locator(".ai-settings__modes").getByRole("button", { name: /Coding Agent/ }).click();
    await page.locator(".external-agent-list").getByRole("button", { name: /Generic command/ }).click();
    const connectionGuide = page.getByRole("region", { name: "External agent connection guide" });
    await expect(connectionGuide).toContainText("Command template required");
    await expect(connectionGuide).toContainText("{{writeManifest}}");
    await page.getByLabel("Generic command").fill(commandTemplate);
    await page.getByRole("button", { name: "Save Selection", exact: true }).click();
    await expect(connectionGuide).toContainText("Ready for HTMLslide runs");
    await expect(connectionGuide).toContainText("HTMLslide run");
    await expect(connectionGuide).toContainText("Diff review");

    const settingsPath = path.join(userDataDir, "ai-engine-settings.json");
    await expect.poll(async () => readFile(settingsPath, "utf8").catch(() => ""), { timeout: 30_000 })
      .toContain("fake-generic-agent.mjs");
    const savedSettingsText = await readFile(settingsPath, "utf8");
    expect(savedSettingsText).toContain('"mode": "external-agent"');
    expect(savedSettingsText).toContain('"selectedId": "generic"');
    expect(savedSettingsText).toContain("fake-generic-agent.mjs");

    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await newDeckPanel.getByLabel("Deck title").fill("Generic Agent Demo");
    await expect(newDeckPanel.getByLabel("Folder")).toHaveValue("generic-agent-demo");
    await newDeckPanel.getByLabel("Brief").fill("Use the configured Generic command to update the title slide.");
    await newDeckPanel.getByRole("button", { name: /Coding Agent/ }).click();
    await expect(newDeckPanel.getByText("Generic command is ready for New Deck and existing workspace runs.")).toBeVisible();
    await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();

    await expect(page.getByText("External agent completed check and export")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Generic Agent Demo" })).toBeVisible();
    await expect(page.getByText("generate: External agent complete")).toBeVisible();
    await expect(page.getByText(/check: Check passed/)).toBeVisible();
    await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
    await expect(page.getByText("review: Ready for review")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();

    const diffReview = page.locator(".agent-diff-review");
    await expect(diffReview.getByText("Files changed")).toBeVisible();
    await expect(diffReview.locator(".agent-diff-file-list").filter({ hasText: "Files changed" }).getByText("slides/001-title.html")).toBeVisible();
    await expect(diffReview.locator(".agent-text-diff__title").getByText("slides/001-title.html")).toBeVisible();
    const buildStage = page.locator(".agent-stage").filter({ hasText: "External agent reported 1 source file writes." });
    await buildStage.getByText("Logs").click();
    await expect(buildStage.getByText("generic external agent wrote slides/001-title.html")).toBeVisible();
    await expect(buildStage.getByText("generic external agent manifest recorded")).toBeVisible();

    const editedSlide = await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8");
    expect(editedSlide).toContain("Edited by Generic E2E");
    const runDirs = await readdir(path.join(projectPath, ".htmlslide", "runs"));
    expect(runDirs).toHaveLength(1);
    const prompt = await readFile(path.join(projectPath, ".htmlslide", "runs", runDirs[0]!, "prompt.md"), "utf8");
    expect(prompt).toContain("Use the configured Generic command to update the title slide.");
    const writeManifest = JSON.parse(
      await readFile(path.join(projectPath, ".htmlslide", "runs", runDirs[0]!, "writes.json"), "utf8")
    ) as { writes?: string[] };
    expect(writeManifest.writes).toEqual(["slides/001-title.html"]);
    await expect(access(path.join(projectPath, "exports", "generic-agent-demo.pdf"))).resolves.toBeUndefined();
    await expect(access(path.join(projectPath, "exports", "generic-agent-demo.deckpkg"))).resolves.toBeUndefined();

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "Revert changes", exact: true }).click();
    await expect(page.getByText("Checkpoint reverted")).toBeVisible({ timeout: 30_000 });
    const revertedSlide = await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8");
    expect(revertedSlide).toContain("Generic Agent Demo");
    expect(revertedSlide).not.toContain("Edited by Generic E2E");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("keeps detected Codex CLI scoped to manual validation in the new deck wizard", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeReadyCodexCli(path.join(binDir, "codex"));

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await expect(page.getByRole("heading", { name: "AI Engines", exact: true })).toBeVisible();
    await page.locator(".ai-settings__modes").getByRole("button", { name: /Coding Agent/ }).click();
    const codexAgentButton = page.locator(".external-agent-list").getByRole("button", { name: /Codex CLI/ });
    await page.getByRole("button", { name: "Refresh Status", exact: true }).click();
    await expect(codexAgentButton).toContainText("ready", { timeout: 30_000 });
    await codexAgentButton.click();
    const connectionGuide = page.getByRole("region", { name: "External agent connection guide" });
    await expect(connectionGuide).toContainText("Detected for manual validation");
    await expect(connectionGuide).toContainText("direct headless deck editing is not enabled");

    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await newDeckPanel.getByLabel("Deck title").fill("Codex Manual Validation Demo");
    await newDeckPanel.getByLabel("Brief").fill("This should not run through Codex until a tested template exists.");
    await newDeckPanel.getByRole("button", { name: /Coding Agent/ }).click();
    await expect(newDeckPanel.getByText("Codex CLI is detected for manual validation.")).toBeVisible();
    await expect(newDeckPanel.getByRole("alert")).toHaveText(
      "Configure a ready Generic command in AI Engines before using Coding Agent generation."
    );
    await expect(newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true })).toBeDisabled();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("loads the Electron shell, reaches the library, and opens a sample deck", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Welcome to HTMLslide" })).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const openFolderButton = page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first();
    await expect(openFolderButton).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await openFolderButton.click();

    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("heading", { name: "Slides" })).toBeVisible();
    await expect(page.getByLabel("HTML as source slide preview")).toBeVisible();
    await expect(page.getByText("PDF and deckpkg remain deterministic artifacts.")).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await page.getByRole("button", { name: "Generate", exact: true }).click();

    await expect(page.getByText("Mock agent completed check and export")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Mock HTMLslide Deck" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reviewable outputs/ })).toBeVisible();
    await expect(page.getByText("generate: Mock generation complete")).toBeVisible();
    await expect(page.getByText(/check: Check passed/)).toBeVisible();
    await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
    await expect(page.getByText("review: Ready for review")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();
    const diffReview = page.locator(".agent-diff-review");
    await expect(diffReview.getByText("Files changed")).toBeVisible();
    await expect(diffReview.getByText("Slides changed")).toBeVisible();
    await expect(diffReview.getByText("Text/CSS diff")).toBeVisible();
    await expect(
      diffReview.locator(".agent-diff-file-list").filter({ hasText: "Files changed" }).getByText("slides/003-review.html")
    ).toBeVisible();
    await expect(diffReview.locator(".agent-text-diff__title").getByText("slides/003-review.html")).toBeVisible();

    await diffReview.getByRole("button", { name: "Close diff review", exact: true }).click();
    await expect(diffReview).toBeHidden();
    const viewDiffButton = page.locator(".command-bar__controls").getByRole("button", { name: "View diff", exact: true });
    await expect(viewDiffButton).toHaveAttribute("aria-pressed", "false");
    await viewDiffButton.click();
    await expect(viewDiffButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "Revert changes", exact: true }).click();
    await expect(page.getByText("Checkpoint reverted")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();
    await expect(page.getByLabel("HTML as source slide preview")).toBeVisible();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("checks, exports, and presents an opened deck", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("button", { name: "Sort slides", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Fit preview", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Open logs", exact: true })).toBeDisabled();

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText(/check: Check passed/)).toBeVisible({ timeout: 30_000 });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("status", { name: "Workspace status" })).toContainText("export: Export complete", { timeout: 30_000 });
    await expect(page.getByRole("status", { name: "Export operation status" })).toContainText("Export complete");
    const deckpkgPath = path.join(projectPath, "exports", "valid-full-deck.deckpkg");
    const pdfPath = path.join(projectPath, "exports", "valid-full-deck.pdf");
    const htmlPath = path.join(projectPath, "exports", "valid-full-deck.html");
    const notesPath = path.join(projectPath, "exports", "notes.json");
    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as {
      slides: Array<{ id: string }>;
    };
    const expectedSlideCount = deck.slides.length;
    await expect(access(pdfPath)).resolves.toBeUndefined();
    await expect(access(htmlPath)).resolves.toBeUndefined();
    await expect(access(deckpkgPath)).resolves.toBeUndefined();
    await expect(access(notesPath)).resolves.toBeUndefined();
    expect(await readPdfPageCount(pdfPath)).toBe(expectedSlideCount);
    const exportedPackage = await readDeckPackage(deckpkgPath);
    expect(exportedPackage.manifest.slideCount).toBe(expectedSlideCount);
    expect(exportedPackage.manifest.pageCount).toBe(expectedSlideCount);
    expect(exportedPackage.manifest.slides.map((slide) => slide.id)).toEqual(deck.slides.map((slide) => slide.id));
    expect(exportedPackage.slides).toHaveLength(expectedSlideCount);
    for (const slide of deck.slides) {
      const thumbnailPath = path.join(projectPath, "exports", "thumbnails", `${slide.id}.png`);
      await expect(access(thumbnailPath)).resolves.toBeUndefined();
      expect(readPngSize(await readFile(thumbnailPath))).toEqual({ width: 960, height: 540 });
    }
    await rm(deckpkgPath, { force: true });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Present", exact: true }).click();
    await expect.poll(
      async () => access(deckpkgPath).then(() => true).catch(() => false),
      { timeout: 30_000 }
    ).toBe(true);

    const presenter = page.getByLabel("Presenter rehearsal mode");
    const currentSlideHeading = presenter.locator(".presenter-current .hs-panel-header h2");
    const currentSlideFrame = presenter.frameLocator(".presenter-current .presenter-slide-preview__frame");
    const screenCover = presenter.locator(".presenter-screen-cover");
    const presenterNotes = presenter.locator(".presenter-notes");
    await expect(presenter).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.locator(".presenter-current .presenter-slide-preview__frame")).toBeVisible();
    await expect(currentSlideFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(presenter.getByRole("heading", { name: "Speaker Notes" })).toBeVisible();
    await expect(presenter.getByLabel("Presenter target display")).toBeVisible();
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    const audienceWindowPromise = electronApp.waitForEvent("window");
    await presenter.getByRole("button", { name: "Open audience", exact: true }).click();
    const audiencePage = await audienceWindowPromise;
    await audiencePage.waitForLoadState("domcontentloaded");
    const audienceFrame = audiencePage.frameLocator(".audience-slide-frame");
    await expect(audiencePage.getByLabel("HTMLslide audience window")).toBeVisible();
    await expect(audiencePage.locator(".audience-slide-frame")).toBeVisible();
    await expect(audienceFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(audiencePage.getByText("1 / 2")).toBeVisible();
    await page.bringToFront();

    await page.keyboard.press("ArrowRight");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");
    await expect(currentSlideFrame.getByRole("heading", { name: "Project structure" })).toBeVisible();
    await expect(presenter.getByText("Project folders stay readable")).toBeVisible();
    await expect(audienceFrame.getByRole("heading", { name: "Project structure" })).toBeVisible();
    await expect(audiencePage.getByText("2 / 2")).toBeVisible();

    await page.keyboard.press("ArrowLeft");
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(currentSlideFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(audienceFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();

    await page.keyboard.press("T");
    await expect(presenter.getByText("paused")).toBeVisible();
    await page.keyboard.press("T");
    await expect(presenter.getByText("running")).toBeVisible();

    await page.keyboard.press("Space");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");

    await presenter.getByLabel("Jump to slide").selectOption("0");
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");

    const initialNotesFontSize = await presenterNotes.evaluate((element) => window.getComputedStyle(element).fontSize);
    await page.keyboard.press("+");
    await expect.poll(
      async () => presenterNotes.evaluate((element) => window.getComputedStyle(element).fontSize)
    ).not.toBe(initialNotesFontSize);
    await page.keyboard.press("-");
    await expect(presenterNotes).toHaveCSS("font-size", initialNotesFontSize);

    await page.keyboard.press("B");
    await expect(screenCover).toHaveText("Black screen");
    await expect(audiencePage.getByText("Black screen")).toBeVisible();
    await page.keyboard.press("B");
    await expect(screenCover).toBeHidden();

    await page.keyboard.press("W");
    await expect(screenCover).toHaveText("White screen");
    await expect(audiencePage.getByText("White screen")).toBeVisible();
    await page.keyboard.press("W");
    await expect(screenCover).toBeHidden();

    await expect(presenter.getByLabel("Jump to slide")).toBeVisible();

    const audienceClosePromise = audiencePage.waitForEvent("close");
    await presenter.getByRole("button", { name: "Close audience", exact: true }).click();
    await audienceClosePromise;

    await presenter.locator(".presenter-current").click();
    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("opens single-screen rehearsal presenter when deckpkg is unavailable", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_FORCE_REHEARSAL_PRESENTER: "1",
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath,
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Present", exact: true }).click();
    const presenter = page.getByLabel("Presenter rehearsal mode");
    const currentSlideHeading = presenter.locator(".presenter-current .hs-panel-header h2");
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(presenter.getByText("Windowed Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();
    await expect(presenter.getByLabel("Presenter progress")).toBeVisible();

    await presenter.getByRole("button", { name: "Next slide", exact: true }).click();
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");
    await expect(presenter.locator(".presenter-notes").getByText("Project folders stay readable")).toBeVisible();

    await presenter.getByRole("button", { name: "Previous slide", exact: true }).click();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");

    const pauseTimerButton = presenter.getByRole("button", { name: "Pause timer", exact: true });
    await expect(pauseTimerButton).toHaveAttribute("aria-pressed", "false");
    await pauseTimerButton.click();
    await expect(presenter.getByText("paused")).toBeVisible();
    const resumeTimerButton = presenter.getByRole("button", { name: "Resume timer", exact: true });
    await expect(resumeTimerButton).toHaveAttribute("aria-pressed", "true");
    await resumeTimerButton.click();
    await expect(presenter.getByText("running")).toBeVisible();

    await presenter.locator(".presenter-current").click();
    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("opens a standalone deck package into presenter mode on launch", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    const deckpkgPath = await exportDeckPackage(projectPath);
    await expect(access(deckpkgPath)).resolves.toBeUndefined();

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain, deckpkgPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    const presenter = page.getByLabel("Presenter rehearsal mode");
    const currentSlideHeading = presenter.locator(".presenter-current .hs-panel-header h2");
    const currentSlideFrame = presenter.frameLocator(".presenter-current .presenter-slide-preview__frame");
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.locator(".presenter-current .presenter-slide-preview__frame")).toBeVisible();
    await expect(currentSlideFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(presenter.getByRole("heading", { name: "Speaker Notes" })).toBeVisible();
    await expect(presenter.getByLabel("Presenter target display")).toBeVisible();
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    const audiencePromise = electronApp.waitForEvent("window");
    await presenter.getByRole("button", { name: "Open audience", exact: true }).click();
    const audiencePage = await audiencePromise;
    await audiencePage.waitForLoadState("domcontentloaded");
    const audienceFrame = audiencePage.frameLocator(".audience-slide-frame");
    await expect(audiencePage.locator(".audience-slide-frame")).toBeVisible();
    await expect(audienceFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(audiencePage.locator(".audience-meta")).toHaveText("1 / 2");
    await page.bringToFront();

    await page.keyboard.press("ArrowRight");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");
    await expect(currentSlideFrame.getByRole("heading", { name: "Project structure" })).toBeVisible();
    await expect(audienceFrame.getByRole("heading", { name: "Project structure" })).toBeVisible();
    await expect(audiencePage.locator(".audience-meta")).toHaveText("2 / 2");

    await audiencePage.close();

    await presenter.locator(".presenter-current").click();
    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("handles a macOS open-file event for a standalone deck package", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    const deckpkgPath = await exportDeckPackage(projectPath);
    await expect(access(deckpkgPath)).resolves.toBeUndefined();

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Welcome to HTMLslide" })).toBeVisible();
    await electronApp.evaluate(
      ({ app }, filePath: string) => {
        app.emit("open-file", { preventDefault: () => undefined }, filePath);
      },
      deckpkgPath
    );

    const presenter = page.getByLabel("Presenter rehearsal mode");
    const currentSlideHeading = presenter.locator(".presenter-current .hs-panel-header h2");
    const currentSlideFrame = presenter.frameLocator(".presenter-current .presenter-slide-preview__frame");
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.locator(".presenter-current .presenter-slide-preview__frame")).toBeVisible();
    await expect(currentSlideFrame.getByRole("heading", { name: "HTML as source" })).toBeVisible();
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("opens a deck project from an explicit launch argument and records it as recent", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain, "--project", projectPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByLabel("Presenter rehearsal mode")).toBeHidden();

    const library = JSON.parse(await readFile(path.join(userDataDir, "library.json"), "utf8")) as {
      recentProjects: Array<{ path: string }>;
    };
    expect(library.recentProjects[0]?.path).toBe(projectPath);
    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("ignores an invalid project argument and accepts a later second-instance project request", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const invalidProjectPath = path.join(tempRoot, "not-a-deck");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(invalidProjectPath, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain, "--project", invalidProjectPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir
      }
    });

    await electronApp.evaluate(
      ({ app }, request: { mainEntry: string; projectPath: string; workingDirectory: string }) => {
        const emit = app.emit.bind(app) as (...args: unknown[]) => boolean;
        emit(
          "second-instance",
          {},
          [process.execPath, request.mainEntry, "--project", request.projectPath],
          request.workingDirectory,
          {}
        );
      },
      { mainEntry: electronMain, projectPath, workingDirectory: tempRoot }
    );

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });
    const library = JSON.parse(await readFile(path.join(userDataDir, "library.json"), "utf8")) as {
      recentProjects: Array<{ path: string }>;
    };
    expect(library.recentProjects[0]?.path).toBe(projectPath);
    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("shows failing check issues in the QA panel", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "linter-text-overflow");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(textOverflowProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Linter Text Overflow" })).toBeVisible({
      timeout: 30_000
    });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText(/check: Check found issues/)).toBeVisible({ timeout: 30_000 });

    const qaPanel = page.getByRole("region", { name: "QA Panel" });
    await expect(qaPanel.getByRole("heading", { name: "QA Panel" })).toBeVisible();
    const qaResultSummary = qaPanel.getByRole("status", { name: "QA result summary" });
    await expect(qaResultSummary).toContainText("QA Panel shows 1 all severities issue");
    const qaSeverityTabs = qaPanel.getByRole("tablist", { name: "QA severity filter" });
    await expect(qaSeverityTabs.getByRole("tab", { name: /All\s+1/ })).toHaveAttribute("aria-selected", "true");
    await expect(qaSeverityTabs.getByRole("tab", { name: /Errors\s+1/ })).toBeVisible();
    await expect(qaSeverityTabs.getByRole("tab", { name: /Warnings\s+0/ })).toBeVisible();
    const qaIssueList = qaPanel.getByRole("list", { name: "QA issues" });
    const overflowIssue = qaIssueList.getByRole("listitem", { name: "text-overflow" });
    await expect(overflowIssue).toBeVisible();
    await expect(overflowIssue.getByRole("heading", { name: "text-overflow" })).toBeVisible();
    await expect(overflowIssue.getByText("Text is estimated to exceed its fixed container")).toBeVisible();
    await expect(overflowIssue.getByText("p.body-copy")).toBeVisible();
    await expect(overflowIssue.getByText(/overflowBottomPx/)).toBeVisible();
    await expect(overflowIssue.getByRole("button", { name: "Fix text-overflow with AI" })).toBeVisible();
    await expect(overflowIssue.getByRole("button", { name: "Ignore text-overflow once" })).toBeVisible();

    await qaSeverityTabs.getByRole("tab", { name: /Warnings\s+0/ }).click();
    await expect(qaSeverityTabs.getByRole("tab", { name: /All\s+1/ })).toBeVisible();
    await expect(qaSeverityTabs.getByRole("tab", { name: /Warnings\s+0/ })).toHaveAttribute("aria-selected", "true");
    await expect(qaResultSummary).toContainText("QA Panel shows no warning issues.");
    await expect(qaPanel.getByRole("list", { name: "QA issues" })).toHaveCount(0);
    await expect(qaPanel.getByText("No issues in this filter")).toBeVisible();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("shows missing asset and missing notes check issues in the QA panel", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "linter-intentional-failures");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(intentionalFailuresProjectPath, projectPath, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Linter Intentional Failures" })).toBeVisible({
      timeout: 30_000
    });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText(/check: Check found issues/)).toBeVisible({ timeout: 30_000 });

    const qaPanel = page.getByRole("region", { name: "QA Panel" });
    await expect(qaPanel.getByRole("heading", { name: "QA Panel" })).toBeVisible();
    await expect(qaPanel.getByRole("status", { name: "QA result summary" })).toContainText("QA Panel shows");
    const qaIssueList = qaPanel.getByRole("list", { name: "QA issues" });
    const missingAssetIssue = qaIssueList.getByRole("listitem", { name: "missing-asset" });
    await expect(missingAssetIssue).toBeVisible();
    await expect(missingAssetIssue.getByRole("heading", { name: "missing-asset" })).toBeVisible();
    await expect(missingAssetIssue.getByText("Referenced asset is missing: ../assets/missing-chart.png.")).toBeVisible();
    await expect(missingAssetIssue.getByText("img[src]").first()).toBeVisible();

    await page.getByRole("button", { name: /Missing Notes/ }).click();
    await expect(qaPanel.getByRole("status", { name: "QA result summary" })).toContainText("QA Panel shows");
    const missingNotesIssue = qaPanel
      .getByRole("list", { name: "QA issues" })
      .getByRole("listitem", { name: "missing-notes" });
    await expect(missingNotesIssue).toBeVisible();
    await expect(missingNotesIssue.getByRole("heading", { name: "missing-notes" })).toBeVisible();
    await expect(missingNotesIssue.getByText("Slide has no speaker notes file.")).toBeVisible();
    await expect(missingNotesIssue.getByText("slides[].notes")).toBeVisible();

    await expectNoFrameworkOverlay(page);
  });

  test("manages CLI integration and official skills from settings", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const cliTargetDir = path.join(tempRoot, "cli-bin");
    const htmlslideHomeDir = path.join(tempRoot, "htmlslide-state");
    const shimPath = path.join(cliTargetDir, "htmlslide");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_CLI_TARGET_DIR: cliTargetDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_HOME: htmlslideHomeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "CLI Integration", exact: true })).toBeVisible();
    await expect(page.locator(".cli-settings-details code", { hasText: shimPath })).toBeVisible();
    await expect(page.getByRole("heading", { name: "HTMLslide Skills", exact: true })).toBeVisible();
    const skillsPanel = page.locator(".cli-settings-card").filter({
      has: page.getByRole("heading", { name: "HTMLslide Skills", exact: true })
    });
    await expect(skillsPanel.getByText("0 / 12")).toBeVisible();
    await expect(skillsPanel.getByText("12 missing or stale")).toBeVisible();
    await expect(skillsPanel.getByText("7 low / 5 medium")).toBeVisible();
    await expect(skillsPanel.getByText("7 deck categories")).toBeVisible();
    await skillsPanel.getByRole("button", { name: "Missing", exact: true }).click();
    await skillsPanel.getByLabel("Type").selectOption("quality");
    const antiAiSlopSkill = skillsPanel.getByRole("listitem", { name: "anti-ai-slop missing" });
    await expect(antiAiSlopSkill).toBeVisible();
    await expect(skillsPanel.getByRole("listitem", { name: "deck-repair missing" })).toBeVisible();
    await expect(skillsPanel.getByRole("listitem", { name: "deck-architect missing" })).toHaveCount(0);
    await antiAiSlopSkill.getByRole("button", { name: "Inspect anti-ai-slop", exact: true }).click();
    await expect(antiAiSlopSkill.getByRole("button", { name: "Close anti-ai-slop", exact: true })).toBeVisible();
    const antiAiSlopInspection = antiAiSlopSkill.locator(".official-skill-inspection");
    await expect(antiAiSlopInspection.getByText("Author", { exact: true })).toBeVisible();
    await expect(antiAiSlopInspection.getByText("HTMLslide", { exact: true })).toBeVisible();
    await expect(antiAiSlopInspection.getByText("Version", { exact: true })).toBeVisible();
    await expect(antiAiSlopInspection.getByText("Schema", { exact: true })).toBeVisible();
    await expect(antiAiSlopInspection.getByText("0.1.0", { exact: true })).toHaveCount(2);
    await expect(antiAiSlopInspection.getByText("SKILL.md", { exact: true })).toBeVisible();
    await expect(antiAiSlopInspection.getByText("fixed-viewport, speaker-notes, deck-check")).toBeVisible();
    await expect(antiAiSlopInspection.getByText(path.join(htmlslideHomeDir, "skills", "anti-ai-slop", "SKILL.md"))).toBeVisible();
    await expect(antiAiSlopSkill.getByLabel("anti-ai-slop risk flags")).toContainText("Scripts: no");
    await expect(antiAiSlopSkill.getByLabel("anti-ai-slop risk flags")).toContainText("Modifies source: yes");
    await expect(antiAiSlopSkill.getByLabel("anti-ai-slop markdown preview")).toContainText("name: anti-ai-slop");
    await skillsPanel.getByRole("button", { name: "All", exact: true }).click();
    await skillsPanel.getByLabel("Type").selectOption("all");

    await page.getByRole("button", { name: "Reinstall CLI", exact: true }).click();
    await expect(page.getByRole("status", { name: "CLI integration operation status" })).toContainText(/Installed HTMLslide CLI shim/, {
      timeout: 30_000
    });
    await expect(access(shimPath)).resolves.toBeUndefined();
    expect(await readFile(shimPath, "utf8")).toContain("HTMLslide managed CLI shim v1");

    await page.getByRole("button", { name: "Install Official Skills", exact: true }).click();
    await expect(page.getByRole("status", { name: "Official skills operation status" })).toContainText(/12 official skills installed/, {
      timeout: 30_000
    });
    const officialSkillList = page.getByRole("list", { name: "Official HTMLslide skills" });
    const deckArchitectSkill = officialSkillList.getByRole("listitem").filter({ hasText: "deck-architect" });
    await expect(deckArchitectSkill).toContainText("Planning");
    await expect(deckArchitectSkill).toContainText("low risk");
    await expect(deckArchitectSkill).toContainText("Apache-2.0");
    await expect(deckArchitectSkill).toContainText("installed");
    await expect(readFile(path.join(htmlslideHomeDir, "skills", "deck-architect", "SKILL.md"), "utf8"))
      .resolves.toContain("name: deck-architect");

    await page.getByRole("button", { name: "Copy Manual Install", exact: true }).click();
    await expect(page.getByText("Manual install command copied")).toBeVisible();

    await page.getByRole("button", { name: "Uninstall CLI", exact: true }).click();
    await expect(page.getByRole("status", { name: "CLI integration operation status" })).toContainText(/Removed HTMLslide CLI shim/, {
      timeout: 30_000
    });
    await expect(access(shimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoFrameworkOverlay(page);
  });
});
