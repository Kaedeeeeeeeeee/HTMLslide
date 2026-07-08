import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  defaultWorkspacePath,
  findRepositoryRoot,
  loadProjectPreview,
  readDesktopLibrary,
  runHtmlslideCli,
  summarizeDeckProject,
  upsertRecentProject,
  writeDesktopLibrary,
  type DesktopProjectRecord
} from "./desktop-services.js";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const devServerUrl = process.env.HTMLSLIDE_DESKTOP_DEV_SERVER_URL;
const repoRoot = findRepositoryRoot(currentDir);

const libraryPath = (): string => join(app.getPath("userData"), "library.json");
const configuredWorkspacePath = (): string =>
  process.env.HTMLSLIDE_DEFAULT_WORKSPACE
    ? resolve(process.env.HTMLSLIDE_DEFAULT_WORKSPACE)
    : defaultWorkspacePath();

const cliRootPath = (): string | undefined => repoRoot;

const invokeCli = async (args: string[]) => {
  const rootPath = cliRootPath();
  if (!rootPath) {
    return {
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "",
      error: "Packaged CLI runtime is not available yet. Open a development build or install the CLI shim."
    };
  }

  return runHtmlslideCli(args, { rootPath });
};

function registerIpcHandlers(): void {
  ipcMain.handle("htmlslide:get-setup", async () => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    return {
      appName: "HTMLslide",
      version: app.getVersion(),
      platform: process.platform,
      libraryPath: libraryPath(),
      workspacePath: library.defaultWorkspace,
      cli: {
        available: Boolean(cliRootPath()),
        mode: cliRootPath() ? "development" : "packaged-missing",
        rootPath: cliRootPath()
      }
    };
  });

  ipcMain.handle("htmlslide:list-projects", async () => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    return library.recentProjects;
  });

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
    const result = await dialog.showOpenDialog({
      buttonLabel: "Open Deck",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return undefined;
    }

    const project = await summarizeDeckProject(result.filePaths[0]);
    await upsertRecentProject(libraryPath(), project, configuredWorkspacePath());
    return loadProjectPreview(project.path);
  });

  ipcMain.handle("htmlslide:load-project", async (_event, projectPath: string) => loadProjectPreview(projectPath));

  ipcMain.handle("htmlslide:create-project", async (_event, request: { name: string; workspacePath?: string }) => {
    const library = await readDesktopLibrary(libraryPath(), configuredWorkspacePath());
    const workspacePath = resolve(request.workspacePath ?? library.defaultWorkspace);
    await mkdir(workspacePath, { recursive: true });
    const projectPath = join(workspacePath, request.name);
    const result = await invokeCli(["new", projectPath, "--json"]);

    if (!result.ok) {
      return result;
    }

    const project = await summarizeDeckProject(projectPath);
    await upsertRecentProject(libraryPath(), project, workspacePath);
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
      preload: join(currentDir, "preload.js")
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

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
}

app.whenReady().then(() => {
  registerIpcHandlers();
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
