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

async function chooseVisualDirection(page: Page, index = 0): Promise<void> {
  const choicePanel = page.getByRole("region", { name: "Visual direction choices" });
  await expect(choicePanel).toBeVisible({ timeout: 30_000 });
  const choices = choicePanel.getByRole("button", { name: /Choose .* visual direction/ });
  await expect.poll(() => choices.count()).toBeGreaterThan(index);
  await choices.nth(index).click();
  await expect(choicePanel).toBeHidden({ timeout: 30_000 });
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

async function writeControlledExternalAgentScript(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    `
import fs from "node:fs";
import path from "node:path";

const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const promptFile = requireArg(args, "--prompt-file");
const manifestFile = requireArg(args, "--writes-manifest");
const stateFile = process.env.HTMLSLIDE_E2E_AGENT_STATE_FILE;
const completionReleaseFile = process.env.HTMLSLIDE_E2E_AGENT_COMPLETION_RELEASE_FILE;
const prompt = fs.readFileSync(promptFile, "utf8");
const cancelThenRetry = prompt.includes("CANCEL_THEN_RETRY");
const completeBeforeCancel = prompt.includes("COMPLETE_BEFORE_CANCEL");

if (!stateFile || (!cancelThenRetry && !completeBeforeCancel)) {
  throw new Error("Controlled E2E agent did not receive its state file and prompt marker.");
}

if (completeBeforeCancel) {
  if (!completionReleaseFile) {
    throw new Error("Controlled E2E agent did not receive its completion release file.");
  }
  console.log("controlled agent awaiting completion release");
  while (!fs.existsSync(completionReleaseFile)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeSuccessfulRun("Completion won cancel race", "The completed run remained authoritative after local cancel intent.");
  fs.writeFileSync(stateFile, "completed\\n");
  console.log("controlled agent completed before cancel dispatch");
  process.exit(0);
}

const retrying = fs.existsSync(stateFile);
console.log(retrying ? "controlled agent retry started" : "controlled agent live output");

if (!retrying) {
  process.on("SIGTERM", () => {
    fs.writeFileSync(stateFile, "cancelled\\n");
    console.error("controlled agent received cancellation");
    process.exit(0);
  });
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  throw new Error("Controlled E2E agent was not cancelled.");
}

writeSuccessfulRun("Retry completed", "The retried run completed through the shared desktop contract.");
console.log("controlled agent retry wrote slides/001-title.html");

function writeSuccessfulRun(title, subtitle) {
  const slideFile = path.join(projectRoot, "slides", "001-title.html");
  fs.writeFileSync(
    slideFile,
    '<section class="slide title-slide" data-slide-id="001-title"><p class="eyebrow">Controlled external agent</p><h1>' + title + '</h1><p class="subtitle">' + subtitle + '</p></section>\\n'
  );
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["slides/001-title.html"] }, null, 2) + "\\n");
}

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
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex 9.9.9");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("authenticated");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  console.log("--sandbox --ephemeral --ignore-user-config --skip-git-repo-check --json");
  process.exit(0);
}
if (args[0] === "exec") {
  const slideFile = path.join(process.cwd(), "slides", "001-title.html");
  fs.writeFileSync(
    slideFile,
    '<section class="slide title-slide" data-slide-id="001-title"><p class="eyebrow">Built-in Codex adapter</p><h1>Codex E2E complete</h1><p class="subtitle">Checkpoint, check, export, and diff review completed.</p></section>\\n'
  );
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex edit complete" } }));
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
  let previewNetworkServer: Server | undefined;
  let tempRoot: string | undefined;

  test.afterEach(async () => {
    if (electronApp) {
      await electronApp.close().catch(() => undefined);
      electronApp = undefined;
    }

    if (previewNetworkServer) {
      await closeServer(previewNetworkServer).catch(() => undefined);
      previewNetworkServer = undefined;
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
    const slidePreview = page.getByRole("region", { name: "Slide preview" });
    await expect(slidePreview).toBeVisible();
    await expect(slidePreview.locator("iframe")).toBeVisible({ timeout: 30_000 });

    const manifest = JSON.parse(await readFile(path.join(workspaceDir, "investor-update", "deck.json"), "utf8")) as {
      title?: string;
    };
    expect(manifest.title).toBe("Investor Update");
    await expectNoFrameworkOverlay(page);
  });

  test("completes executable onboarding once and persists setup", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-onboarding-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const defaultWorkspaceDir = path.join(tempRoot, "default-workspace");
    const selectedWorkspaceDir = path.join(tempRoot, "selected-workspace");
    const cliTargetDir = path.join(tempRoot, "bin");
    const htmlslideHomeDir = path.join(tempRoot, "htmlslide-home");
    const shimPath = path.join(cliTargetDir, "htmlslide");
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
      mkdir(defaultWorkspaceDir, { recursive: true }),
      mkdir(selectedWorkspaceDir, { recursive: true })
    ]);

    const env = {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HOME: homeDir,
      HTMLSLIDE_CLI_TARGET_DIR: cliTargetDir,
      HTMLSLIDE_DEFAULT_WORKSPACE: defaultWorkspaceDir,
      HTMLSLIDE_E2E_CHOOSE_WORKSPACE_PATH: selectedWorkspaceDir,
      HTMLSLIDE_HOME: htmlslideHomeDir,
      HTMLSLIDE_USER_DATA_DIR: userDataDir
    };

    electronApp = await electron.launch({ executablePath: electronExecutable, args: [electronMain], env });
    let page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("button", { name: "Start Setup", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Current workspace" })).toContainText(defaultWorkspaceDir);
    await page.getByRole("button", { name: "Choose Workspace", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Choose AI engine", exact: true })).toBeVisible();
    const aiModes = page.getByRole("region", { name: "AI engine modes" });
    await expect(aiModes.getByRole("button", { name: /No AI/ })).toHaveAttribute("aria-pressed", "true");
    await expect(aiModes.getByRole("button", { name: /HTMLslide Agent/ })).toBeVisible();
    const codingAgentMode = aiModes.getByRole("button", { name: /Coding Agent/ });
    await codingAgentMode.click();
    await expect(aiModes.getByRole("status", { name: "AI engine setup status" })).toContainText("AI engine settings saved");
    await expect(codingAgentMode).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Install CLI integration", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install CLI", exact: true }).click();
    await expect(page.getByRole("status", { name: "Command line tool operation status" })).toContainText(
      /Installed HTMLslide CLI shim/,
      { timeout: 30_000 }
    );
    await expect(access(shimPath)).resolves.toBeUndefined();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Install official skills", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install Skills", exact: true }).click();
    await expect(page.getByRole("status", { name: "Official skills operation status" })).toContainText(
      /12 official skills installed/,
      { timeout: 30_000 }
    );
    await expect(access(path.join(htmlslideHomeDir, "skills", "deck-architect", "SKILL.md"))).resolves.toBeUndefined();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
    const setupSummary = page.getByRole("region", { name: "Setup summary" });
    await expect(setupSummary).toContainText(selectedWorkspaceDir);
    await expect(setupSummary).toContainText("Coding Agent");
    await expect(setupSummary).toContainText("12 installed");
    await page.getByRole("button", { name: "Open Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await electronApp.close();
    electronApp = undefined;
    electronApp = await electron.launch({ executablePath: electronExecutable, args: [electronMain], env });
    page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome to HTMLslide" })).toHaveCount(0);
    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await expect(page.getByRole("region", { name: "AI engine modes" }).getByRole("button", { name: /Coding Agent/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expectNoFrameworkOverlay(page);
  });

  test("waits for the engine skip path to persist No AI mode", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-onboarding-skip-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true })
    ]);
    const env = {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HOME: homeDir,
      HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
      HTMLSLIDE_E2E_CREDENTIAL_STORE: "memory",
      HTMLSLIDE_USER_DATA_DIR: userDataDir
    };

    electronApp = await electron.launch({ executablePath: electronExecutable, args: [electronMain], env });
    let page = await electronApp.firstWindow();
    await page.getByRole("button", { name: "Start Setup", exact: true }).click();
    await page.getByRole("button", { name: "Use default folder", exact: true }).click();

    const aiModes = page.getByRole("region", { name: "AI engine modes" });
    await aiModes.getByRole("button", { name: /Coding Agent/ }).click();
    await expect(aiModes.getByRole("status", { name: "AI engine setup status" })).toContainText("AI engine settings saved");
    await page.getByRole("button", { name: "Continue without AI", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Install CLI integration", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Skip CLI install", exact: true }).click();
    await page.getByRole("button", { name: "Install later", exact: true }).click();
    await expect(page.getByRole("region", { name: "Setup summary" })).toContainText("No AI");
    await page.getByRole("button", { name: "Open Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await electronApp.close();
    electronApp = undefined;
    electronApp = await electron.launch({ executablePath: electronExecutable, args: [electronMain], env });
    page = await electronApp.firstWindow();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await expect(page.getByRole("region", { name: "AI engine modes" }).getByRole("button", { name: /No AI/ }))
      .toHaveAttribute("aria-pressed", "true");
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
    await chooseVisualDirection(page, 1);

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
    expect(manifest.slides).toHaveLength(8);
    const agentReportText = await readFile(
      path.join(projectDir, ".htmlslide", "reports", "latest-agent-run.json"),
      "utf8"
    );
    const agentReport = JSON.parse(agentReportText) as {
      applied?: { slideIds?: string[] };
      exportManifest?: { artifactCount?: number; sourceDigest?: string };
      outputs?: {
        build?: { slidesChanged?: string[] };
        outline?: { slides?: unknown[] };
        selectedVisualDirectionId?: string;
        visualDirection?: { directions?: Array<{ id?: string }> };
      };
      providerId?: string;
      runId?: string;
      targetSlideCount?: number;
    };
    expect(agentReport.providerId).toBe("htmlslide-mock");
    expect(agentReport.runId).toBe(manifest.agent?.lastRunId);
    expect(agentReport.targetSlideCount).toBe(8);
    expect(agentReport.exportManifest?.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(agentReport.exportManifest?.artifactCount).toBeGreaterThan(0);
    expect(agentReport.outputs?.outline?.slides).toHaveLength(8);
    expect(agentReport.outputs?.visualDirection?.directions?.map((direction) => direction.id)).toEqual([
      "direction-editorial",
      "direction-systems"
    ]);
    expect(agentReport.outputs?.selectedVisualDirectionId).toBe("direction-systems");
    const expectedSlideIds = [
      "001-title",
      "002-workflow",
      "003-detail",
      "004-detail",
      "005-detail",
      "006-detail",
      "007-detail",
      "008-review"
    ];
    expect(agentReport.outputs?.build?.slidesChanged).toEqual(expectedSlideIds);
    expect(agentReport.applied?.slideIds).toEqual(expectedSlideIds);
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
      await chooseVisualDirection(page);

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
    const buildStage = page.locator(".agent-stage").filter({ hasText: "Generic command changed 1 source files." });
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

  test("streams, cancels, rejects concurrent starts, and retries a Generic agent run", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(workspaceDir, "controlled-agent-run");
    const fakeAgentScript = path.join(tempRoot, "controlled-agent.mjs");
    const agentStateFile = path.join(tempRoot, "controlled-agent-state.txt");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    await writeControlledExternalAgentScript(fakeAgentScript);
    const commandTemplate = `"${process.execPath}" "${fakeAgentScript}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;
    await writeFile(
      path.join(userDataDir, "ai-engine-settings.json"),
      `${JSON.stringify({
        version: 1,
        mode: "external-agent",
        apiKey: { provider: "openai", model: "gpt-5-mini", hasKey: false },
        externalAgent: { selectedId: "generic", customCommand: commandTemplate }
      }, null, 2)}\n`,
      "utf8"
    );

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_AGENT_STATE_FILE: agentStateFile,
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

    const agentConsole = page.locator(".agent-console");
    const controls = page.locator(".command-bar__controls");
    const commandBar = page.getByLabel("Command bar");
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
    const runButton = controls.getByRole("button", { name: "Run", exact: true });
    const pauseButton = controls.getByRole("button", { name: "External agent does not support pause.", exact: true });
    const cancelButton = controls.getByRole("button", { name: "Cancel run", exact: true });
    const retryButton = controls.getByRole("button", { name: "Retry run", exact: true });
    const copyRepairPromptButton = controls.getByRole("button", { name: "Copy repair prompt", exact: true });
    const openLogsButton = controls.getByRole("button", { name: "Open logs", exact: true });

    await expect(pauseButton).toBeVisible({ timeout: 30_000 });
    await commandBar.fill("Generic command CANCEL_THEN_RETRY");
    await sendButton.click();
    await expect(agentConsole).toHaveAttribute("data-agent-run-status", "running");
    const firstRunId = await agentConsole.getAttribute("data-agent-run-id");
    expect(firstRunId).toMatch(/^run-/);
    await expect(runButton).toBeDisabled();
    await expect(sendButton).toBeDisabled();
    await expect(page.locator(".workspace-toolbar").getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    await expect(pauseButton).toBeDisabled();
    await expect(pauseButton).toHaveAttribute("title", "External agent does not support pause.");
    await expect(cancelButton).toBeEnabled();
    await expect(retryButton).toBeDisabled();

    await expect(openLogsButton).toBeEnabled({ timeout: 30_000 });
    await openLogsButton.click();
    const liveLogStage = page.locator(".agent-stage").filter({ hasText: "controlled agent live output" });
    await expect(liveLogStage.getByText("controlled agent live output")).toBeVisible();
    await expect(liveLogStage.locator("summary")).toBeFocused();

    const concurrentStartError = await page.evaluate(async (localProjectPath) => {
      const desktopApi = (window as unknown as {
        htmlslideDesktop?: { startAgentRun(request: unknown): Promise<unknown> };
      }).htmlslideDesktop;
      try {
        await desktopApi?.startAgentRun({
          engine: "external-agent",
          projectPath: localProjectPath,
          brief: "Concurrent start must fail."
        });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, projectPath);
    expect(concurrentStartError).toContain("already active");

    await cancelButton.click();
    await expect(agentConsole).toHaveAttribute("data-agent-run-status", "cancelled", { timeout: 30_000 });
    await expect(page.getByText("Generation cancelled", { exact: true }).first()).toBeVisible();
    await expect(retryButton).toBeEnabled();
    await expect(copyRepairPromptButton).toBeEnabled();
    await copyRepairPromptButton.click();
    await expect(page.getByText("Repair prompt copied", { exact: true }).last()).toBeVisible();
    await expect(access(agentStateFile)).resolves.toBeUndefined();
    await page.waitForTimeout(500);
    await expect(page.getByText("External agent completed check and export", { exact: true })).toHaveCount(0);

    await retryButton.click();
    await expect.poll(() => agentConsole.getAttribute("data-agent-run-id")).not.toBe(firstRunId);
    await expect(agentConsole).toHaveAttribute("data-agent-run-status", "succeeded", { timeout: 30_000 });
    await expect(page.getByText("External agent completed check and export", { exact: true })).toBeVisible();
    await expect(page.locator('iframe[title="HTML as source slide preview"]')).toBeVisible({ timeout: 30_000 });
    expect(await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).toContain("Retry completed");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("keeps a completed Generic agent run when completion wins the cancel race", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(workspaceDir, "completion-wins-cancel-race");
    const fakeAgentScript = path.join(tempRoot, "controlled-agent.mjs");
    const agentStateFile = path.join(tempRoot, "controlled-agent-state.txt");
    const completionReleaseFile = path.join(tempRoot, "release-agent-completion.txt");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    await writeControlledExternalAgentScript(fakeAgentScript);
    const commandTemplate = `"${process.execPath}" "${fakeAgentScript}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;
    await writeFile(
      path.join(userDataDir, "ai-engine-settings.json"),
      `${JSON.stringify({
        version: 1,
        mode: "external-agent",
        apiKey: { provider: "openai", model: "gpt-5-mini", hasKey: false },
        externalAgent: { selectedId: "generic", customCommand: commandTemplate }
      }, null, 2)}\n`,
      "utf8"
    );

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_AGENT_COMPLETION_RELEASE_FILE: completionReleaseFile,
        HTMLSLIDE_E2E_AGENT_STATE_FILE: agentStateFile,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath,
        HTMLSLIDE_USER_DATA_DIR: userDataDir
      }
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.exposeFunction("releaseControlledAgentCompletion", async () => {
      await writeFile(completionReleaseFile, "complete\n", "utf8");
    });
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });

    const agentConsole = page.locator(".agent-console");
    const controls = page.locator(".command-bar__controls");
    const commandBar = page.getByLabel("Command bar");
    await expect(
      controls.getByRole("button", { name: "External agent does not support pause.", exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await commandBar.fill("Generic command COMPLETE_BEFORE_CANCEL");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(agentConsole).toHaveAttribute("data-agent-run-status", "running");
    const openLogsButton = controls.getByRole("button", { name: "Open logs", exact: true });
    await expect(openLogsButton).toBeEnabled({ timeout: 30_000 });
    await openLogsButton.click();
    const waitingLogStage = page.locator(".agent-stage").filter({ hasText: "controlled agent awaiting completion release" });
    await expect(waitingLogStage.getByText("controlled agent awaiting completion release")).toBeVisible({
      timeout: 30_000
    });

    await page.evaluate(() => {
      const e2eWindow = window as Window & {
        __HTMLSLIDE_E2E_BEFORE_AGENT_CANCEL__?: (runId: string) => Promise<void>;
        releaseControlledAgentCompletion: () => Promise<void>;
      };
      e2eWindow.__HTMLSLIDE_E2E_BEFORE_AGENT_CANCEL__ = async () => {
        await e2eWindow.releaseControlledAgentCompletion();
        const deadline = Date.now() + 30_000;
        while (document.querySelector(".agent-console")?.getAttribute("data-agent-run-status") !== "succeeded") {
          if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for completion before cancel dispatch.");
          }
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
      };
    });

    await controls.getByRole("button", { name: "Cancel run", exact: true }).click();
    await expect(agentConsole).toHaveAttribute("data-agent-run-status", "succeeded", { timeout: 30_000 });
    await expect(page.getByText("External agent completed check and export", { exact: true })).toBeVisible();
    await expect(page.getByText("Generation cancelled", { exact: true })).toHaveCount(0);
    await expect.poll(async () => readFile(agentStateFile, "utf8")).toBe("completed\n");
    expect(await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).toContain(
      "Completion won cancel race"
    );

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("runs a detected Codex CLI through the built-in adapter from the new deck wizard", async () => {
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
    await expect(connectionGuide).toContainText("Ready for HTMLslide runs");
    await expect(connectionGuide).toContainText("Built-in agents are user-authorized local tools");

    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    let newDeckPanel = page.locator(".new-deck-panel");
    await newDeckPanel.getByLabel("Deck title").fill("Unsaved Agent Mode");
    await newDeckPanel.getByLabel("Brief").fill("This must remain blocked until Coding Agent mode is saved.");
    await newDeckPanel.getByRole("button", { name: /Coding Agent/ }).click();
    await expect(newDeckPanel.getByRole("alert")).toHaveText(
      "Connect an authenticated Claude Code or Codex CLI, or configure a ready Generic command, before using Coding Agent generation."
    );
    await expect(newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true })).toBeDisabled();
    await newDeckPanel.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.getByRole("button", { name: "AI Engines", exact: true }).click();
    await page.locator(".ai-settings__modes").getByRole("button", { name: /Coding Agent/ }).click();
    await page.locator(".external-agent-list").getByRole("button", { name: /Codex CLI/ }).click();
    await page.getByRole("button", { name: "Save Selection", exact: true }).click();
    await expect(page.getByText("AI engine settings saved", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await newDeckPanel.getByLabel("Deck title").fill("Codex Built In Demo");
    await newDeckPanel.getByLabel("Brief").fill("Run the tested built-in Codex adapter and revise the title slide.");
    await newDeckPanel.getByRole("button", { name: /Coding Agent/ }).click();
    await expect(newDeckPanel.getByText("Codex CLI is ready for New Deck and existing workspace runs.")).toBeVisible();
    await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();
    await expect(page.getByText("External agent completed check and export", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("heading", { name: "Review changes", exact: true })).toBeVisible();
    const projectPath = path.join(workspaceDir, "codex-built-in-demo");
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.toContain(
      "Codex E2E complete"
    );
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByRole("button", { name: "Revert changes", exact: true }).click();
    await expect(page.getByText("Checkpoint reverted", { exact: true })).toBeVisible({ timeout: 30_000 });
    const revertedSource = await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8");
    expect(revertedSource).not.toContain("Codex E2E complete");

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
    const initialPreviewFrame = page.locator('iframe[title="HTML as source slide preview"]');
    await expect(initialPreviewFrame).toBeVisible();
    await expect(page.frameLocator('iframe[title="HTML as source slide preview"]').getByText(
      "PDF and deckpkg remain deterministic artifacts."
    )).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await chooseVisualDirection(page);

    await expect(page.getByText("Mock agent completed check and export")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Mock HTMLslide Deck" })).toBeVisible();
    await expect(page.locator('iframe[title="HTMLslide mock deck slide preview"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.frameLocator('iframe[title="HTMLslide mock deck slide preview"]').getByRole(
      "heading",
      { name: "Mock HTMLslide Deck" }
    )).toBeVisible();
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
    await expect(page.locator('iframe[title="HTML as source slide preview"]')).toBeVisible({ timeout: 30_000 });

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("isolates lazy slide previews, ignores stale selection, fits the manifest viewport, and keeps errors in the canvas", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "preview-security");
    const firstSlidePath = path.join(projectPath, "slides", "001-title.html");
    const secondSlidePath = path.join(projectPath, "slides", "002-structure.html");
    await mkdir(homeDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    const firstSlideHtml = await readFile(firstSlidePath, "utf8");
    const hostileNetworkRequests: string[] = [];
    previewNetworkServer = createServer((request, response) => {
      hostileNetworkRequests.push(request.url ?? "/");
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      previewNetworkServer?.once("error", reject);
      previewNetworkServer?.listen(0, "127.0.0.1", () => {
        previewNetworkServer?.off("error", reject);
        resolve();
      });
    });
    const previewNetworkAddress = previewNetworkServer.address() as AddressInfo;
    const previewNetworkOrigin = `http://127.0.0.1:${previewNetworkAddress.port}`;
    const secondSlideHtml = await readFile(secondSlidePath, "utf8");
    await writeFile(
      secondSlidePath,
      `${secondSlideHtml}
<meta http-equiv="refresh" content="0;url=${previewNetworkOrigin}/refresh" />
<link rel="stylesheet" href="${previewNetworkOrigin}/style.css" />
<img src="${previewNetworkOrigin}/image.png" onerror="parent.document.body.dataset.previewIsolationSentinel='escaped'" alt="" />
<script>
document.body.dataset.hostilePreview = "executed";
try { parent.document.body.dataset.previewIsolationSentinel = "escaped"; } catch {}
fetch("${previewNetworkOrigin}/fetch");
</script>
`,
      "utf8"
    );

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [electronMain],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        HOME: homeDir,
        HTMLSLIDE_USER_DATA_DIR: userDataDir,
        HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
        HTMLSLIDE_E2E_OPEN_PROJECT_PATH: projectPath,
        HTMLSLIDE_E2E_PREVIEW_DELAY_MS: "800",
        HTMLSLIDE_E2E_PREVIEW_DELAY_SLIDE_ID: "001-title"
      }
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      document.body.dataset.previewIsolationSentinel = "safe";
    });
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("status", { name: "Slide preview status" })).toContainText("slides/001-title.html");

    const filmstrip = page.locator(".filmstrip-list");
    await filmstrip.getByRole("button", { name: /Project structure/ }).click();
    const secondFrame = page.locator('iframe[title="Project structure slide preview"]');
    const secondFrameContent = page.frameLocator('iframe[title="Project structure slide preview"]');
    await expect(secondFrame).toBeVisible({ timeout: 30_000 });
    await expect(secondFrame).toHaveAttribute("sandbox", "");
    await expect(secondFrame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(secondFrame).not.toHaveAttribute("allow", /.+/u);
    await expect.poll(() => secondFrame.evaluate((frame) => getComputedStyle(frame).pointerEvents)).toBe("none");
    await expect(secondFrameContent.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      "content",
      /default-src 'none'.*script-src 'none'/u
    );
    await expect(secondFrameContent.locator("body")).not.toHaveAttribute("data-hostile-preview", "executed");
    await expect(secondFrameContent.getByRole("heading", { name: "Project structure" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.dataset.previewIsolationSentinel)).toBe("safe");

    await page.waitForTimeout(900);
    expect(hostileNetworkRequests).toEqual([]);
    await expect(secondFrame).toBeVisible();
    await expect(page.locator('iframe[title="HTML as source slide preview"]')).toHaveCount(0);

    await filmstrip.getByRole("button", { name: /HTML as source/ }).click();
    await expect(page.getByRole("status", { name: "Slide preview status" })).toContainText("slides/001-title.html");
    await filmstrip.getByRole("button", { name: /Project structure/ }).click();
    await expect(secondFrame).toBeVisible();
    await page.waitForTimeout(900);
    await expect(secondFrame).toBeVisible();
    await expect(page.locator('iframe[title="HTML as source slide preview"]')).toHaveCount(0);

    const externallyUpdatedSecondSlide = `${await readFile(secondSlidePath, "utf8")}
<p>External preview revision</p>
`;
    await writeFile(secondSlidePath, externallyUpdatedSecondSlide, "utf8");
    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(secondFrameContent.getByText("External preview revision")).toBeVisible({ timeout: 30_000 });

    const previewDocument = page.locator(".slide-preview-document");
    const initialScale = await page.locator(".slide-preview-document__surface").getAttribute("data-preview-scale");
    expect(Number(initialScale)).toBeGreaterThan(0);
    const fitMetrics = await previewDocument.evaluate((container) => {
      const fit = container.querySelector<HTMLElement>(".slide-preview-document__fit");
      const containerRect = container.getBoundingClientRect();
      const fitRect = fit?.getBoundingClientRect();
      return {
        containerHeight: containerRect.height,
        containerWidth: containerRect.width,
        fitHeight: fitRect?.height ?? 0,
        fitWidth: fitRect?.width ?? 0
      };
    });
    expect(fitMetrics.fitWidth).toBeLessThanOrEqual(fitMetrics.containerWidth + 1);
    expect(fitMetrics.fitHeight).toBeLessThanOrEqual(fitMetrics.containerHeight + 1);
    await previewDocument.evaluate((container) => {
      (container as HTMLElement).style.width = "420px";
    });
    await expect.poll(async () => Number(
      await page.locator(".slide-preview-document__surface").getAttribute("data-preview-scale")
    )).toBeLessThan(Number(initialScale));

    await rm(firstSlidePath, { force: true });
    await filmstrip.getByRole("button", { name: /HTML as source/ }).click();
    await expect(page.getByRole("status", { name: "Slide preview status" })).toContainText("slides/001-title.html");
    const previewError = page.getByRole("alert", { name: "Slide preview error" });
    await expect(previewError).toContainText("Slide preview could not be built", { timeout: 30_000 });
    await expect(previewError).toContainText("slides/001-title.html");
    await expect(previewError).toContainText("Check the source file, then retry this preview.");
    const retryPreview = previewError.getByRole("button", { name: "Retry preview" });
    await expect(retryPreview).toBeVisible();
    await writeFile(firstSlidePath, firstSlideHtml, "utf8");
    await retryPreview.click();
    await expect(page.locator('iframe[title="HTML as source slide preview"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Slides" })).toBeVisible();
    await expectNoFrameworkOverlay(page);
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
    const refreshDisplaysButton = presenter.getByRole("button", { name: "Refresh displays", exact: true });
    await expect(refreshDisplaysButton).toHaveAttribute("title", "Refresh displays");
    await refreshDisplaysButton.click();
    await expect(presenter).toBeVisible();
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
