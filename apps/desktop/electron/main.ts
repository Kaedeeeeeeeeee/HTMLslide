import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell, type Rectangle } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  defaultWorkspacePath,
  detectExternalAgentStatuses,
  diffDesktopCheckpoint,
  findCliRuntime,
  getDesktopCliIntegration,
  getDesktopOfficialSkills,
  installDesktopCliIntegration,
  installDesktopOfficialSkills,
  listDesktopPresenterDisplays,
  loadProjectPreview,
  loadDesktopPresenterDeck,
  loadDesktopPresenterDeckPackage,
  markRecentProjectMissing,
  readAiEngineSettings,
  readDesktopLibrary,
  removeRecentProject,
  resolveCreateProjectRequest,
  revertDesktopCheckpoint,
  runDesktopByokAgent,
  saveAiEngineSettings,
  runDesktopExternalAgent,
  runDesktopMockAgent,
  runHtmlslideCli,
  summarizeDeckProject,
  uninstallDesktopCliIntegration,
  upsertRecentProject,
  writeDesktopLibrary,
  type DesktopCliIntegrationOptions,
  type DesktopAiEngineSettingsSaveRequest,
  type DesktopCreateProjectRequest,
  type DesktopProjectRecord
} from "./desktop-services.js";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const devServerUrl = process.env.HTMLSLIDE_DESKTOP_DEV_SERVER_URL;
const cliRuntime = findCliRuntime(currentDir, process.resourcesPath);
const configuredUserDataPath = process.env.HTMLSLIDE_USER_DATA_DIR
  ? resolve(process.env.HTMLSLIDE_USER_DATA_DIR)
  : undefined;
const smokeQuitAfterReady = process.env.HTMLSLIDE_SMOKE_QUIT_AFTER_READY === "1";
const smokeReadyFile = process.env.HTMLSLIDE_SMOKE_READY_FILE
  ? resolve(process.env.HTMLSLIDE_SMOKE_READY_FILE)
  : undefined;
const smokeExpectedOpenDeckPackagePath = isDeckPackagePath(process.env.HTMLSLIDE_SMOKE_EXPECT_OPEN_DECKPKG_PATH)
  ? resolve(process.env.HTMLSLIDE_SMOKE_EXPECT_OPEN_DECKPKG_PATH)
  : undefined;
let pendingDeckPackagePath = initialDeckPackagePath();

const writeSmokeMarker = async (marker: Record<string, unknown>) => {
  if (!smokeReadyFile) {
    return;
  }

  await mkdir(dirname(smokeReadyFile), { recursive: true });
  await writeFile(smokeReadyFile, `${JSON.stringify(marker)}\n`);
};

if (configuredUserDataPath) {
  app.setPath("userData", configuredUserDataPath);
}

const libraryPath = (): string => join(app.getPath("userData"), "library.json");
const aiEngineSettingsPath = (): string => join(app.getPath("userData"), "ai-engine-settings.json");
const configuredWorkspacePath = (): string =>
  process.env.HTMLSLIDE_DEFAULT_WORKSPACE
    ? resolve(process.env.HTMLSLIDE_DEFAULT_WORKSPACE)
    : defaultWorkspacePath();
const currentDarwinAppBundlePath = (): string | undefined => {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const bundlePath = resolve(dirname(process.execPath), "..", "..");
  return bundlePath.endsWith(".app") ? bundlePath : undefined;
};
const appBundlePath = (): string | undefined => {
  const bundlePath = currentDarwinAppBundlePath();
  return bundlePath && basename(bundlePath) === "HTMLslide.app" ? bundlePath : undefined;
};
const appBundleId = (): string =>
  process.env.HTMLSLIDE_BUNDLE_ID ?? (app.isPackaged ? "app.htmlslide.alpha" : "app.htmlslide.development");
const cliIntegrationOptions = (): DesktopCliIntegrationOptions => ({
  appPath: appBundlePath(),
  appVersion: app.getVersion(),
  bundleId: appBundleId(),
  cliRuntime,
  env: process.env
});
const officialSkillsOptions = () => ({
  env: process.env
});

type DesktopAudienceSlidePayload = {
  deckTitle: string;
  slideId: string;
  slideTitle: string;
  slideNumber: number;
  slideCount: number;
  screen: "normal" | "black" | "white";
  sourceHtml?: string;
  imageDataUrl?: string;
  section?: string;
  accent?: string;
};

type DesktopAudienceWindowRequest = {
  displayId?: number;
  payload?: DesktopAudienceSlidePayload;
};

let audienceWindow: BrowserWindow | undefined;
let audienceWindowDisplayId: number | undefined;

const invokeCli = async (args: string[]) => {
  if (!cliRuntime) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide."
    };
  }

  return runHtmlslideCli(args, {
    cliPath: cliRuntime.cliPath,
    cwd: cliRuntime.cwd,
    rootPath: cliRuntime.rootPath
  });
};

function isDeckPackagePath(filePath: string | undefined): filePath is string {
  return typeof filePath === "string" && /\.deckpkg$/iu.test(filePath.trim());
}

function initialDeckPackagePath(): string | undefined {
  const envPath = process.env.HTMLSLIDE_E2E_OPEN_DECKPKG_PATH;
  if (isDeckPackagePath(envPath)) {
    return resolve(envPath);
  }

  const argPath = process.argv.find((arg) => isDeckPackagePath(arg));
  return argPath ? resolve(argPath) : undefined;
}

function takePendingDeckPackageOpen(): string | undefined {
  const deckpkgPath = pendingDeckPackagePath;
  pendingDeckPackagePath = undefined;
  return deckpkgPath;
}

function queueDeckPackageOpen(filePath: string): boolean {
  if (!isDeckPackagePath(filePath)) {
    return false;
  }

  const deckpkgPath = resolve(filePath);
  pendingDeckPackagePath = deckpkgPath;
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    browserWindow.webContents.send("htmlslide:open-deckpkg", {
      kind: "deckpkg",
      path: deckpkgPath
    });
  }
  return true;
}

function isAudienceSlidePayload(value: unknown): value is DesktopAudienceSlidePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Partial<DesktopAudienceSlidePayload>;
  return (
    typeof payload.deckTitle === "string" &&
    typeof payload.slideId === "string" &&
    typeof payload.slideTitle === "string" &&
    Number.isInteger(payload.slideNumber) &&
    Number.isInteger(payload.slideCount) &&
    (payload.screen === "normal" || payload.screen === "black" || payload.screen === "white")
  );
}

function normalizeAudienceWindowRequest(value: unknown): Required<Pick<DesktopAudienceWindowRequest, "payload">> &
  Pick<DesktopAudienceWindowRequest, "displayId"> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Audience window request must be an object.");
  }

  const request = value as DesktopAudienceWindowRequest;
  if (!isAudienceSlidePayload(request.payload)) {
    throw new Error("Audience window request is missing a valid slide payload.");
  }

  return {
    displayId: typeof request.displayId === "number" && Number.isFinite(request.displayId)
      ? Math.round(request.displayId)
      : undefined,
    payload: request.payload
  };
}

function audienceWindowBounds(displayId: number | undefined): Rectangle {
  const selectedDisplay = screen.getAllDisplays().find((display) => display.id === displayId) ?? screen.getPrimaryDisplay();
  const bounds = selectedDisplay.bounds;
  const width = Math.max(960, Math.round(bounds.width));
  const height = Math.max(540, Math.round(bounds.height));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height
  };
}

function createAudienceWindow(displayId: number | undefined): BrowserWindow {
  const bounds = audienceWindowBounds(displayId);
  const browserWindow = new BrowserWindow({
    ...bounds,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#050505",
    focusable: false,
    frame: false,
    show: false,
    title: "HTMLslide Audience Window",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  browserWindow.on("closed", () => {
    if (audienceWindow === browserWindow) {
      audienceWindow = undefined;
      audienceWindowDisplayId = undefined;
    }
  });

  return browserWindow;
}

async function openAudienceWindow(requestValue: unknown) {
  const request = normalizeAudienceWindowRequest(requestValue);
  audienceWindowDisplayId = request.displayId;

  if (!audienceWindow || audienceWindow.isDestroyed()) {
    audienceWindow = createAudienceWindow(request.displayId);
  } else {
    audienceWindow.setBounds(audienceWindowBounds(request.displayId));
  }

  await audienceWindow.loadURL(audienceSlideDataUrl(request.payload));
  audienceWindow.showInactive();
  return {
    open: true,
    displayId: audienceWindowDisplayId
  };
}

async function updateAudienceWindow(requestValue: unknown) {
  const request = normalizeAudienceWindowRequest(requestValue);
  if (!audienceWindow || audienceWindow.isDestroyed()) {
    return {
      open: false,
      displayId: request.displayId
    };
  }

  audienceWindowDisplayId = request.displayId;
  audienceWindow.setBounds(audienceWindowBounds(request.displayId));
  await audienceWindow.loadURL(audienceSlideDataUrl(request.payload));
  return {
    open: true,
    displayId: audienceWindowDisplayId
  };
}

function closeAudienceWindow() {
  if (audienceWindow && !audienceWindow.isDestroyed()) {
    audienceWindow.close();
  }
  audienceWindow = undefined;
  audienceWindowDisplayId = undefined;
  return {
    open: false
  };
}

function audienceSlideDataUrl(payload: DesktopAudienceSlidePayload): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(audienceSlideHtml(payload))}`;
}

function audienceSlideHtml(payload: DesktopAudienceSlidePayload): string {
  const safeSourceHtml = payload.sourceHtml ? sanitizeAudienceSlideHtml(payload.sourceHtml) : "";
  const safeImageDataUrl = safeAudienceImageDataUrl(payload.imageDataUrl);
  const screenLabel = payload.screen === "black" ? "Black screen" : payload.screen === "white" ? "White screen" : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.deckTitle)} - Audience</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: ${escapeCssColor(payload.accent ?? "#315fcb")};
      --stage-bg: #050505;
      --stage-fg: #f7f8fb;
      --stage-muted: #a7afc0;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--stage-bg); }
    body {
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--stage-fg);
    }
    .audience-stage {
      position: relative;
      width: min(100vw, calc(100vh * 16 / 9));
      aspect-ratio: 16 / 9;
      background: #11131a;
      box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 24px 90px rgba(0,0,0,.5);
      overflow: hidden;
    }
    .audience-slide {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      color: #111827;
    }
    .audience-slide > section,
    .audience-slide > article,
    .audience-slide > div {
      width: 100%;
      height: 100%;
      margin: 0;
    }
    .audience-slide--image {
      display: grid;
      place-items: center;
      background: #050505;
    }
    .audience-slide--image img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .audience-fallback {
      height: 100%;
      display: grid;
      align-content: center;
      gap: 3vh;
      padding: 9vh 9vw;
      background: #111827;
      color: white;
    }
    .audience-fallback span {
      width: max-content;
      border: 1px solid rgba(255,255,255,.24);
      border-radius: 999px;
      padding: .5rem .9rem;
      color: var(--stage-muted);
      font-size: clamp(.8rem, 1.6vw, 1.1rem);
      text-transform: uppercase;
    }
    .audience-fallback h1 {
      max-width: 12ch;
      margin: 0;
      font-size: clamp(4rem, 10vw, 9.5rem);
      line-height: .9;
    }
    .audience-fallback p {
      margin: 0;
      color: var(--stage-muted);
      font-size: clamp(1.2rem, 2.2vw, 2rem);
    }
    .audience-cover {
      position: absolute;
      inset: 0;
      display: ${payload.screen === "normal" ? "none" : "grid"};
      place-items: center;
      background: ${payload.screen === "white" ? "#fff" : "#000"};
      color: ${payload.screen === "white" ? "#111" : "#fff"};
      font-size: clamp(2rem, 7vw, 7rem);
      font-weight: 700;
      z-index: 10;
    }
    .audience-meta {
      position: absolute;
      right: 1rem;
      bottom: .8rem;
      color: rgba(255,255,255,.72);
      font-size: .85rem;
      z-index: 11;
      text-shadow: 0 1px 2px rgba(0,0,0,.8);
    }
  </style>
</head>
<body>
  <main class="audience-stage" aria-label="HTMLslide audience window">
    ${safeSourceHtml
      ? `<div class="audience-slide">${safeSourceHtml}</div>`
      : safeImageDataUrl
        ? `<div class="audience-slide audience-slide--image"><img src="${safeImageDataUrl}" alt="${escapeHtml(payload.slideTitle)}" /></div>`
        : audienceFallbackHtml(payload)}
    <div class="audience-cover">${escapeHtml(screenLabel)}</div>
    <div class="audience-meta">${payload.slideNumber} / ${payload.slideCount}</div>
  </main>
</body>
</html>`;
}

function audienceFallbackHtml(payload: DesktopAudienceSlidePayload): string {
  return `<section class="audience-fallback">
  <span>${escapeHtml(payload.section ?? `Slide ${payload.slideNumber}`)}</span>
  <h1>${escapeHtml(payload.slideTitle)}</h1>
  <p>${escapeHtml(payload.deckTitle)}</p>
</section>`;
}

function sanitizeAudienceSlideHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/javascript:/giu, "");
}

function safeAudienceImageDataUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return /^data:image\/png;base64,[a-z0-9+/=\s]+$/iu.test(value) ? value.replace(/\s+/gu, "") : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeCssColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/iu.test(value.trim()) ? value.trim() : "#315fcb";
}

function registerIpcHandlers(): void {
  ipcMain.handle("htmlslide:get-setup", async () => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    const [cliIntegration, officialSkills] = await Promise.all([
      getDesktopCliIntegration(cliIntegrationOptions()),
      getDesktopOfficialSkills(officialSkillsOptions())
    ]);
    const initialOpenDeckPackagePath = takePendingDeckPackageOpen();
    return {
      appName: "HTMLslide",
      version: app.getVersion(),
      platform: process.platform,
      libraryPath: libraryPath(),
      workspacePath: library.defaultWorkspace,
      cli: {
        available: Boolean(cliRuntime),
        mode: cliRuntime?.mode ?? "missing",
        rootPath: cliRuntime?.rootPath,
        cliPath: cliRuntime?.cliPath
      },
      cliIntegration,
      officialSkills,
      smoke: smokeExpectedOpenDeckPackagePath
        ? {
            expectOpenDeckpkgPath: smokeExpectedOpenDeckPackagePath
          }
        : undefined,
      initialOpen: initialOpenDeckPackagePath
        ? {
            kind: "deckpkg",
            path: initialOpenDeckPackagePath
          }
        : undefined
    };
  });

  ipcMain.handle("htmlslide:get-cli-integration", async () =>
    getDesktopCliIntegration(cliIntegrationOptions())
  );

  ipcMain.handle("htmlslide:install-cli-integration", async () =>
    installDesktopCliIntegration(cliIntegrationOptions())
  );

  ipcMain.handle("htmlslide:install-official-skills", async () =>
    installDesktopOfficialSkills(officialSkillsOptions())
  );

  ipcMain.handle("htmlslide:uninstall-cli-integration", async () =>
    uninstallDesktopCliIntegration(cliIntegrationOptions())
  );

  ipcMain.handle("htmlslide:copy-cli-manual-install-command", async () => {
    const status = await getDesktopCliIntegration(cliIntegrationOptions());
    clipboard.writeText(status.manualInstallCommand);
    return {
      command: status.manualInstallCommand,
      copied: true
    };
  });

  ipcMain.handle("htmlslide:list-projects", async () => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    return library.recentProjects;
  });

  ipcMain.handle("htmlslide:remove-recent-project", async (_event, project: { id?: string; path?: string }) => {
    const library = await removeRecentProject(libraryPath(), project, configuredWorkspacePath());
    return library.recentProjects;
  });

  ipcMain.handle("htmlslide:mark-recent-project-missing", async (_event, project: { id?: string; path?: string }) => {
    const library = await markRecentProjectMissing(libraryPath(), project, configuredWorkspacePath());
    return library.recentProjects;
  });

  ipcMain.handle("htmlslide:get-ai-engine-settings", async () => readAiEngineSettings(aiEngineSettingsPath()));

  ipcMain.handle("htmlslide:save-ai-engine-settings", async (_event, request: DesktopAiEngineSettingsSaveRequest) =>
    saveAiEngineSettings(aiEngineSettingsPath(), request)
  );

  ipcMain.handle("htmlslide:detect-external-agents", async () => detectExternalAgentStatuses());

  ipcMain.handle("htmlslide:choose-workspace", async () => {
    const result = await dialog.showOpenDialog({
      buttonLabel: "Use Workspace",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return undefined;
    }

    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    const nextLibrary = {
      ...library,
      defaultWorkspace: result.filePaths[0]
    };
    await writeDesktopLibrary(libraryPath(), nextLibrary);
    return nextLibrary.defaultWorkspace;
  });

  ipcMain.handle("htmlslide:open-project-dialog", async () => {
    const selectedProjectPath = process.env.HTMLSLIDE_E2E_OPEN_PROJECT_PATH
      ? resolve(process.env.HTMLSLIDE_E2E_OPEN_PROJECT_PATH)
      : undefined;

    let projectPath = selectedProjectPath;
    if (!projectPath) {
      const result = await dialog.showOpenDialog({
        buttonLabel: "Open Deck",
        properties: ["openDirectory"]
      });
      if (result.canceled || !result.filePaths[0]) {
        return undefined;
      }
      projectPath = result.filePaths[0];
    }

    const project = await summarizeDeckProject(projectPath);
    await upsertRecentProject(libraryPath(), project, configuredWorkspacePath());
    return loadProjectPreview(project.path);
  });

  ipcMain.handle("htmlslide:load-project", async (_event, projectPath: string) => {
    const project = await summarizeDeckProject(projectPath);
    await upsertRecentProject(libraryPath(), project, configuredWorkspacePath());
    return loadProjectPreview(project.path);
  });

  ipcMain.handle("htmlslide:create-project", async (_event, request: DesktopCreateProjectRequest) => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    const resolved = resolveCreateProjectRequest(request, library.defaultWorkspace);
    await mkdir(resolved.workspacePath, { recursive: true });
    const result = await invokeCli(["new", resolved.projectPath, "--title", resolved.title, "--json"]);

    if (!result.ok) {
      return result;
    }

    const project = await summarizeDeckProject(resolved.projectPath);
    await upsertRecentProject(libraryPath(), project, resolved.workspacePath);
    return {
      ...result,
      project: await loadProjectPreview(project.path)
    };
  });

  ipcMain.handle("htmlslide:check-project", async (_event, projectPath: string) => {
    const result = await invokeCli(["check", projectPath, "--json"]);
    if (result.json && typeof result.json === "object") {
      const project = await summarizeDeckProject(projectPath).catch((): DesktopProjectRecord | undefined => undefined);
      if (project) {
        await upsertRecentProject(
          libraryPath(),
          {
            ...project,
            status: result.ok ? "Ready" : "Needs check"
          },
          configuredWorkspacePath()
        );
      }
    }
    return result;
  });

  ipcMain.handle("htmlslide:export-project", async (_event, projectPath: string) => {
    const result = await invokeCli(["export", projectPath, "--json"]);
    const project = await summarizeDeckProject(projectPath).catch((): DesktopProjectRecord | undefined => undefined);
    if (project) {
      await upsertRecentProject(
        libraryPath(),
        {
          ...project,
          status: result.ok ? "Ready" : "Export failed"
        },
        configuredWorkspacePath()
      );
    }
    return result;
  });

  ipcMain.handle("htmlslide:load-presenter-deck", async (_event, projectPath: string) =>
    loadDesktopPresenterDeck(projectPath, { cliRuntime })
  );

  ipcMain.handle("htmlslide:load-presenter-deckpkg", async (_event, deckpkgPath: string) =>
    loadDesktopPresenterDeckPackage(deckpkgPath)
  );

  ipcMain.handle("htmlslide:report-smoke-ready", async (_event, marker: Record<string, unknown>) => {
    if (!smokeReadyFile) {
      return { ok: false };
    }

    await writeSmokeMarker(marker);
    if (smokeQuitAfterReady) {
      setTimeout(() => app.quit(), 100);
    }
    return { ok: true };
  });

  ipcMain.handle("htmlslide:list-presenter-displays", async () => listDesktopPresenterDisplays(screen));

  ipcMain.handle("htmlslide:open-audience-window", async (_event, request: unknown) =>
    openAudienceWindow(request)
  );

  ipcMain.handle("htmlslide:update-audience-window", async (_event, request: unknown) =>
    updateAudienceWindow(request)
  );

  ipcMain.handle("htmlslide:close-audience-window", async () => closeAudienceWindow());

  ipcMain.handle(
    "htmlslide:run-mock-agent",
    async (
      _event,
      request: {
        projectPath: string;
        brief: string;
        runExport?: boolean;
        maxRepairRounds?: number;
        runId?: string;
      }
    ) => runDesktopMockAgent(request, { cliRuntime })
  );

  ipcMain.handle(
    "htmlslide:run-byok-agent",
    async (
      _event,
      request: {
        projectPath: string;
        brief: string;
        runExport?: boolean;
        maxRepairRounds?: number;
        runId?: string;
      }
    ) => runDesktopByokAgent(request, { cliRuntime, settingsPath: aiEngineSettingsPath() })
  );

  ipcMain.handle(
    "htmlslide:run-external-agent",
    async (
      _event,
      request: {
        projectPath: string;
        brief: string;
        runExport?: boolean;
        runId?: string;
      }
    ) => runDesktopExternalAgent(request, { cliRuntime, settingsPath: aiEngineSettingsPath() })
  );

  ipcMain.handle(
    "htmlslide:diff-checkpoint",
    async (_event, request: { projectPath: string; runId?: string; checkpointId?: string }) =>
      diffDesktopCheckpoint(request)
  );

  ipcMain.handle(
    "htmlslide:revert-checkpoint",
    async (
      _event,
      request: { projectPath: string; runId?: string; checkpointId?: string; confirmed?: boolean }
    ) =>
      revertDesktopCheckpoint(request)
  );
}

app.on("open-file", (event, filePath) => {
  if (queueDeckPackageOpen(filePath)) {
    event.preventDefault();
  }
});

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    backgroundColor: "#f5f7fb",
    height: 960,
    minHeight: 760,
    minWidth: 1180,
    show: false,
    title: "HTMLslide",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDir, "preload.cjs"),
      sandbox: false
    },
    width: 1440
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const completeSmokeStartup = async (load: Promise<void>) => {
    if (!smokeQuitAfterReady) {
      return;
    }

    try {
      await load;
      if (smokeExpectedOpenDeckPackagePath) {
        return;
      }
      await writeSmokeMarker({ status: "passed", kind: "startup" });
      setTimeout(() => app.quit(), 100);
    } catch (error) {
      await writeSmokeMarker({
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      app.exit(1);
    }
  };

  if (devServerUrl) {
    void completeSmokeStartup(mainWindow.loadURL(devServerUrl));
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void completeSmokeStartup(mainWindow.loadFile(join(currentDir, "../renderer/index.html")));
}

app.whenReady().then(async () => {
  if (smokeQuitAfterReady) {
    void writeSmokeMarker({
      status: "main-started",
      kind: smokeExpectedOpenDeckPackagePath ? "deckpkg-open" : "startup",
      expectedDeckpkgPath: smokeExpectedOpenDeckPackagePath
    }).catch(() => undefined);
  }
  registerIpcHandlers();
  if (
    process.env.HTMLSLIDE_DISABLE_AUTO_CLI_PROVISIONING !== "1" &&
    (appBundlePath() || process.env.HTMLSLIDE_AUTO_INSTALL_CLI === "1")
  ) {
    await installDesktopCliIntegration(cliIntegrationOptions()).catch(() => undefined);
  }
  if (
    process.env.HTMLSLIDE_DISABLE_AUTO_SKILLS_PROVISIONING !== "1" &&
    (appBundlePath() || process.env.HTMLSLIDE_AUTO_INSTALL_SKILLS === "1")
  ) {
    await installDesktopOfficialSkills(officialSkillsOptions()).catch(() => undefined);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  closeAudienceWindow();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
