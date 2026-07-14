export type PresenterWindowRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PresenterScreenSwapMutation = {
  originalMainBounds: PresenterWindowRectangle;
  originalMainWindowedBounds: PresenterWindowRectangle;
  originalAudienceBounds: PresenterWindowRectangle;
  mainTargetBounds: PresenterWindowRectangle;
  audienceTargetBounds: PresenterWindowRectangle;
  mainWasFullScreen: boolean;
  mainWasMaximized: boolean;
  restoreMainWindowPresentation: (
    bounds: PresenterWindowRectangle,
    wasFullScreen: boolean,
    wasMaximized: boolean
  ) => void;
  setMainBounds: (bounds: PresenterWindowRectangle) => void;
  setAudienceBounds: (bounds: PresenterWindowRectangle) => void;
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

export function applyPresenterScreenSwapMutation(
  mutation: PresenterScreenSwapMutation
): PresenterScreenSwapMutationResult {
  try {
    if (mutation.mainWasFullScreen || mutation.mainWasMaximized) {
      mutation.restoreMainWindowPresentation(mutation.originalMainWindowedBounds, false, false);
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
      mutation.setAudienceBounds(mutation.originalAudienceBounds);
    } catch {
      // Best-effort rollback; the caller still reports the failed swap.
    }
    return { error, ok: false };
  }
}
