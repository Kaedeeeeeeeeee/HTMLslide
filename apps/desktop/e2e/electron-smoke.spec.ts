import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { readDeckPackage } from "@htmlslide/presenter";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.locator(".library-nav").getByRole("button", { name: "Templates", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
    await expect(page.getByText("Two-slide local-first project")).toBeVisible();
    await page.locator(".library-nav").getByRole("button", { name: "Recent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();

    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await expect(newDeckPanel.getByLabel("Template")).toHaveValue("default");
    await expect(newDeckPanel.getByRole("button", { name: /No AI/ })).toHaveAttribute("aria-pressed", "true");
    await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await expect(newDeckPanel.getByText("Save a provider API key in AI Engines before using HTMLslide Agent.")).toBeVisible();
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
    await page.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await page.getByLabel("API key").fill(fakeApiKey);
    await page.getByRole("button", { name: "Save Key", exact: true }).click();
    await expect(page.getByText("AI engine key saved")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("OpenAI key saved")).toBeVisible();

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
    await validCard.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(validCard).toHaveCount(0);
    expect(await readFile(path.join(validProjectPath, "deck.json"), "utf8")).toContain("Valid Full Deck");

    const missingCard = page.locator("article.project-card").filter({ hasText: "Recent Missing Deck" });
    await expect(missingCard).toBeVisible();
    await missingCard.getByRole("button", { name: "Open", exact: true }).click();
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
    await page.locator(".command-bar__controls").getByRole("button", { name: "View diff", exact: true }).click();
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

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText(/check: Check passed/)).toBeVisible({ timeout: 30_000 });

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator(".toolbar-status").getByText("export: Export complete")).toBeVisible({ timeout: 30_000 });
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
    const screenCover = presenter.locator(".presenter-screen-cover");
    const presenterNotes = presenter.locator(".presenter-notes");
    await expect(presenter).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.getByRole("heading", { name: "Speaker Notes" })).toBeVisible();
    await expect(presenter.getByLabel("Presenter target display")).toBeVisible();
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    const audienceWindowPromise = electronApp.waitForEvent("window");
    await presenter.getByRole("button", { name: "Open audience", exact: true }).click();
    const audiencePage = await audienceWindowPromise;
    await audiencePage.waitForLoadState("domcontentloaded");
    await expect(audiencePage.getByLabel("HTMLslide audience window")).toBeVisible();
    await expect(audiencePage.getByText("HTML as source")).toBeVisible();
    await expect(audiencePage.getByText("1 / 2")).toBeVisible();
    await page.bringToFront();

    await page.keyboard.press("ArrowRight");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");
    await expect(presenter.getByText("Project folders stay readable")).toBeVisible();
    await expect(audiencePage.getByText("Project structure")).toBeVisible();
    await expect(audiencePage.getByText("2 / 2")).toBeVisible();

    await page.keyboard.press("ArrowLeft");
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(audiencePage.getByText("HTML as source")).toBeVisible();

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

    await presenter.getByRole("button", { name: "Pause timer", exact: true }).click();
    await expect(presenter.getByText("paused")).toBeVisible();
    await presenter.getByRole("button", { name: "Resume timer", exact: true }).click();
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
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.getByRole("heading", { name: "Speaker Notes" })).toBeVisible();
    await expect(presenter.getByLabel("Presenter target display")).toBeVisible();
    await expect(presenter.locator(".presenter-current .presenter-slide-preview__image")).toBeVisible();
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    const audiencePromise = electronApp.waitForEvent("window");
    await presenter.getByRole("button", { name: "Open audience", exact: true }).click();
    const audiencePage = await audiencePromise;
    await audiencePage.waitForLoadState("domcontentloaded");
    await expect(audiencePage.locator(".audience-slide--image img")).toBeVisible();
    await expect(audiencePage.locator(".audience-meta")).toHaveText("1 / 2");
    await page.bringToFront();

    await page.keyboard.press("ArrowRight");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");
    await expect(presenter.locator(".presenter-current .presenter-slide-preview__image")).toBeVisible();
    await expect(audiencePage.locator(".audience-slide--image img")).toBeVisible();
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
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();
    await expect(presenter.getByText("Deck Package Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.locator(".presenter-notes").getByText("今天我们把 HTML 作为源码")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
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

    const qaPanel = page.locator(".qa-panel");
    await expect(qaPanel.getByRole("heading", { name: "QA Panel" })).toBeVisible();
    await expect(qaPanel.getByRole("heading", { name: "text-overflow" })).toBeVisible();
    await expect(qaPanel.getByText("Text is estimated to exceed its fixed container")).toBeVisible();
    await expect(qaPanel.getByText("p.body-copy")).toBeVisible();
    await expect(qaPanel.getByText(/overflowBottomPx/)).toBeVisible();

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

    const qaPanel = page.locator(".qa-panel");
    await expect(qaPanel.getByRole("heading", { name: "QA Panel" })).toBeVisible();
    await expect(qaPanel.getByRole("heading", { name: "missing-asset" })).toBeVisible();
    await expect(qaPanel.getByText("Referenced asset is missing: ../assets/missing-chart.png.")).toBeVisible();
    await expect(qaPanel.getByText("img[src]").first()).toBeVisible();

    await page.getByRole("button", { name: /Missing Notes/ }).click();
    await expect(qaPanel.getByRole("heading", { name: "missing-notes" })).toBeVisible();
    await expect(qaPanel.getByText("Slide has no speaker notes file.")).toBeVisible();
    await expect(qaPanel.getByText("slides[].notes")).toBeVisible();

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

    await page.getByRole("button", { name: "Reinstall CLI", exact: true }).click();
    await expect(page.locator(".settings-note", { hasText: /Installed HTMLslide CLI shim/ })).toBeVisible({ timeout: 30_000 });
    await expect(access(shimPath)).resolves.toBeUndefined();
    expect(await readFile(shimPath, "utf8")).toContain("HTMLslide managed CLI shim v1");

    await page.getByRole("button", { name: "Install Official Skills", exact: true }).click();
    await expect(page.locator(".settings-note", { hasText: /12 official skills installed/ })).toBeVisible({ timeout: 30_000 });
    await expect(readFile(path.join(htmlslideHomeDir, "skills", "deck-architect", "SKILL.md"), "utf8"))
      .resolves.toContain("name: deck-architect");

    await page.getByRole("button", { name: "Copy Manual Install", exact: true }).click();
    await expect(page.getByText("Manual install command copied")).toBeVisible();

    await page.getByRole("button", { name: "Uninstall CLI", exact: true }).click();
    await expect(page.locator(".settings-note", { hasText: /Removed HTMLslide CLI shim/ })).toBeVisible({ timeout: 30_000 });
    await expect(access(shimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoFrameworkOverlay(page);
  });
});
