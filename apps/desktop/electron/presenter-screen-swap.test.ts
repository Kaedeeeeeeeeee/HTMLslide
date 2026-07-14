import { describe, expect, it } from "vitest";
import {
  applyPresenterScreenSwapMutation,
  centerPresenterWindowInWorkArea,
  executePresenterScreenSwap,
  type PresenterScreenSwapWindow
} from "./presenter-screen-swap";

describe("presenter screen swap geometry", () => {
  it("centers the main window in the target display work area", () => {
    expect(centerPresenterWindowInWorkArea(
      { x: 40, y: 80, width: 1200, height: 800 },
      { x: 1920, y: 40, width: 2560, height: 1400 }
    )).toEqual({
      x: 2600,
      y: 340,
      width: 1200,
      height: 800
    });
  });

  it("clamps a window larger than the target work area", () => {
    expect(centerPresenterWindowInWorkArea(
      { x: 0, y: 0, width: 3000, height: 1800 },
      { x: -1280, y: 0, width: 1280, height: 720 }
    )).toEqual({
      x: -1280,
      y: 0,
      width: 1280,
      height: 720
    });
  });

  it("rejects unusable display or window bounds", () => {
    expect(centerPresenterWindowInWorkArea(
      { x: 0, y: 0, width: 0, height: 800 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    )).toBeUndefined();
    expect(centerPresenterWindowInWorkArea(
      { x: 0, y: 0, width: 1200, height: 800 },
      { x: 0, y: 0, width: Number.NaN, height: 1080 }
    )).toBeUndefined();
  });

  it("applies a swap mutation and restores presentation state after moving bounds", () => {
    const calls: string[] = [];
    const result = applyPresenterScreenSwapMutation({
      audienceTargetBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      mainTargetBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      mainWasFullScreen: true,
      mainWasMaximized: false,
      originalAudienceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      originalMainBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      originalMainWindowedBounds: { x: 2000, y: 40, width: 1200, height: 800 },
      restoreMainWindowPresentation: (bounds, wasFullScreen, wasMaximized) => {
        calls.push(`restore:${bounds.x}:${wasFullScreen}:${wasMaximized}`);
      },
      setAudienceBounds: (bounds) => calls.push(`audience:${bounds.x}`),
      setMainBounds: (bounds) => calls.push(`main:${bounds.x}`)
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      "restore:2000:false:false",
      "main:0",
      "audience:1920",
      "restore:0:true:false"
    ]);
  });

  it("rolls back both windows when a target move fails", () => {
    const calls: string[] = [];
    const result = applyPresenterScreenSwapMutation({
      audienceTargetBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      mainTargetBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      mainWasFullScreen: false,
      mainWasMaximized: false,
      originalAudienceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      originalMainBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      originalMainWindowedBounds: { x: 1920, y: 0, width: 1200, height: 800 },
      restoreMainWindowPresentation: (bounds) => calls.push(`restore:${bounds.x}`),
      setAudienceBounds: (bounds) => {
        calls.push(`audience:${bounds.x}`);
        if (bounds.x === 1920) {
          throw new Error("display move failed");
        }
      },
      setMainBounds: (bounds) => calls.push(`main:${bounds.x}`)
    });

    expect(result).toMatchObject({ ok: false, error: new Error("display move failed") });
    expect(calls).toEqual([
      "main:0",
      "audience:1920",
      "restore:1920",
      "audience:0"
    ]);
  });

  it("restores native Audience fullscreen after moving both windows", () => {
    const calls: string[] = [];
    const result = applyPresenterScreenSwapMutation({
      audienceTargetBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      audienceWasFullScreen: true,
      mainTargetBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      mainWasFullScreen: false,
      mainWasMaximized: false,
      originalAudienceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      originalAudienceWindowedBounds: { x: 20, y: 30, width: 1200, height: 800 },
      originalMainBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      originalMainWindowedBounds: { x: 1920, y: 40, width: 1200, height: 800 },
      restoreAudienceWindowPresentation: (bounds, wasFullScreen) =>
        calls.push(`audience-restore:${bounds.x}:${wasFullScreen}`),
      restoreMainWindowPresentation: () => undefined,
      setAudienceBounds: (bounds) => calls.push(`audience:${bounds.x}`),
      setMainBounds: (bounds) => calls.push(`main:${bounds.x}`)
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      "audience-restore:20:false",
      "main:0",
      "audience:1920",
      "audience-restore:1920:true"
    ]);
  });

  it("restores Audience fullscreen state when a swap fails", () => {
    const calls: string[] = [];
    const result = applyPresenterScreenSwapMutation({
      audienceTargetBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      audienceWasFullScreen: true,
      mainTargetBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      mainWasFullScreen: false,
      mainWasMaximized: false,
      originalAudienceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      originalAudienceWindowedBounds: { x: 20, y: 30, width: 1200, height: 800 },
      originalMainBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      originalMainWindowedBounds: { x: 1920, y: 40, width: 1200, height: 800 },
      restoreAudienceWindowPresentation: (bounds, wasFullScreen) =>
        calls.push(`audience-restore:${bounds.x}:${wasFullScreen}`),
      restoreMainWindowPresentation: () => undefined,
      setAudienceBounds: () => {
        throw new Error("display move failed");
      },
      setMainBounds: (bounds) => calls.push(`main:${bounds.x}`)
    });

    expect(result).toMatchObject({ ok: false, error: new Error("display move failed") });
    expect(calls).toEqual([
      "audience-restore:20:false",
      "main:0",
      "audience-restore:20:true"
    ]);
  });
});

type FakeWindowState = {
  bounds: { x: number; y: number; width: number; height: number };
  normalBounds: { x: number; y: number; width: number; height: number };
  fullScreen: boolean;
  maximized: boolean;
  visible: boolean;
};

function createFakeWindow(
  initial: Partial<FakeWindowState> = {},
  calls: string[] = []
): PresenterScreenSwapWindow & { state: FakeWindowState } {
  const state: FakeWindowState = {
    bounds: initial.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 },
    normalBounds: initial.normalBounds ?? { x: 40, y: 40, width: 1200, height: 800 },
    fullScreen: initial.fullScreen ?? false,
    maximized: initial.maximized ?? false,
    visible: initial.visible ?? true
  };

  return {
    state,
    getBounds: () => state.bounds,
    getNormalBounds: () => state.normalBounds,
    isFullScreen: () => state.fullScreen,
    isMaximized: () => state.maximized,
    isVisible: () => state.visible,
    maximize: () => {
      calls.push("maximize");
      state.maximized = true;
    },
    setFullScreen: (fullScreen) => {
      calls.push(`set-fullscreen:${fullScreen}`);
      state.fullScreen = fullScreen;
    },
    setBounds: (bounds) => {
      calls.push(`set-bounds:${bounds.x}:${bounds.y}`);
      state.bounds = bounds;
    },
    unmaximize: () => {
      calls.push("unmaximize");
      state.maximized = false;
    }
  };
}

function createSwapEnvironment(options: {
  mainWindow?: PresenterScreenSwapWindow;
  audienceWindow?: PresenterScreenSwapWindow;
  audienceDisplayId?: number;
  selectedDisplayId?: number;
  displays?: ReadonlyArray<{
    id: number;
    workArea: { x: number; y: number; width: number; height: number };
  }>;
  audienceTargetBounds?: { x: number; y: number; width: number; height: number };
  calls?: string[];
}) {
  const calls = options.calls ?? [];
  const displays = options.displays ?? [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }
  ];
  return {
    audienceDisplayId: options.audienceDisplayId,
    audienceWindow: options.audienceWindow,
    getAllDisplays: () => displays,
    getAudienceTargetBounds: () => options.audienceTargetBounds ?? { x: 0, y: 0, width: 1920, height: 1080 },
    getDisplayMatching: () => displays[0]!,
    mainWindow: options.mainWindow,
    restoreAudienceWindowPresentation: (window: PresenterScreenSwapWindow, bounds, fullScreen) => {
      calls.push(`restore-audience:${bounds.x}:${fullScreen}`);
      if (window.isFullScreen()) {
        window.setFullScreen(false);
      }
      window.setBounds(bounds);
      if (fullScreen) {
        window.setFullScreen(true);
      }
    },
    restoreMainWindowPresentation: (window: PresenterScreenSwapWindow, bounds, fullScreen, maximized) => {
      calls.push(`restore-main:${bounds.x}:${fullScreen}:${maximized}`);
      if (window.isFullScreen()) {
        window.setFullScreen(false);
      }
      if (window.isMaximized()) {
        window.unmaximize();
      }
      window.setBounds(bounds);
      if (fullScreen) {
        window.setFullScreen(true);
      } else if (maximized) {
        window.maximize();
      }
    },
    selectedDisplayId: options.selectedDisplayId ?? options.audienceDisplayId ?? 1
  };
}

describe("presenter screen swap integration contract", () => {
  it("moves both windows and returns the new display roles", () => {
    const calls: string[] = [];
    const mainWindow = createFakeWindow({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      fullScreen: true
    }, calls);
    const audienceWindow = createFakeWindow({
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      normalBounds: { x: 1960, y: 40, width: 1200, height: 800 },
      fullScreen: true
    }, calls);
    const result = executePresenterScreenSwap(createSwapEnvironment({
      audienceDisplayId: 2,
      audienceWindow,
      calls,
      mainWindow,
      selectedDisplayId: 2
    }));

    expect(result).toEqual({
      audienceDisplayId: 1,
      mainDisplayId: 2,
      ok: true,
      selectedDisplayId: 1
    });
    expect(calls).toEqual([
      "restore-main:40:false:false",
      "set-fullscreen:false",
      "set-bounds:40:40",
      "restore-audience:1960:false",
      "set-fullscreen:false",
      "set-bounds:1960:40",
      "set-bounds:2600:300",
      "set-bounds:0:0",
      "restore-main:2600:true:false",
      "set-bounds:2600:300",
      "set-fullscreen:true",
      "restore-audience:0:true",
      "set-bounds:0:0",
      "set-fullscreen:true"
    ]);
    expect(mainWindow.state).toMatchObject({
      bounds: { x: 2600, y: 300, width: 1200, height: 800 },
      fullScreen: true
    });
    expect(audienceWindow.state).toMatchObject({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      fullScreen: true
    });
  });

  it.each([
    ["missing main window", { audienceDisplayId: 2, selectedDisplayId: 2 }, "main-window-unavailable"],
    ["missing Audience window", { mainWindow: createFakeWindow(), audienceDisplayId: 2, selectedDisplayId: 2 }, "audience-window-unavailable"],
    ["stale selected display", { mainWindow: createFakeWindow(), audienceWindow: createFakeWindow(), audienceDisplayId: 2, selectedDisplayId: 1 }, "audience-state-mismatch"],
    ["disconnected Audience display", { mainWindow: createFakeWindow(), audienceWindow: createFakeWindow(), audienceDisplayId: 2, selectedDisplayId: 2, displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] }, "target-disconnected"]
  ] as const)("rejects %s before mutation", (_label, options, code) => {
    const calls: string[] = [];
    const result = executePresenterScreenSwap(createSwapEnvironment({ ...options, calls }));

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(calls).toEqual([]);
  });

  it("rejects a hidden Audience window and a same-display placement", () => {
    const hiddenAudience = createFakeWindow({ visible: false });
    expect(executePresenterScreenSwap(createSwapEnvironment({
      audienceDisplayId: 2,
      audienceWindow: hiddenAudience,
      mainWindow: createFakeWindow(),
      selectedDisplayId: 2
    }))).toMatchObject({ ok: false, error: { code: "audience-window-unavailable" } });

    const sameDisplayWindow = createFakeWindow({ bounds: { x: 100, y: 100, width: 1200, height: 800 } });
    expect(executePresenterScreenSwap(createSwapEnvironment({
      audienceDisplayId: 1,
      audienceWindow: sameDisplayWindow,
      mainWindow: createFakeWindow(),
      selectedDisplayId: 1
    }))).toMatchObject({ ok: false, error: { code: "same-display" } });
  });

  it("reports a move failure after rolling both windows back", () => {
    const calls: string[] = [];
    const mainWindow = createFakeWindow({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      normalBounds: { x: 0, y: 0, width: 1920, height: 1080 }
    }, calls);
    const audienceWindow = createFakeWindow({
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      normalBounds: { x: 1920, y: 0, width: 2560, height: 1440 }
    }, calls);
    const originalSetBounds = audienceWindow.setBounds;
    audienceWindow.setBounds = (bounds) => {
      if (bounds.x === 0) {
        throw new Error("audience move failed");
      }
      originalSetBounds(bounds);
    };

    const result = executePresenterScreenSwap(createSwapEnvironment({
      audienceDisplayId: 2,
      audienceWindow,
      calls,
      mainWindow,
      selectedDisplayId: 2
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "swap-failed", message: expect.stringContaining("audience move failed") } });
    expect(mainWindow.state.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(audienceWindow.state.bounds).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
  });
});
