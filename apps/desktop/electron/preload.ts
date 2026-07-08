import { contextBridge, ipcRenderer } from "electron";
import process from "node:process";

contextBridge.exposeInMainWorld("htmlslideDesktop", {
  appName: "HTMLslide",
  platform: process.platform,
  shell: "electron",
  getSetup: () => ipcRenderer.invoke("htmlslide:get-setup"),
  listProjects: () => ipcRenderer.invoke("htmlslide:list-projects"),
  chooseWorkspace: () => ipcRenderer.invoke("htmlslide:choose-workspace"),
  openProjectDialog: () => ipcRenderer.invoke("htmlslide:open-project-dialog"),
  loadProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-project", projectPath),
  createProject: (request: { name: string; workspacePath?: string }) =>
    ipcRenderer.invoke("htmlslide:create-project", request),
  checkProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:check-project", projectPath),
  exportProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:export-project", projectPath)
});
