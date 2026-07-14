import { describe, expect, it } from "vitest";
import { AudienceWindowOperationGate } from "./audience-window-lifecycle";

describe("AudienceWindowOperationGate", () => {
  it("keeps only the latest asynchronous window operation current", () => {
    const gate = new AudienceWindowOperationGate();
    const firstOperation = gate.begin();
    const secondOperation = gate.begin();

    expect(gate.isCurrent(firstOperation)).toBe(false);
    expect(gate.isCurrent(secondOperation)).toBe(true);
  });

  it("invalidates an in-flight operation when the audience window closes", () => {
    const gate = new AudienceWindowOperationGate();
    const operation = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(operation)).toBe(false);
  });
});
