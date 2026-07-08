import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
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
  installDesktopCliIntegration,
  loadProjectPreview,
  loadDesktopPresenterDeck,
  readAiEngineSettings,
  readDesktopLibrary,
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

const writeSmokeMarker = async (marker: Record<string, unknown>) => {
  if (!smokeReadyFile) {
    return;
  }

  await mkdir(dirname(smokeReadyFile), { recursive: true });
  await writeFile(smokeReadyFile, `${JSON.stringify(marker)}\n`);
};

if (smokeQuitAfterReady) {
  void writeSmokeMarker({ status: "main-started" }).catch(() => undefined);
}

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

function registerIpcHandlers(): void {
  ipcMain.handle("htmlslide:get-setup", async () => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    const cliIntegration = await getDesktopCliIntegration(cliIntegrationOptions());
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
      cliIntegration
    };
  });

  ipcMain.handle("htmlslide:get-cli-integration", async () =>
    getDesktopCliIntegration(cliIntegrationOptions())
  );

  ipcMain.handle("htmlslide:install-cli-integration", async () =>
    installDesktopCliIntegration(cliIntegrationOptions())
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

  ipcMain.handle("htmlslide:load-project", async (_event, projectPath: string) => loadProjectPreview(projectPath));

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
      await writeSmokeMarker({ status: "passed" });
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
  registerIpcHandlers();
  if (
    process.env.HTMLSLIDE_DISABLE_AUTO_CLI_PROVISIONING !== "1" &&
    (appBundlePath() || process.env.HTMLSLIDE_AUTO_INSTALL_CLI === "1")
  ) {
    await installDesktopCliIntegration(cliIntegrationOptions()).catch(() => undefined);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
