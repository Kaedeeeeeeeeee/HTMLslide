import { describe, expect, it } from "vitest";
import { centerPresenterWindowInWorkArea } from "./presenter-screen-swap";

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
});
