import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@htmlslide/agent",
        replacement: fileURLToPath(
          new URL("../../packages/agent/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@htmlslide/agent-adapters",
        replacement: fileURLToPath(
          new URL("../../packages/agent-adapters/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@htmlslide/core/templates",
        replacement: fileURLToPath(
          new URL("../../packages/core/src/templates.ts", import.meta.url)
        )
      },
      {
        find: "@htmlslide/core/version",
        replacement: fileURLToPath(
          new URL("../../packages/core/src/version.ts", import.meta.url)
        )
      },
      {
        find: "@htmlslide/presenter/session",
        replacement: fileURLToPath(
          new URL("../../packages/presenter/src/session.ts", import.meta.url)
        )
      },
      {
        find: "@htmlslide/shared-ui/styles.css",
        replacement: fileURLToPath(
          new URL("../../packages/shared-ui/src/styles.css", import.meta.url)
        )
      },
      {
        find: "@htmlslide/shared-ui",
        replacement: fileURLToPath(
          new URL("../../packages/shared-ui/src/index.ts", import.meta.url)
        )
      }
    ]
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true
  }
});
