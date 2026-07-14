import { describe, expect, it } from "vitest";
import {
  applyPresenterScreenSwapMutation,
  centerPresenterWindowInWorkArea
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
