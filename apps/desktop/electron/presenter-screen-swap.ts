export type PresenterWindowRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PresenterScreenDisplay = {
  id: number;
  workArea: PresenterWindowRectangle;
};

export type PresenterScreenSwapWindow = {
  getBounds(): PresenterWindowRectangle;
  getNormalBounds(): PresenterWindowRectangle;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  isVisible(): boolean;
  setFullScreen(fullScreen: boolean): void;
  maximize(): void;
  unmaximize(): void;
  setBounds(bounds: PresenterWindowRectangle): void;
};

export type PresenterScreenSwapErrorCode =
  | "main-window-unavailable"
  | "audience-window-unavailable"
  | "audience-state-mismatch"
  | "same-display"
  | "target-disconnected"
  | "swap-failed";

export type PresenterScreenSwapResult =
  | {
      ok: true;
      selectedDisplayId: number;
      audienceDisplayId: number;
      mainDisplayId: number;
    }
  | {
      ok: false;
      selectedDisplayId?: number;
      audienceDisplayId?: number;
      mainDisplayId?: number;
      error: {
        code: PresenterScreenSwapErrorCode;
        message: string;
      };
    };

export type PresenterScreenSwapEnvironment = {
  mainWindow?: PresenterScreenSwapWindow;
  audienceWindow?: PresenterScreenSwapWindow;
  audienceDisplayId?: number;
  selectedDisplayId: number;
  getAllDisplays(): readonly PresenterScreenDisplay[];
  getDisplayMatching(bounds: PresenterWindowRectangle): PresenterScreenDisplay;
  getAudienceTargetBounds(displayId: number): PresenterWindowRectangle | undefined;
  restoreMainWindowPresentation: (
    window: PresenterScreenSwapWindow,
    bounds: PresenterWindowRectangle,
    wasFullScreen: boolean,
    wasMaximized: boolean
  ) => void;
  restoreAudienceWindowPresentation: (
    window: PresenterScreenSwapWindow,
    bounds: PresenterWindowRectangle,
    wasFullScreen: boolean
  ) => void;
};

export type PresenterScreenSwapMutation = {
  originalMainBounds: PresenterWindowRectangle;
  originalMainWindowedBounds: PresenterWindowRectangle;
  originalAudienceBounds: PresenterWindowRectangle;
  originalAudienceWindowedBounds?: PresenterWindowRectangle;
  mainTargetBounds: PresenterWindowRectangle;
  audienceTargetBounds: PresenterWindowRectangle;
  mainWasFullScreen: boolean;
  mainWasMaximized: boolean;
  audienceWasFullScreen?: boolean;
  restoreMainWindowPresentation: (
    bounds: PresenterWindowRectangle,
    wasFullScreen: boolean,
    wasMaximized: boolean
  ) => void;
  setMainBounds: (bounds: PresenterWindowRectangle) => void;
  setAudienceBounds: (bounds: PresenterWindowRectangle) => void;
  restoreAudienceWindowPresentation?: (bounds: PresenterWindowRectangle, wasFullScreen: boolean) => void;
};

export type PresenterScreenSwapMutationResult =
  | { ok: true }
  | { error: unknown; ok: false };

function isUsableRectangle(bounds: PresenterWindowRectangle): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

export function centerPresenterWindowInWorkArea(
  windowedBounds: PresenterWindowRectangle,
  workArea: PresenterWindowRectangle
): PresenterWindowRectangle | undefined {
  if (!isUsableRectangle(windowedBounds) || !isUsableRectangle(workArea)) {
    return undefined;
  }

  const workAreaWidth = Math.round(workArea.width);
  const workAreaHeight = Math.round(workArea.height);
  const width = Math.min(Math.max(1, Math.round(windowedBounds.width)), workAreaWidth);
  const height = Math.min(Math.max(1, Math.round(windowedBounds.height)), workAreaHeight);
  return {
    height,
    width,
    x: Math.round(workArea.x + (workAreaWidth - width) / 2),
    y: Math.round(workArea.y + (workAreaHeight - height) / 2)
  };
}

export function executePresenterScreenSwap(
  environment: PresenterScreenSwapEnvironment
): PresenterScreenSwapResult {
  const {
    audienceDisplayId,
    audienceWindow,
    mainWindow,
    selectedDisplayId
  } = environment;

  if (!mainWindow) {
    return presenterScreenSwapFailure(
      "main-window-unavailable",
      "Swap screens is unavailable because the main HTMLslide window is not open."
    );
  }

  if (!audienceWindow || audienceDisplayId === undefined) {
    return presenterScreenSwapFailure(
      "audience-window-unavailable",
      "Open the Audience window before swapping screens.",
      { selectedDisplayId }
    );
  }

  if (selectedDisplayId !== audienceDisplayId) {
    return presenterScreenSwapFailure(
      "audience-state-mismatch",
      "Audience is no longer open on the selected display. Refresh the display list and try again.",
      {
        audienceDisplayId,
        selectedDisplayId
      }
    );
  }

  const connectedDisplaysBeforeVisibilityCheck = environment.getAllDisplays();
  if (!connectedDisplaysBeforeVisibilityCheck.some((display) => display.id === audienceDisplayId)) {
    return presenterScreenSwapFailure(
      "target-disconnected",
      "The Audience display is disconnected. Reconnect it and refresh the display list.",
      {
        audienceDisplayId,
        selectedDisplayId
      }
    );
  }

  if (!audienceWindow.isVisible()) {
    return presenterScreenSwapFailure(
      "audience-window-unavailable",
      "Audience is not currently visible. Reopen the Audience window before swapping screens.",
      {
        audienceDisplayId,
        selectedDisplayId
      }
    );
  }

  let mainDisplay: PresenterScreenDisplay;
  let originalMainBounds: PresenterWindowRectangle;
  let originalMainWindowedBounds: PresenterWindowRectangle;
  let originalAudienceBounds: PresenterWindowRectangle;
  let originalAudienceWindowedBounds: PresenterWindowRectangle;
  let mainWasFullScreen: boolean;
  let mainWasMaximized: boolean;
  let audienceWasFullScreen: boolean;
  try {
    originalMainBounds = mainWindow.getBounds();
    originalMainWindowedBounds = mainWindow.getNormalBounds();
    originalAudienceBounds = audienceWindow.getBounds();
    originalAudienceWindowedBounds = audienceWindow.getNormalBounds();
    mainWasFullScreen = mainWindow.isFullScreen();
    mainWasMaximized = mainWindow.isMaximized();
    audienceWasFullScreen = audienceWindow.isFullScreen();
    mainDisplay = environment.getDisplayMatching(originalMainBounds);
  } catch {
    return presenterScreenSwapFailure(
      "main-window-unavailable",
      "The main HTMLslide window could not be inspected safely."
    );
  }

  const displays = environment.getAllDisplays();
  const audienceDisplay = displays.find((display) => display.id === audienceDisplayId);
  if (!audienceDisplay || !displays.some((display) => display.id === mainDisplay.id)) {
    return presenterScreenSwapFailure(
      "target-disconnected",
      "One of the target displays is disconnected. Reconnect it and refresh the display list.",
      {
        audienceDisplayId,
        mainDisplayId: mainDisplay.id,
        selectedDisplayId
      }
    );
  }

  if (mainDisplay.id === audienceDisplay.id) {
    return presenterScreenSwapFailure(
      "same-display",
      "Swap screens requires the main and Audience windows to be on different displays.",
      {
        audienceDisplayId: audienceDisplay.id,
        mainDisplayId: mainDisplay.id,
        selectedDisplayId
      }
    );
  }

  const mainTargetBounds = centerPresenterWindowInWorkArea(
    originalMainWindowedBounds,
    audienceDisplay.workArea
  );
  const audienceTargetBounds = environment.getAudienceTargetBounds(mainDisplay.id);
  if (!mainTargetBounds || !audienceTargetBounds) {
    return presenterScreenSwapFailure(
      "target-disconnected",
      "The target display does not have usable bounds for a screen swap.",
      {
        audienceDisplayId: audienceDisplay.id,
        mainDisplayId: mainDisplay.id,
        selectedDisplayId
      }
    );
  }

  const mutation = applyPresenterScreenSwapMutation({
    audienceTargetBounds,
    audienceWasFullScreen,
    mainTargetBounds,
    mainWasFullScreen,
    mainWasMaximized,
    originalAudienceBounds,
    originalAudienceWindowedBounds,
    originalMainBounds,
    originalMainWindowedBounds,
    restoreAudienceWindowPresentation: (bounds, wasFullScreen) =>
      environment.restoreAudienceWindowPresentation(audienceWindow, bounds, wasFullScreen),
    restoreMainWindowPresentation: (bounds, wasFullScreen, wasMaximized) =>
      environment.restoreMainWindowPresentation(mainWindow, bounds, wasFullScreen, wasMaximized),
    setAudienceBounds: (bounds) => audienceWindow.setBounds(bounds),
    setMainBounds: (bounds) => mainWindow.setBounds(bounds)
  });
  if (!mutation.ok) {
    return presenterScreenSwapFailure(
      "swap-failed",
      `Screen swap failed without changing the selected display: ${mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}`,
      {
        audienceDisplayId,
        mainDisplayId: mainDisplay.id,
        selectedDisplayId
      }
    );
  }

  return {
    audienceDisplayId: mainDisplay.id,
    mainDisplayId: audienceDisplay.id,
    ok: true,
    selectedDisplayId: mainDisplay.id
  };
}

export function applyPresenterScreenSwapMutation(
  mutation: PresenterScreenSwapMutation
): PresenterScreenSwapMutationResult {
  try {
    if (mutation.mainWasFullScreen || mutation.mainWasMaximized) {
      mutation.restoreMainWindowPresentation(mutation.originalMainWindowedBounds, false, false);
    }
    if (mutation.audienceWasFullScreen && mutation.restoreAudienceWindowPresentation && mutation.originalAudienceWindowedBounds) {
      mutation.restoreAudienceWindowPresentation(mutation.originalAudienceWindowedBounds, false);
    }
    mutation.setMainBounds(mutation.mainTargetBounds);
    mutation.setAudienceBounds(mutation.audienceTargetBounds);
    if (mutation.mainWasFullScreen || mutation.mainWasMaximized) {
      mutation.restoreMainWindowPresentation(
        mutation.mainTargetBounds,
        mutation.mainWasFullScreen,
        mutation.mainWasMaximized
      );
    }
    if (mutation.audienceWasFullScreen && mutation.restoreAudienceWindowPresentation) {
      mutation.restoreAudienceWindowPresentation(mutation.audienceTargetBounds, true);
    }
    return { ok: true };
  } catch (error: unknown) {
    try {
      mutation.restoreMainWindowPresentation(
        mutation.originalMainWindowedBounds,
        mutation.mainWasFullScreen,
        mutation.mainWasMaximized
      );
    } catch {
      try {
        mutation.setMainBounds(mutation.originalMainBounds);
      } catch {
        // Best-effort rollback; the caller still reports the failed swap.
      }
    }
    try {
      if (mutation.restoreAudienceWindowPresentation && mutation.originalAudienceWindowedBounds) {
        mutation.restoreAudienceWindowPresentation(
          mutation.originalAudienceWindowedBounds,
          mutation.audienceWasFullScreen === true
        );
      } else {
        mutation.setAudienceBounds(mutation.originalAudienceBounds);
      }
    } catch {
      // Best-effort rollback; the caller still reports the failed swap.
    }
    return { error, ok: false };
  }
}

function presenterScreenSwapFailure(
  code: PresenterScreenSwapErrorCode,
  message: string,
  state: Omit<Extract<PresenterScreenSwapResult, { ok: false }>, "ok" | "error"> = {}
): PresenterScreenSwapResult {
  return {
    ...state,
    error: { code, message },
    ok: false
  };
}
