import { describe, expect, it } from "vitest";
import { PresenterAsyncOperationGate } from "./presenter-window-lifecycle";

describe("PresenterAsyncOperationGate", () => {
  it("accepts only the latest operation", () => {
    const gate = new PresenterAsyncOperationGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("invalidates in-flight operations when the presenter closes", () => {
    const gate = new PresenterAsyncOperationGate();
    const operation = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(operation)).toBe(false);
  });
});
