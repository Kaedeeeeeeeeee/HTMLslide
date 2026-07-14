const BASE_AUTOMATED_GATES = [
  "pnpm docs:check",
  "pnpm docs:build",
  "pnpm version:check",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm test:coverage",
  "pnpm test:visual:browser",
  "pnpm perf:smoke",
  "pnpm security:check",
  "pnpm build",
  "pnpm e2e:desktop",
  "pnpm e2e:desktop:a11y",
  "Package workflow completed for this commit/tag.",
  "Package smoke completed against the exact artifact under test."
];

export function automatedGateEntries(channel) {
  if (channel === "release") {
    return [...BASE_AUTOMATED_GATES, "Release macOS completed with signed, notarized, stapled manifest."];
  }

  return [...BASE_AUTOMATED_GATES];
}
