/* eslint-disable @typescript-eslint/no-require-imports */
import type * as Electron from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

contextBridge.exposeInMainWorld("htmlslideDesktop", {
  appName: "HTMLslide",
  platform: process.platform,
  shell: "electron",
  getSetup: () => ipcRenderer.invoke("htmlslide:get-setup"),
  listProjects: () => ipcRenderer.invoke("htmlslide:list-projects"),
  getAiEngineSettings: () => ipcRenderer.invoke("htmlslide:get-ai-engine-settings"),
  saveAiEngineSettings: (settings: unknown) => ipcRenderer.invoke("htmlslide:save-ai-engine-settings", settings),
  detectExternalAgents: () => ipcRenderer.invoke("htmlslide:detect-external-agents"),
  chooseWorkspace: () => ipcRenderer.invoke("htmlslide:choose-workspace"),
  openProjectDialog: () => ipcRenderer.invoke("htmlslide:open-project-dialog"),
  loadProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-project", projectPath),
  createProject: (request: { name: string; workspacePath?: string }) =>
    ipcRenderer.invoke("htmlslide:create-project", request),
  checkProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:check-project", projectPath),
  exportProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:export-project", projectPath)
});
