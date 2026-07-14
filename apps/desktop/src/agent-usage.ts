import type { DesktopTokenUsage } from "./desktop-api";

export function formatTokenCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }

  const decimals = value >= 10000 ? 0 : 1;
  return `${(value / 1000).toFixed(decimals).replace(/\.0$/u, "")}k`;
}

export function formatAgentTokenUsage(usage: DesktopTokenUsage): string {
  const parts: string[] = [];
  if (typeof usage.totalTokens === "number") {
    parts.push(`${formatTokenCount(usage.totalTokens)} total`);
  }
  if (typeof usage.inputTokens === "number") {
    parts.push(`${formatTokenCount(usage.inputTokens)} in`);
  }
  if (typeof usage.outputTokens === "number") {
    parts.push(`${formatTokenCount(usage.outputTokens)} out`);
  }

  return parts.length > 0 ? parts.join(" / ") : "Unavailable";
}
