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
        "cli-runtime",
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

  it("lists mock agent engines as machine-readable JSON", async () => {
    const executed = await runCli(["agent", "engines", "--json"]);
    const payload = JSON.parse(executed.stdout);

    expect(payload.status).toBe("passed");
    expect(payload.engines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "htmlslide-mock",
          mode: "mock",
          available: true
        })
      ])
    );
  });

  it("runs the mock agent through the CLI and returns deterministic JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const executed = await runCli([
        "agent",
        "run",
        "--engine",
        "htmlslide-mock",
        "--task",
        "Create a deterministic CLI coverage deck",
        "--path",
        project.projectPath,
        "--json"
      ]);
      const payload = JSON.parse(executed.stdout);

      expect(payload.status).toBe("succeeded");
      expect(payload.runId).toBe("run-0001");
      expect(payload.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "run-created",
            runId: "run-0001",
            sequence: 1,
            createdAt: "2026-01-01T00:00:00.000Z"
          }),
          expect.objectContaining({
            type: "run-completed",
            stage: "review",
            status: "succeeded"
          })
        ])
      );
      expect(payload.outputs.brief).toMatchObject({
        brief: "Create a deterministic CLI coverage deck",
        title: "Mock HTMLslide Deck"
      });
      expect(payload.outputs.checks.map((check: { status: string }) => check.status)).toEqual(["failed", "passed"]);
      expect(payload.outputs.repairs).toHaveLength(1);
      expect(payload.outputs.export.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "pdf",
            path: "exports/mock-htmlslide-deck.pdf"
          })
        ])
      );
      expect(payload.checkpoint).toMatchObject({
        id: "checkpoint-run-0001",
        runId: "run-0001",
        strategy: "file-copy",
        restore: {
          canRevert: true
        }
      });
      expect(payload.applied).toMatchObject({
        projectPath: project.projectPath,
        title: "Mock HTMLslide Deck",
        slideIds: ["001-title", "002-workflow", "003-review"],
        filesChanged: expect.arrayContaining([
          "deck.json",
          "slides/003-review.html",
          "notes/003-review.md",
          "theme/tokens.json"
        ])
      });

      const deck = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
        "001-title",
        "002-workflow",
        "003-review"
      ]);
      await expect(readFile(path.join(project.projectPath, "slides", "003-review.html"), "utf8")).resolves.toContain(
        'data-slide-id="003-review"'
      );

      const checked = await runCli(["check", project.projectPath, "--json"]);
      const checkPayload = JSON.parse(checked.stdout);
      expect(checkPayload.status).toBe("passed");
      expect(checkPayload.summary.errors).toBe(0);

      const diffed = await runCli([
        "checkpoint",
        "diff",
        "--run-id",
        "run-0001",
        "--path",
        project.projectPath,
        "--json"
      ]);
      const diffPayload = JSON.parse(diffed.stdout);
      expect(diffPayload.status).toBe("passed");
      expect(diffPayload.summary.changed).toBeGreaterThan(0);
      expect(diffPayload.added.map((file: { path: string }) => file.path)).toEqual(
        expect.arrayContaining(["slides/003-review.html", "notes/003-review.md"])
      );

      await expect(
        runCli(["checkpoint", "revert", "--run-id", "run-0001", "--path", project.projectPath, "--json"])
      ).rejects.toMatchObject({
        code: EXIT_CODES.generic,
        stdout: expect.stringContaining("CHECKPOINT_REVERT_CONFIRMATION_REQUIRED")
      });

      const reverted = await runCli([
        "checkpoint",
        "revert",
        "--run-id",
        "run-0001",
        "--path",
        project.projectPath,
        "--yes",
        "--json"
      ]);
      const revertPayload = JSON.parse(reverted.stdout);
      expect(revertPayload.status).toBe("passed");
      expect(revertPayload.restored).toEqual(
        expect.arrayContaining(["deck.json", "slides/001-title.html", "notes/001-title.md"])
      );
      expect(revertPayload.deleted).toEqual(
        expect.arrayContaining(["slides/003-review.html", "notes/003-review.md"])
      );

      const restoredDeck = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(restoredDeck.title).toBe("Demo");
      expect(restoredDeck.slides.map((slide: { id: string }) => slide.id)).toEqual(["001-title", "002-workflow"]);
      await expectMissing(path.join(project.projectPath, "slides", "003-review.html"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns actionable JSON and exit code 6 for unknown agent engines", async () => {
    await expect(
      runCli(["agent", "run", "--engine", "missing-engine", "--task", "No external calls", "--json"])
    ).rejects.toMatchObject({
      code: EXIT_CODES.agentFailed,
      stdout: expect.stringContaining('"code": "AGENT_ENGINE_NOT_FOUND"')
    });
  });
});
