import { describe, expect, it } from "vitest";
import { formatAgentTokenUsage, formatTokenCount } from "./agent-usage";

describe("agent usage formatting", () => {
  it("keeps small counts readable and abbreviates large counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(12_000)).toBe("12k");
  });

  it("formats the provider usage summary without estimating cost", () => {
    expect(formatAgentTokenUsage({ inputTokens: 1_234, outputTokens: 567, totalTokens: 1_801 })).toBe(
      "1.8k total / 1.2k in / 567 out"
    );
    expect(formatAgentTokenUsage({})).toBe("Unavailable");
  });
});
