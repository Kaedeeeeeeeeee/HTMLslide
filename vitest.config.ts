import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@htmlslide/agent",
        replacement: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url))
      },
      {
        find: "@htmlslide/agent-adapters",
        replacement: fileURLToPath(new URL("./packages/agent-adapters/src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
