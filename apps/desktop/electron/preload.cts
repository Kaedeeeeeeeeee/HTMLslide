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
  uninstallCliIntegration: () => ipcRenderer.invoke("htmlslide:uninstall-cli-integration"),
  copyCliManualInstallCommand: () => ipcRenderer.invoke("htmlslide:copy-cli-manual-install-command"),
  listProjects: () => ipcRenderer.invoke("htmlslide:list-projects"),
  getAiEngineSettings: () => ipcRenderer.invoke("htmlslide:get-ai-engine-settings"),
  saveAiEngineSettings: (settings: unknown) => ipcRenderer.invoke("htmlslide:save-ai-engine-settings", settings),
  detectExternalAgents: () => ipcRenderer.invoke("htmlslide:detect-external-agents"),
  chooseWorkspace: () => ipcRenderer.invoke("htmlslide:choose-workspace"),
  openProjectDialog: () => ipcRenderer.invoke("htmlslide:open-project-dialog"),
  loadProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-project", projectPath),
  createProject: (request: { title: string; folderName: string; workspacePath?: string }) =>
    ipcRenderer.invoke("htmlslide:create-project", request),
  checkProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:check-project", projectPath),
  exportProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:export-project", projectPath),
  loadPresenterDeck: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-presenter-deck", projectPath),
  runMockAgent: (request: {
    projectPath: string;
    brief: string;
    runExport?: boolean;
    maxRepairRounds?: number;
    runId?: string;
  }) => ipcRenderer.invoke("htmlslide:run-mock-agent", request),
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
