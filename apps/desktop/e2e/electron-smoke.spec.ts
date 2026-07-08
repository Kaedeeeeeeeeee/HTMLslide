import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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

  test("loads the Electron shell, reaches the library, and opens a sample deck", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-e2e-"));
    const homeDir = path.join(tempRoot, "home");
    const workspaceDir = path.join(tempRoot, "workspace");
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(homeDir, { recursive: true });
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
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true })).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).click();

    await expect(page.getByText("Project loaded")).toBeVisible();
    await expect(page.getByText("Valid Full Deck")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Slides" })).toBeVisible();
    await expect(page.getByLabel("HTML as source slide preview")).toBeVisible();
    await expect(page.getByText("PDF and deckpkg remain deterministic artifacts.")).toBeVisible();
    await expectNoFrameworkOverlay(page);

    await page.getByRole("button", { name: "Generate", exact: true }).click();

    await expect(page.getByText("Mock agent completed check and export")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Mock HTMLslide Deck" })).toBeVisible();
    await expect(page.getByText("Reviewable outputs")).toBeVisible();
    await expect(page.getByText("generate: Mock generation complete")).toBeVisible();
    await expect(page.getByText(/check: Check passed/)).toBeVisible();
    await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
    await expect(page.getByText("review: Ready for review")).toBeVisible();
    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });
});
