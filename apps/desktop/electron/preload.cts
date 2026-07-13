/* eslint-disable @typescript-eslint/no-require-imports */
import type * as Electron from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

contextBridge.exposeInMainWorld("htmlslideDesktop", {
  appName: "HTMLslide",
  platform: process.platform,
  shell: "electron",
  getSetup: () => ipcRenderer.invoke("htmlslide:get-setup"),
  completeOnboarding: () => ipcRenderer.invoke("htmlslide:complete-onboarding"),
  getCliIntegration: () => ipcRenderer.invoke("htmlslide:get-cli-integration"),
  installCliIntegration: () => ipcRenderer.invoke("htmlslide:install-cli-integration"),
  installOfficialSkills: () => ipcRenderer.invoke("htmlslide:install-official-skills"),
  removeOfficialSkill: (request: { name: string; confirmed?: boolean }) =>
    ipcRenderer.invoke("htmlslide:remove-official-skill", request),
  uninstallCliIntegration: () => ipcRenderer.invoke("htmlslide:uninstall-cli-integration"),
  copyCliManualInstallCommand: () => ipcRenderer.invoke("htmlslide:copy-cli-manual-install-command"),
  copyAgentRepairPrompt: (prompt: string) => ipcRenderer.invoke("htmlslide:copy-agent-repair-prompt", prompt),
  listProjects: () => ipcRenderer.invoke("htmlslide:list-projects"),
  removeRecentProject: (project: { id?: string; path?: string }) =>
    ipcRenderer.invoke("htmlslide:remove-recent-project", project),
  markRecentProjectMissing: (project: { id?: string; path?: string }) =>
    ipcRenderer.invoke("htmlslide:mark-recent-project-missing", project),
  getPresenterPreferences: (project: { id?: string; path?: string }) =>
    ipcRenderer.invoke("htmlslide:get-presenter-preferences", project),
  savePresenterPreferences: (
    project: { id?: string; path?: string },
    preferences: { recentSlideId?: string; notesFontSizePx?: number; selectedDisplay?: unknown }
  ) => ipcRenderer.invoke("htmlslide:save-presenter-preferences", project, preferences),
  getAiEngineSettings: () => ipcRenderer.invoke("htmlslide:get-ai-engine-settings"),
  saveAiEngineSettings: (request: { settings: unknown; apiKeyInput?: string; clearKey?: boolean }) =>
    ipcRenderer.invoke("htmlslide:save-ai-engine-settings", request),
  detectExternalAgents: () => ipcRenderer.invoke("htmlslide:detect-external-agents"),
  chooseSourceFiles: () => ipcRenderer.invoke("htmlslide:choose-source-files"),
  chooseWorkspace: () => ipcRenderer.invoke("htmlslide:choose-workspace"),
  openProjectDialog: () => ipcRenderer.invoke("htmlslide:open-project-dialog"),
  loadProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-project", projectPath),
  loadSlidePreview: (projectPath: string, slideId: string) =>
    ipcRenderer.invoke("htmlslide:load-slide-preview", projectPath, slideId),
  saveSlideNotes: (projectPath: string, slideId: string, content: string) =>
    ipcRenderer.invoke("htmlslide:save-slide-notes", projectPath, slideId, content),
  addQaIgnoreRule: (projectPath: string, issueType: string) =>
    ipcRenderer.invoke("htmlslide:add-qa-ignore-rule", projectPath, issueType),
  createProject: (request: unknown) => ipcRenderer.invoke("htmlslide:create-project", request),
  checkProject: (projectPath: string) => ipcRenderer.invoke("htmlslide:check-project", projectPath),
  exportProject: (projectPath: string, options?: unknown) => ipcRenderer.invoke("htmlslide:export-project", projectPath, options),
  loadPresenterDeck: (projectPath: string) => ipcRenderer.invoke("htmlslide:load-presenter-deck", projectPath),
  loadPresenterDeckPackage: (deckpkgPath: string) => ipcRenderer.invoke("htmlslide:load-presenter-deckpkg", deckpkgPath),
  onOpenRequest: (handler: (request: { kind: "deckpkg" | "project"; path: string; requestId: number }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: { kind: "deckpkg" | "project"; path: string; requestId: number }
    ) => handler(request);
    ipcRenderer.on("htmlslide:open-request", listener);
    void ipcRenderer.invoke("htmlslide:open-request-ready");
    return () => ipcRenderer.removeListener("htmlslide:open-request", listener);
  },
  reportSmokeReady: (marker: unknown) => ipcRenderer.invoke("htmlslide:report-smoke-ready", marker),
  listPresenterDisplays: () => ipcRenderer.invoke("htmlslide:list-presenter-displays"),
  onPresenterDisplaysChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("htmlslide:presenter-displays-changed", listener);
    return () => ipcRenderer.removeListener("htmlslide:presenter-displays-changed", listener);
  },
  onAudienceWindowStateChanged: (handler: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => handler(state);
    ipcRenderer.on("htmlslide:audience-window-state-changed", listener);
    return () => ipcRenderer.removeListener("htmlslide:audience-window-state-changed", listener);
  },
  openAudienceWindow: (request: unknown) => ipcRenderer.invoke("htmlslide:open-audience-window", request),
  updateAudienceWindow: (request: unknown) => ipcRenderer.invoke("htmlslide:update-audience-window", request),
  closeAudienceWindow: () => ipcRenderer.invoke("htmlslide:close-audience-window"),
  startAgentRun: (request: {
    engine: "mock-agent" | "htmlslide-agent" | "external-agent";
    exportOptions?: unknown;
    projectPath: string;
    brief: string;
    targetSlideCount?: number;
    runExport?: boolean;
    maxRepairRounds?: number;
    speakerNotesMode?: "none" | "bullet-notes" | "full-script" | "rehearsal-cues";
  }) => ipcRenderer.invoke("htmlslide:start-agent-run", request),
  getAgentRun: (runId: string) => ipcRenderer.invoke("htmlslide:get-agent-run", runId),
  getActiveAgentRun: (projectPath: string) => ipcRenderer.invoke("htmlslide:get-active-agent-run", projectPath),
  cancelAgentRun: (runId: string) => ipcRenderer.invoke("htmlslide:cancel-agent-run", runId),
  chooseVisualDirection: (runId: string, directionId: string) =>
    ipcRenderer.invoke("htmlslide:choose-visual-direction", runId, directionId),
  retryAgentRun: (runId: string) => ipcRenderer.invoke("htmlslide:retry-agent-run", runId),
  onAgentRunUpdate: (handler: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => handler(snapshot);
    ipcRenderer.on("htmlslide:agent-run-update", listener);
    return () => ipcRenderer.removeListener("htmlslide:agent-run-update", listener);
  },
  diffCheckpoint: (request: { projectPath: string; runId?: string; checkpointId?: string }) =>
    ipcRenderer.invoke("htmlslide:diff-checkpoint", request),
  revertCheckpoint: (request: { projectPath: string; runId?: string; checkpointId?: string; confirmed?: boolean }) =>
    ipcRenderer.invoke("htmlslide:revert-checkpoint", request)
});
