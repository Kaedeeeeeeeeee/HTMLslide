export type PresenterWindowRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
