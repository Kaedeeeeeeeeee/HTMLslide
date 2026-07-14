import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(e2eDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const electronMain = path.join(desktopRoot, "dist", "electron", "main.js");
const sampleProjectPath = path.join(repoRoot, "packages", "test-fixtures", "decks", "valid-full");
const textOverflowProjectPath = path.join(repoRoot, "packages", "test-fixtures", "decks", "linter-text-overflow");
const requireFromDesktop = createRequire(path.join(desktopRoot, "package.json"));
const electronExecutable = requireFromDesktop("electron") as string;

type LaunchOptions = {
  forceRehearsalPresenter?: boolean;
  openProjectPath?: string;
  previewDelayMs?: number;
  previewDelaySlideId?: string;
};

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

async function launchDesktopApp(tempRoot: string, options: LaunchOptions = {}): Promise<ElectronApplication> {
  const homeDir = path.join(tempRoot, "home");
  const userDataDir = path.join(tempRoot, "user-data");
  const workspaceDir = path.join(tempRoot, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const env = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    HOME: homeDir,
    HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
    HTMLSLIDE_USER_DATA_DIR: userDataDir
  };

  if (options.forceRehearsalPresenter) {
    env.HTMLSLIDE_E2E_FORCE_REHEARSAL_PRESENTER = "1";
  }

  if (options.openProjectPath) {
    env.HTMLSLIDE_E2E_OPEN_PROJECT_PATH = options.openProjectPath;
  }

  if (options.previewDelayMs && options.previewDelaySlideId) {
    env.HTMLSLIDE_E2E_PREVIEW_DELAY_MS = String(options.previewDelayMs);
    env.HTMLSLIDE_E2E_PREVIEW_DELAY_SLIDE_ID = options.previewDelaySlideId;
  }

  return electron.launch({
    executablePath: electronExecutable,
    args: [electronMain],
    env
  });
}

async function expectNoAccessibilityViolations(page: Page, label: string, exclude: string[] = []): Promise<void> {
  // Electron does not support the blank aggregation page that axe opens by default.
  let builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .setLegacyMode();
  for (const selector of exclude) {
    builder = builder.exclude(selector);
  }

  const results = await builder.analyze();
  const summary = results.violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join("; ");
      return `${violation.id}: ${violation.help} (${targets})`;
    })
    .join("\n");

  expect(results.violations, `${label} accessibility violations:\n${summary}`).toEqual([]);
}

test.describe("HTMLslide desktop accessibility smoke", () => {
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

  test("covers onboarding, project library, and new deck wizard semantics", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    electronApp = await launchDesktopApp(tempRoot);

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForLoadState("domcontentloaded");

    await expect(page.getByRole("heading", { name: "Welcome to HTMLslide" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Setup progress" }).getByRole("listitem")).toHaveCount(6);
    const skipOnboarding = page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true });
    await skipOnboarding.focus();
    await expect(skipOnboarding).toBeFocused();
    await expectNoAccessibilityViolations(page, "onboarding");

    await skipOnboarding.click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const libraryNav = page.getByRole("navigation", { name: "Project library" });
    const recentNav = libraryNav.getByRole("button", { name: "Recent", exact: true });
    await expect(recentNav).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expectNoAccessibilityViolations(page, "project library");

    await page.setViewportSize({ width: 640, height: 800 });
    await expect(libraryNav).toBeVisible();
    const templatesNav = libraryNav.getByRole("button", { name: "Templates", exact: true });
    await templatesNav.click();
    await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
    await recentNav.click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page, "project library mobile");

    const newDeckTrigger = page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first();
    await newDeckTrigger.click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await expect(newDeckPanel).toBeVisible();
    await expect(newDeckPanel.getByLabel("Deck title")).toBeFocused();
    await newDeckPanel.press("Escape");
    await expect(newDeckPanel).toBeHidden();
    await expect(newDeckTrigger).toBeFocused();
    await newDeckTrigger.click();
    await expect(newDeckPanel).toBeVisible();
    await expect(newDeckPanel.getByRole("button", { name: /No AI/ })).toHaveAttribute("aria-pressed", "true");
    await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
    await expect(newDeckPanel.getByRole("alert")).toHaveText("Save a provider API key in AI Engines before using HTMLslide Agent.");
    await expectNoAccessibilityViolations(page, "new deck wizard");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("covers QA panel semantics after a failing check", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    const projectPath = path.join(tempRoot, "linter-text-overflow");
    const slidePath = path.join(projectPath, "slides", "001-overflow.html");
    await mkdir(path.dirname(projectPath), { recursive: true });
    await cp(textOverflowProjectPath, projectPath, { recursive: true });
    const originalSlideHtml = await readFile(slidePath, "utf8");
    electronApp = await launchDesktopApp(tempRoot, {
      openProjectPath: projectPath,
      previewDelayMs: 500,
      previewDelaySlideId: "001-overflow"
    });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Linter Text Overflow" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByRole("status", { name: "Slide preview status" })).toBeVisible();
    await expectNoAccessibilityViolations(page, "workspace slide preview loading");
    const previewFrame = page.locator('iframe[title="Text Overflow Fixture slide preview"]');
    await expect(previewFrame).toBeVisible({ timeout: 30_000 });
    await expect(previewFrame).toHaveAttribute("sandbox", "");
    await expect(previewFrame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(previewFrame).toHaveAttribute("tabindex", "-1");
    await expectNoAccessibilityViolations(page, "workspace slide preview");

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    const qaPanel = page.getByRole("region", { name: "QA Panel" });
    await expect(qaPanel.getByRole("status", { name: "QA result summary" })).toContainText("QA Panel shows 1 all severities issue", {
      timeout: 30_000
    });
    await expect(qaPanel.getByRole("tablist", { name: "QA severity filter" })).toBeVisible();
    await expect(qaPanel.getByRole("list", { name: "QA issues" }).getByRole("listitem", { name: "text-overflow" })).toBeVisible();
    await expect(qaPanel.getByRole("button", { name: "Go to slide 001-overflow" })).toBeVisible();
    await expectNoAccessibilityViolations(page, "QA panel");

    await rm(slidePath, { force: true });
    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    const previewError = page.getByRole("alert", { name: "Slide preview error" });
    await expect(previewError).toBeVisible({ timeout: 30_000 });
    await expectNoAccessibilityViolations(page, "workspace slide preview error");
    const retryPreview = previewError.getByRole("button", { name: "Retry preview" });
    await expect(retryPreview).toBeVisible();
    await retryPreview.evaluate((button) => (button as HTMLButtonElement).click());
    await writeFile(slidePath, originalSlideHtml, "utf8");
    await expect(previewFrame).toBeVisible({ timeout: 30_000 });

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("covers visual direction choice semantics before build", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    electronApp = await launchDesktopApp(tempRoot);

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
    const newDeckPanel = page.locator(".new-deck-panel");
    await newDeckPanel.getByLabel("Deck title").fill("Choice Semantics");
    await newDeckPanel.getByLabel("Brief").fill("Create a deterministic deck for accessibility validation.");
    await newDeckPanel.getByRole("button", { name: /Local Mock/ }).click();
    await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();

    const choicePanel = page.getByRole("region", { name: "Visual direction choices" });
    await expect(choicePanel).toBeVisible({ timeout: 30_000 });
    const choices = choicePanel.getByRole("button", { name: /Choose .* visual direction/ });
    await expect(choices).toHaveCount(2);
    await expect(choices.first()).toBeFocused();
    const panelBounds = await choicePanel.boundingBox();
    const choiceBounds = await choices.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    }));
    expect(panelBounds).not.toBeNull();
    const panelBottom = (panelBounds?.y ?? 0) + (panelBounds?.height ?? 0);
    expect(choiceBounds.every((bounds) => bounds.top >= (panelBounds?.y ?? 0) && bounds.bottom <= panelBottom)).toBe(true);
    await choices.nth(1).focus();
    await expect(choices.nth(1)).toBeFocused();
    await expectNoAccessibilityViolations(page, "visual direction choices");
    await choices.nth(1).press("Enter");
    await expect(choicePanel).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("AI generation is disabled in No AI mode.")).toBeHidden();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await expect(page.getByText("Mock agent completed check and export")).toBeVisible({ timeout: 30_000 });

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("keeps the workspace inspector reachable at narrow width", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(path.dirname(projectPath), { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    electronApp = await launchDesktopApp(tempRoot, { openProjectPath: projectPath });

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await page.locator(".library-main").getByRole("button", { name: "Open Folder", exact: true }).first().click();
    await expect(page.locator(".workspace-toolbar .workspace-title strong", { hasText: "Valid Full Deck" })).toBeVisible({
      timeout: 30_000
    });

    await page.setViewportSize({ width: 1024, height: 800 });
    const inspector = page.locator(".inspector");
    await expect(inspector).toBeVisible();
    const inspectorTabs = inspector.getByRole("tablist", { name: "Inspector tabs" });
    await expect(inspectorTabs).toBeVisible();
    const activeInspectorTab = inspectorTabs.locator('[role="tab"][aria-selected="true"]');
    const exportTab = inspectorTabs.getByRole("tab", { name: "Export", exact: true });
    await expect(activeInspectorTab).toHaveAttribute("tabindex", "0");
    await activeInspectorTab.focus();
    await activeInspectorTab.press("End");
    await expect(exportTab).toBeFocused();
    await expect(exportTab).toHaveAttribute("aria-selected", "true");
    await expect(inspector.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", /inspector-tab-export/);

    await page.locator(".workspace-toolbar").getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByRole("region", { name: "QA Panel" })).toBeVisible({ timeout: 30_000 });
    await inspector.getByRole("tab", { name: "Notes", exact: true }).click();
    await expect(inspector.getByRole("textbox", { name: "Presenter notes" })).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expectNoAccessibilityViolations(page, "narrow workspace inspector");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("covers presenter rehearsal controls", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    const projectPath = path.join(tempRoot, "valid-full");
    await mkdir(path.dirname(projectPath), { recursive: true });
    await cp(sampleProjectPath, projectPath, { recursive: true });
    electronApp = await launchDesktopApp(tempRoot, {
      forceRehearsalPresenter: true,
      openProjectPath: projectPath
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
    const presenter = page.getByRole("dialog", { name: "Valid Full Deck", exact: true });
    await expect(presenter).toBeVisible({ timeout: 30_000 });
    await expect(presenter.getByLabel("Presenter progress")).toBeVisible();
    await expect(presenter.getByRole("button", { name: "Swap screens", exact: true })).toBeVisible();
    const pauseTimerButton = presenter.getByRole("button", { name: "Pause timer", exact: true });
    await expect(pauseTimerButton).toHaveAttribute("aria-pressed", "false");
    await pauseTimerButton.click();
    const resumeTimerButton = presenter.getByRole("button", { name: "Resume timer", exact: true });
    await expect(resumeTimerButton).toHaveAttribute("aria-pressed", "true");
    await resumeTimerButton.focus();
    await resumeTimerButton.press("Space");
    await expect(presenter.getByRole("button", { name: "Pause timer", exact: true })).toHaveAttribute("aria-pressed", "false");
    await presenter.focus();
    await expect(presenter).toBeFocused();
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active?.closest(".presenter-mode"));
    })).toBe(true);
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
    }
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active?.closest(".presenter-mode"));
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(presenter).toBeHidden();
    await expect(page.locator(".workspace-toolbar").getByRole("button", { name: "Present", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page, "presenter rehearsal mode");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("covers settings, CLI status, and official skills library semantics", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    electronApp = await launchDesktopApp(tempRoot);

    const page = await electronApp.firstWindow();
    const browserErrors = collectBrowserErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "CLI Integration", exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "CLI integration operation status" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "HTMLslide Skills", exact: true })).toBeVisible();
    const settingsLayout = page.locator(".settings-layout");
    await expect.poll(() => settingsLayout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
    const skillsPanel = page.locator(".cli-settings-card").filter({
      has: page.getByRole("heading", { name: "HTMLslide Skills", exact: true })
    });
    await skillsPanel.getByRole("button", { name: "Missing", exact: true }).click();
    const antiAiSlopSkill = skillsPanel.getByRole("listitem", { name: "anti-ai-slop missing" });
    await expect(antiAiSlopSkill).toBeVisible();
    await antiAiSlopSkill.getByRole("button", { name: "Inspect anti-ai-slop", exact: true }).click();
    await expect(antiAiSlopSkill.getByLabel("anti-ai-slop risk flags")).toContainText("Modifies source: yes");
    await expectNoAccessibilityViolations(page, "settings and official skills");

    await page.setViewportSize({ width: 900, height: 800 });
    await expect.poll(() => settingsLayout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
    await expectNoAccessibilityViolations(page, "settings and official skills narrow");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });

  test("covers AI Engines external agent readiness semantics", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-a11y-"));
    electronApp = await launchDesktopApp(tempRoot);

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
    await page.getByLabel("Generic command").fill(
      "agent --project {{projectPath}} --prompt-file {{promptFile}} --writes {{writeManifest}}"
    );
    await page.getByRole("button", { name: "Save Selection", exact: true }).click();
    await expect(connectionGuide).toContainText("Ready for HTMLslide runs");
    await expect(connectionGuide).toContainText("HTMLslide run");
    await expect(connectionGuide).toContainText("Diff review");
    await expectNoAccessibilityViolations(page, "AI Engines external agent readiness");

    await expectNoFrameworkOverlay(page);
    expect(browserErrors).toEqual([]);
  });
});
