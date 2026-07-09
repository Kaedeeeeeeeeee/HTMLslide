import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@htmlslide/agent",
        replacement: fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url))
      },
      {
        find: "@htmlslide/core/templates",
        replacement: fileURLToPath(new URL("../../packages/core/src/templates.ts", import.meta.url))
      }
    ]
  },
  test: {
    environment: "node",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    globals: true,
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"]
  }
});
