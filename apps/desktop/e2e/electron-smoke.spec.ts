import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(e2eDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const electronMain = path.join(desktopRoot, "dist", "electron", "main.js");
const sampleProjectPath = path.join(repoRoot, "packages", "test-fixtures", "decks", "valid-full");
const requireFromDesktop = createRequire(path.join(desktopRoot, "package.json"));
const electronExecutable = requireFromDesktop("electron") as string;

async function expectNoFrameworkOverlay(page: Page): Promise<void> {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator("[data-nextjs-dialog-overlay], #webpack-dev-server-client-overlay")).toHaveCount(0);
  await expect(
    page.getByText(/\[plugin:vite|Internal server error|Failed to resolve import|Failed to load module script/i)
  ).toHaveCount(0);
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
      await rm(tempRoot, { recursive: true, force: true });
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
    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();

    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await expect(newDeckPanel.getByRole("button", { name: /No AI/ })).toHaveAttribute("aria-pressed", "true");
    await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await expect(newDeckPanel.getByText(/generation is not connected in this alpha/i)).toBeVisible();
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
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(error.message);
    });

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
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(error.message);
    });

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
    await expect(access(path.join(projectPath, "exports", "valid-full-deck.pdf"))).resolves.toBeUndefined();
    await expect(access(path.join(projectPath, "exports", "valid-full-deck.html"))).resolves.toBeUndefined();
    await expect(access(path.join(projectPath, "exports", "valid-full-deck.deckpkg"))).resolves.toBeUndefined();
    await expect(access(path.join(projectPath, "exports", "notes.json"))).resolves.toBeUndefined();
    await expect(access(path.join(projectPath, "exports", "thumbnails", "001-title.png"))).resolves.toBeUndefined();

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Present", exact: true }).click();

    const presenter = page.getByLabel("Presenter rehearsal mode");
    const currentSlideHeading = presenter.locator(".presenter-current .hs-panel-header h2");
    const screenCover = presenter.locator(".presenter-screen-cover");
    await expect(presenter).toBeVisible();
    await expect(presenter.getByText("Windowed Presenter / Rehearsal Mode")).toBeVisible();
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");
    await expect(presenter.getByRole("heading", { name: "Speaker Notes" })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(presenter.getByText("2 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("Project structure");

    await page.keyboard.press("ArrowLeft");
    await expect(presenter.getByText("1 / 2")).toBeVisible();
    await expect(currentSlideHeading).toHaveText("HTML as source");

    await page.keyboard.press("T");
    await expect(presenter.getByText("paused")).toBeVisible();

    await page.keyboard.press("B");
    await expect(screenCover).toHaveText("Black screen");
    await page.keyboard.press("B");
    await expect(screenCover).toBeHidden();

    await page.keyboard.press("W");
    await expect(screenCover).toHaveText("White screen");
    await page.keyboard.press("W");
    await expect(screenCover).toBeHidden();

    await expect(presenter.getByLabel("Jump to slide")).toBeVisible();

    await presenter.locator(".presenter-current").click();
    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible();

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("manages CLI integration from settings", async () => {
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

    await page.getByRole("button", { name: "Reinstall CLI", exact: true }).click();
    await expect(page.locator(".settings-note", { hasText: /Installed HTMLslide CLI shim/ })).toBeVisible({ timeout: 30_000 });
    await expect(access(shimPath)).resolves.toBeUndefined();
    expect(await readFile(shimPath, "utf8")).toContain("HTMLslide managed CLI shim v1");

    await page.getByRole("button", { name: "Copy Manual Install", exact: true }).click();
    await expect(page.getByText("Manual install command copied")).toBeVisible();

    await page.getByRole("button", { name: "Uninstall CLI", exact: true }).click();
    await expect(page.locator(".settings-note", { hasText: /Removed HTMLslide CLI shim/ })).toBeVisible({ timeout: 30_000 });
    await expect(access(shimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoFrameworkOverlay(page);
  });
});
