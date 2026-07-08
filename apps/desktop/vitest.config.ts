import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    globals: true,
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"]
  }
});
