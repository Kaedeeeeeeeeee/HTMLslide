import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkLoadedProject,
  createProject,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  getCliShimStatus,
  installCliShim,
  loadProject,
  tryLoadProjectForCheck,
  uninstallCliShim
} from "../src/index";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cliBin = path.join(repoRoot, "packages", "cli", "src", "bin", "htmlslide.ts");

const writeExecutable = async (filePath: string, source: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source, { mode: 0o755 });
};

const fakeCliSource = (source: string): string => `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ source: ${JSON.stringify(source)}, args: process.argv.slice(2) }) + "\\n");
`;

const expectMissing = async (filePath: string): Promise<void> => {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
};

const runCli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileAsync(tsxBin, [cliBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    timeout: 10000
  });

describe("CLI project helpers", () => {
  it("creates, checks, and exports a default deck project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const report = await checkLoadedProject(project);
      expect(report.status).toBe("passed");
      expect(report.summary.errors).toBe(0);

      const exported = await exportLoadedProject(project);
      expect(exported.artifacts.pdf).toBeTruthy();
      expect(exported.artifacts.html).toBeTruthy();
      expect(exported.artifacts.deckpkg).toBeTruthy();
      expect(exported.artifacts.thumbnails).toHaveLength(2);

      const deckJson = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(deckJson.schemaVersion).toBe("0.1.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers the deck project from nested project paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const nestedSlidePath = path.join(project.projectPath, "slides", "001-title.html");
      const loaded = await loadProject(nestedSlidePath);

      expect(loaded.projectPath).toBe(project.projectPath);
      expect(loaded.manifest.id).toBe(project.manifest.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a machine-readable report when project loading fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const loaded = await tryLoadProjectForCheck(path.join(root, "missing"));

      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("Expected project load to fail");
      }
      expect(loaded.report.status).toBe("failed");
      expect(loaded.report.summary.errors).toBeGreaterThan(0);
      expect(loaded.report.issues[0]?.agentInstruction).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects export option flags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const exported = await exportLoadedProject(project, {
        pdf: false,
        deckpkg: false,
        html: true,
        thumbnails: false
      });

      expect(exported.artifacts.pdf).toBeUndefined();
      expect(exported.artifacts.deckpkg).toBeUndefined();
      expect(exported.artifacts.thumbnails).toBeUndefined();
      expect(exported.artifacts.html).toBeTruthy();
      expect(exported.artifacts.notes).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs a managed CLI shim to an explicit target dir and uses the fallback CLI path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const binDir = path.join(root, "bin");
      const homeDir = path.join(root, "state");
      const fallbackCliPath = path.join(root, "fallback-cli.js");
      await writeExecutable(fallbackCliPath, fakeCliSource("fallback"));

      const installed = await installCliShim({ targetDir: binDir, htmlslideHomeDir: homeDir, fallbackCliPath });
      expect(installed.action).toBe("installed");
      expect(installed.targetPath).toBe(path.join(binDir, "htmlslide"));

      const shimSource = await readFile(installed.targetPath, "utf8");
      expect(shimSource).toContain("HTMLslide managed CLI shim v1");

      const executed = await execFileAsync(installed.targetPath, ["check", "--json"], {
        env: { ...process.env, HTMLSLIDE_HOME: homeDir }
      });
      expect(JSON.parse(executed.stdout)).toEqual({ source: "fallback", args: ["check", "--json"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an unrelated htmlslide command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const targetPath = path.join(root, "bin", "htmlslide");
      const fallbackCliPath = path.join(root, "fallback-cli.js");
      await writeExecutable(targetPath, "#!/bin/sh\necho unrelated\n");
      await writeExecutable(fallbackCliPath, fakeCliSource("fallback"));

      await expect(
        installCliShim({ targetPath, htmlslideHomeDir: path.join(root, "state"), fallbackCliPath })
      ).rejects.toMatchObject({
        code: "CLI_SHIM_CONFLICT",
        exitCode: EXIT_CODES.generic,
        suggestedFix: "Choose another --target-path or remove the unrelated command manually."
      });
      await expect(readFile(targetPath, "utf8")).resolves.toBe("#!/bin/sh\necho unrelated\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes app-path.json and lets the shim prefer the app CLI over the dev fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const homeDir = path.join(root, "state");
      const binDir = path.join(root, "bin");
      const appPath = path.join(root, "HTMLslide.app");
      const appCliPath = path.join(
        appPath,
        "Contents",
        "Resources",
        "app",
        "packages",
        "cli",
        "dist",
        "bin",
        "htmlslide.js"
      );
      const fallbackCliPath = path.join(root, "fallback-cli.js");
      await writeExecutable(appCliPath, fakeCliSource("app"));
      await writeExecutable(fallbackCliPath, fakeCliSource("fallback"));

      const installed = await installCliShim({ targetDir: binDir, htmlslideHomeDir: homeDir, appPath, fallbackCliPath });
      expect(installed.appPathJson).toBe(path.join(homeDir, "app-path.json"));
      expect(JSON.parse(await readFile(path.join(homeDir, "app-path.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        appPath
      });

      const executed = await execFileAsync(installed.targetPath, ["doctor"], {
        env: { ...process.env, HTMLSLIDE_HOME: homeDir }
      });
      expect(JSON.parse(executed.stdout)).toEqual({ source: "app", args: ["doctor"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports shim status and uninstalls only managed shims", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const homeDir = path.join(root, "state");
      const binDir = path.join(root, "bin");
      const fallbackCliPath = path.join(root, "fallback-cli.js");
      await writeExecutable(fallbackCliPath, fakeCliSource("fallback"));

      const beforeDoctor = await doctor({ htmlslideHomeDir: homeDir });
      expect(beforeDoctor.checks.find((check) => check.id === "cli-shim")).toMatchObject({
        status: "info",
        suggestedFix: "Run htmlslide setup install-cli."
      });

      await installCliShim({ targetDir: binDir, htmlslideHomeDir: homeDir, fallbackCliPath });
      const status = await getCliShimStatus({ targetDir: binDir, htmlslideHomeDir: homeDir });
      expect(status).toMatchObject({ installed: true, managed: true, targetPath: path.join(binDir, "htmlslide") });

      const removed = await uninstallCliShim({ targetDir: binDir, htmlslideHomeDir: homeDir });
      expect(removed.action).toBe("removed");
      await expectMissing(path.join(binDir, "htmlslide"));

      const unchanged = await uninstallCliShim({ targetDir: binDir, htmlslideHomeDir: homeDir });
      expect(unchanged.action).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns JSON and the expected exit code for setup command conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const homeDir = path.join(root, "state");
      const targetPath = path.join(root, "bin", "htmlslide");
      await writeExecutable(targetPath, "#!/bin/sh\necho unrelated\n");

      await expect(
        runCli(["setup", "install-cli", "--target-path", targetPath, "--json"], { HTMLSLIDE_HOME: homeDir })
      ).rejects.toMatchObject({
        code: EXIT_CODES.generic,
        stdout: expect.stringContaining('"code": "CLI_SHIM_CONFLICT"')
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
