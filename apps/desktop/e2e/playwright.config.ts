import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, "..", "..", "..");

export default defineConfig({
  testDir: e2eDir,
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  outputDir: path.join(repoRoot, "tmp", "playwright", "desktop-e2e-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(repoRoot, "tmp", "playwright", "desktop-e2e-report")
      }
    ]
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  }
});
