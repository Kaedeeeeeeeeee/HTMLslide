import { describe, expect, it } from "vitest";
import { filterPresenterSlideIndices } from "./presenter-slide-search";

const slides = [
  { id: "intro", slideNumber: 1, title: "Opening" },
  { id: "market", slideNumber: 2, title: "Market sizing" },
  { id: "closing", slideNumber: 3, title: "Next steps" }
];

describe("filterPresenterSlideIndices", () => {
  it("returns every slide for an empty query", () => {
    expect(filterPresenterSlideIndices(slides, "  ")).toEqual([0, 1, 2]);
  });

  it("matches slide titles and ids case-insensitively", () => {
    expect(filterPresenterSlideIndices(slides, "MARKET")).toEqual([1]);
    expect(filterPresenterSlideIndices(slides, "closing")).toEqual([2]);
  });

  it("matches slide numbers and returns no false positives", () => {
    expect(filterPresenterSlideIndices(slides, "2")).toEqual([1]);
    expect(filterPresenterSlideIndices(slides, "roadmap")).toEqual([]);
  });
});
