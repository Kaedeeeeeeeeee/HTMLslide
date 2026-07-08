import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
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
