/* eslint-disable @typescript-eslint/no-require-imports */
import type * as Electron from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

contextBridge.exposeInMainWorld("htmlslideDesktop", {
  appName: "HTMLslide",
  platform: process.platform,
  shell: "electron",
  getSetup: () => ipcRenderer.invoke("htmlslide:get-setup"),
  getCliIntegration: () => ipcRenderer.invoke("htmlslide:get-cli-integration"),
  installCliIntegration: () => ipcRenderer.invoke("htmlslide:install-cli-integration"),
  installOfficialSkills: () => ipcRenderer.invoke("htmlslide:install-official-skills"),
  uninstallCliIntegration: () => ipcRenderer.invoke("htmlslide:uninstall-cli-integration"),
  copyCliManualInstallCommand: () => ipcRenderer.invoke("htmlslide:copy-cli-manual-install-command"),
  listProjects: () => ipcRenderer.invoke("htmlslide:list-projects"),
  removeRecentProject: (project: { id?: string; path?: string }) =>
    ipcRenderer.invoke("htmlslide:remove-recent-project", project),
  markRecentProjectMissing: (project: { id?: string; path?: string }) =>
    ipcRenderer.invoke("htmlslide:mark-recent-project-missing", project),
  getAiEngineSettings: () => ipcRenderer.invoke("htmlslide:get-ai-engine-settings"),
  saveAiEngineSettings: (request: { settings: unknown; apiKeyInput?: string; clearKey?: boolean }) =>
    ipcRenderer.invoke("htmlslide:save-ai-engine-settings", request),
  detectExternalAgents: () => ipcRenderer.invoke("htmlslide:detect-external-agents"),
  chooseWorkspace: () => ipcRenderer.invoke("htmlslide:choose-workspace"),
  openProjectDialog: () => ipcRenderer.invoke("htmlslide:open-project-dialog"),
  loadProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-project", projectPath),
  createProject: (request: { title: string; folderName: string; templateId?: string; workspacePath?: string }) =>
    ipcRenderer.invoke("htmlslide:create-project", request),
  checkProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:check-project", projectPath),
  exportProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:export-project", projectPath),
  loadPresenterDeck: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-presenter-deck", projectPath),
  loadPresenterDeckPackage: (deckpkgPath: string) => ipcRenderer.invoke("htmlslide:load-presenter-deckpkg", deckpkgPath),
  onOpenDeckPackage: (handler: (request: { kind: "deckpkg"; path: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { kind: "deckpkg"; path: string }) => handler(request);
    ipcRenderer.on("htmlslide:open-deckpkg", listener);
    return () => ipcRenderer.removeListener("htmlslide:open-deckpkg", listener);
  },
  reportSmokeReady: (marker: unknown) => ipcRenderer.invoke("htmlslide:report-smoke-ready", marker),
  listPresenterDisplays: () => ipcRenderer.invoke("htmlslide:list-presenter-displays"),
  openAudienceWindow: (request: unknown) => ipcRenderer.invoke("htmlslide:open-audience-window", request),
  updateAudienceWindow: (request: unknown) => ipcRenderer.invoke("htmlslide:update-audience-window", request),
  closeAudienceWindow: () => ipcRenderer.invoke("htmlslide:close-audience-window"),
  runMockAgent: (request: {
    projectPath: string;
    brief: string;
    runExport?: boolean;
    maxRepairRounds?: number;
    runId?: string;
  }) => ipcRenderer.invoke("htmlslide:run-mock-agent", request),
  runByokAgent: (request: {
    projectPath: string;
    brief: string;
    runExport?: boolean;
    maxRepairRounds?: number;
    runId?: string;
  }) => ipcRenderer.invoke("htmlslide:run-byok-agent", request),
  runExternalAgent: (request: {
    projectPath: string;
    brief: string;
    runExport?: boolean;
    runId?: string;
  }) => ipcRenderer.invoke("htmlslide:run-external-agent", request),
  diffCheckpoint: (request: { projectPath: string; runId?: string; checkpointId?: string }) =>
    ipcRenderer.invoke("htmlslide:diff-checkpoint", request),
  revertCheckpoint: (request: { projectPath: string; runId?: string; checkpointId?: string; confirmed?: boolean }) =>
    ipcRenderer.invoke("htmlslide:revert-checkpoint", request)
});
