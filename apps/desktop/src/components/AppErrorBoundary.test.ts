import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, copyErrorSummary, SAFE_ERROR_SUMMARY } from "./AppErrorBoundary";

describe("AppErrorBoundary", () => {
  it("renders an accessible safe fallback after a rendering error", () => {
    const boundary = new AppErrorBoundary({
      children: React.createElement("div", null, "App content")
    });

    boundary.state = {
      ...boundary.state,
      ...AppErrorBoundary.getDerivedStateFromError()
    };

    const markup = renderToStaticMarkup(boundary.render());

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("HTMLslide needs to restart");
    expect(markup).toContain("Reload app");
    expect(markup).toContain("Copy error summary");
    expect(markup).not.toContain("/Users/alice");
    expect(markup).not.toContain("intro.html");
    expect(markup).not.toContain("sk-live-secret");
    expect(markup).not.toContain("failed at");
  });

  it("copies only the fixed safe summary", async () => {
    const writeText = vi.fn(async (): Promise<void> => undefined);

    await expect(copyErrorSummary({ writeText })).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith(SAFE_ERROR_SUMMARY);
    expect(SAFE_ERROR_SUMMARY).not.toContain("/");
    expect(SAFE_ERROR_SUMMARY).not.toContain("sk-");
  });

  it("turns clipboard failures into a handled result", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard blocked at /Users/alice"));

    await expect(copyErrorSummary({ writeText })).resolves.toBe(false);
  });
});
