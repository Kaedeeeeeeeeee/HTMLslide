import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const electronTsconfigPath = fileURLToPath(new URL("../electron/tsconfig.json", import.meta.url));
const electronMainPath = fileURLToPath(new URL("../dist/electron/main.js", import.meta.url));

const electronBuild = spawn("tsc", ["-p", electronTsconfigPath], {
  stdio: "inherit"
});

await new Promise<void>((resolve, reject) => {
  electronBuild.once("exit", (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`Electron main process TypeScript build failed with exit code ${code ?? 1}.`));
  });
});

const rendererServer = await createServer({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname
});

await rendererServer.listen();

const resolvedUrls = rendererServer.resolvedUrls?.local ?? [];
const devServerUrl = resolvedUrls[0] ?? "http://127.0.0.1:5173/";

const electronProcess = spawn(
  "electron",
  ["--inspect=5858", electronMainPath],
  {
    env: {
      ...process.env,
      HTMLSLIDE_DESKTOP_DEV_SERVER_URL: devServerUrl
    },
    stdio: "inherit"
  }
);

const shutdown = async (): Promise<void> => {
  electronProcess.kill();
  await rendererServer.close();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

electronProcess.once("exit", (code) => {
  void rendererServer.close().finally(() => process.exit(code ?? 0));
});
