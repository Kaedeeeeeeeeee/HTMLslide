import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DECK_SCHEMA_VERSION, HTMLSLIDE_APP_VERSION } from "@htmlslide/core/version";
import { getOfficialSkill } from "@htmlslide/skills";
import {
  checkLoadedProject,
  configureCliBrowserRuntime,
  createProject,
  doctor,
  EXIT_CODES,
  exportLoadedProject,
  getCliShimStatus,
  installCliShim,
  launchDesktopTarget,
  loadProject,
  readDesktopAppPathConfig,
  resolveProjectExportOptions,
  tryLoadProjectForCheck,
  uninstallCliShim,
  validateAgentProviderCredentials,
  validateDeckPackageForPresentation
} from "../src/index";
import { writeDeckExportOptions } from "@htmlslide/core";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const fixturePath = (name: string): string => path.join(repoRoot, "packages", "test-fixtures", "decks", name);
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

describe("CLI project helpers", { timeout: 20_000 }, () => {
  it("configures only a validated packaged Chromium executable inside the CLI runtime", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-browser-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-browser-outside-"));
    try {
      const executablePath = path.join(runtimeRoot, "browser-runtime", "Chromium.app", "Contents", "MacOS", "Chromium");
      await writeExecutable(executablePath, "#!/bin/sh\nexit 0\n");
      await writeFile(path.join(runtimeRoot, "browser-runtime.json"), `${JSON.stringify({
        schemaVersion: 1,
        executablePath: "browser-runtime/Chromium.app/Contents/MacOS/Chromium"
      })}\n`);
      const env: NodeJS.ProcessEnv = {};

      await expect(configureCliBrowserRuntime({ env, runtimeRoot })).resolves.toMatchObject({
        available: true,
        executablePath,
        source: "packaged"
      });
      expect(env.HTMLSLIDE_CHROMIUM_EXECUTABLE).toBe(executablePath);

      await writeFile(path.join(runtimeRoot, "browser-runtime.json"), `${JSON.stringify({
        schemaVersion: 1,
        executablePath: "../outside-chromium"
      })}\n`);
      await expect(configureCliBrowserRuntime({ env: {}, runtimeRoot })).rejects.toThrow("must stay inside");

      const outsideExecutable = path.join(outsideRoot, "chromium");
      await writeExecutable(outsideExecutable, "#!/bin/sh\nexit 0\n");
      await symlink(outsideRoot, path.join(runtimeRoot, "linked-browser-runtime"));
      await writeFile(path.join(runtimeRoot, "browser-runtime.json"), `${JSON.stringify({
        schemaVersion: 1,
        executablePath: "linked-browser-runtime/chromium"
      })}\n`);
      await expect(configureCliBrowserRuntime({ env: {}, runtimeRoot })).rejects.toThrow("resolves outside");
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("reports the centralized app version from CLI and doctor output", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout.trim()).toBe(HTMLSLIDE_APP_VERSION);

    const report = await doctor();
    expect(report.version).toBe(HTMLSLIDE_APP_VERSION);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "chromium", status: "passed" }));
  });

  it("fails doctor when the CLI shim path is occupied by an unmanaged command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-doctor-"));
    try {
      const targetPath = path.join(root, "bin", "htmlslide");
      await writeExecutable(targetPath, "#!/bin/sh\nexit 0\n");
      const report = await doctor({ targetPath });
      expect(report).toMatchObject({ status: "failed" });
      expect(report.checks).toContainEqual(expect.objectContaining({ id: "cli-shim", status: "failed" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns missing-dependency exit code when Chromium cannot launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      await expect(
        runCli(["export", project.projectPath, "--json"], {
          HTMLSLIDE_CHROMIUM_EXECUTABLE: path.join(root, "missing-chromium")
        })
      ).rejects.toMatchObject({
        code: EXIT_CODES.missingDependency,
        stdout: expect.stringContaining('"code": "CHROMIUM_UNAVAILABLE"')
      });
      await expect(
        runCli(["doctor", "--json"], {
          HTMLSLIDE_CHROMIUM_EXECUTABLE: path.join(root, "missing-chromium")
        })
      ).rejects.toMatchObject({
        code: EXIT_CODES.missingDependency,
        stdout: expect.stringContaining('"status": "failed"')
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(deckJson.schemaVersion).toBe(DECK_SCHEMA_VERSION);
      expect(deckJson.appVersion).toBe(HTMLSLIDE_APP_VERSION);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a deck project with an explicit title from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const projectPath = path.join(root, "quarterly-launch");
      const { stdout } = await runCli(["new", projectPath, "--title", "Quarterly Launch Review", "--json"]);
      const result = JSON.parse(stdout) as { status: string; projectPath: string; template: string; title: string };
      const deckJson = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8")) as { title?: string };

      expect(result).toMatchObject({
        projectPath,
        status: "passed",
        template: "default",
        title: "Quarterly Launch Review"
      });
      expect(deckJson.title).toBe("Quarterly Launch Review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists built-in templates from the CLI", async () => {
    const { stdout } = await runCli(["templates", "list", "--json"]);
    const result = JSON.parse(stdout) as {
      status: string;
      templates: Array<{ id: string; name: string; slideCount: number }>;
    };

    expect(result.status).toBe("passed");
    expect(result.templates.map((template) => template.id)).toEqual([
      "default",
      "swiss-editorial",
      "consulting-clean",
      "technical-dark",
      "product-launch",
      "data-report"
    ]);
    expect(result.templates).toContainEqual(
      expect.objectContaining({
        id: "data-report",
        name: "Data Report",
        slideCount: 2
      })
    );
  });

  it("creates a deck project from a named built-in template", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const projectPath = path.join(root, "technical-demo");
      const { stdout } = await runCli([
        "new",
        projectPath,
        "--template",
        "technical-dark",
        "--title",
        "Technical Demo",
        "--json"
      ]);
      const result = JSON.parse(stdout) as { status: string; template: string; title: string };
      const css = await readFile(path.join(projectPath, "theme", "theme.css"), "utf8");
      const agents = await readFile(path.join(projectPath, "AGENTS.md"), "utf8");

      expect(result).toMatchObject({
        status: "passed",
        template: "technical-dark",
        title: "Technical Demo"
      });
      expect(css).toContain("--slide-bg: #10141c");
      expect(agents).toContain("Template guidance: Use dark technical contrast");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown built-in templates from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      await expect(runCli(["new", path.join(root, "demo"), "--template", "missing", "--json"])).rejects.toMatchObject({
        stdout: expect.stringContaining("Unknown deck template: missing")
      });
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
      expect(loaded.exitCode).toBe(EXIT_CODES.projectNotFound);
      expect(loaded.report.issues[0]?.type).toBe("missing-slide-source");
      expect(loaded.report.issues[0]?.agentInstruction).toBeTruthy();

      const failure = await runCli(["check", path.join(root, "missing"), "--json"]).catch(
        (error: unknown) => error
      );
      expect(failure).toMatchObject({ code: EXIT_CODES.projectNotFound });
      const report = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
        issues: Array<{ type: string }>;
      };
      expect(report.issues[0]?.type).toBe("missing-slide-source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves schema diagnostics and exits 2 for an invalid deck", async () => {
    const projectPath = fixturePath("invalid-duplicate-slide-id");
    const loaded = await tryLoadProjectForCheck(projectPath);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      throw new Error("Expected project load to fail");
    }
    expect(loaded.exitCode).toBe(EXIT_CODES.validationFailed);
    expect(loaded.report.issues[0]).toMatchObject({
      slideId: "deck",
      severity: "error",
      type: "schema-validation",
      path: "slides.1.id"
    });

    const failure = await runCli(["check", projectPath, "--json"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: EXIT_CODES.validationFailed });
    const report = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
      issues: Array<{ type: string; path?: string }>;
    };
    expect(report.issues[0]).toMatchObject({ type: "schema-validation", path: "slides.1.id" });
  });

  it("preserves schema diagnostics and exits 8 for an incompatible schema", async () => {
    const projectPath = fixturePath("invalid-unsupported-schema");
    const loaded = await tryLoadProjectForCheck(projectPath);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      throw new Error("Expected project load to fail");
    }
    expect(loaded.exitCode).toBe(EXIT_CODES.incompatibleSchema);
    expect(loaded.report.issues[0]).toMatchObject({
      slideId: "deck",
      severity: "error",
      type: "schema-validation",
      path: "schemaVersion"
    });

    const failure = await runCli(["check", projectPath, "--json"]).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: EXIT_CODES.incompatibleSchema });
    const report = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
      issues: Array<{ type: string; path?: string }>;
    };
    expect(report.issues[0]).toMatchObject({ type: "schema-validation", path: "schemaVersion" });

    for (const args of [
      ["open", projectPath, "--json"],
      ["package", projectPath, "--json"],
      ["present", projectPath, "--json"],
      ["skill", "list", "--project", projectPath, "--json"]
    ]) {
      const commandFailure = await runCli(args).catch((error: unknown) => error);
      expect(commandFailure).toMatchObject({ code: EXIT_CODES.incompatibleSchema });
      expect(JSON.parse(String((commandFailure as { stdout?: unknown }).stdout))).toMatchObject({
        exitCode: EXIT_CODES.incompatibleSchema
      });
    }
  }, 20_000);

  it("treats a missing schema version as validation failure rather than incompatibility", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      await writeFile(path.join(root, "deck.json"), JSON.stringify({ id: "missing_schema_version" }));
      const loaded = await tryLoadProjectForCheck(root);

      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("Expected project load to fail");
      }
      expect(loaded.exitCode).toBe(EXIT_CODES.validationFailed);
      expect(loaded.report.issues).toContainEqual(
        expect.objectContaining({ type: "schema-validation", path: "schemaVersion" })
      );

      const failure = await runCli(["check", root, "--json"]).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: EXIT_CODES.validationFailed });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports malformed deck JSON without misclassifying it as a missing slide", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      await writeFile(path.join(root, "deck.json"), '{"schemaVersion":');
      const failure = await runCli(["check", root, "--json"]).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: EXIT_CODES.validationFailed });
      const report = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
        issues: Array<{ type: string; path?: string; suggestedFix: string }>;
      };
      expect(report.issues[0]).toMatchObject({
        type: "invalid-json",
        path: "deck.json",
        suggestedFix: "Fix the JSON syntax in deck.json and rerun htmlslide check."
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("exits 5 when deck.json cannot be read due to permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    const deckPath = path.join(root, "deck.json");
    try {
      await writeFile(deckPath, '{"schemaVersion":"0.1.0"}');
      await chmod(deckPath, 0o000);
      const failure = await runCli(["check", root, "--json"]).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: EXIT_CODES.permissionDenied });
      const report = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
        issues: Array<{ type: string; path?: string }>;
      };
      expect(report.issues[0]).toMatchObject({ type: "permission-denied", path: "deck.json" });
    } finally {
      await chmod(deckPath, 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a non-string schema version as validation failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      await writeFile(path.join(root, "deck.json"), JSON.stringify({ schemaVersion: 1 }));
      const loaded = await tryLoadProjectForCheck(root);

      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("Expected project load to fail");
      }
      expect(loaded.exitCode).toBe(EXIT_CODES.validationFailed);
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

  it("defaults the export command to all primary artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const { stdout } = await runCli(["export", project.projectPath, "--json"]);
      const exported = JSON.parse(stdout) as {
        artifacts: {
          deckpkg?: string;
          html?: string;
          notes?: string;
          pdf?: string;
          thumbnails?: string[];
        };
        metadata: {
          manifest: string;
        };
      };

      expect(exported.artifacts.pdf).toBe(path.join(project.projectPath, "exports", "demo.pdf"));
      expect(exported.artifacts.html).toBe(path.join(project.projectPath, "exports", "demo.html"));
      expect(exported.artifacts.deckpkg).toBe(path.join(project.projectPath, "exports", "demo.deckpkg"));
      expect(exported.artifacts.notes).toBe(path.join(project.projectPath, "exports", "notes.json"));
      expect(exported.artifacts.thumbnails).toHaveLength(2);
      expect(exported.artifacts).not.toHaveProperty("manifest");
      expect(exported.metadata.manifest).toBe(path.join(project.projectPath, "exports", "export-manifest.json"));
      await expect(access(exported.artifacts.pdf!)).resolves.toBeUndefined();
      await expect(access(exported.artifacts.html!)).resolves.toBeUndefined();
      await expect(access(exported.artifacts.deckpkg!)).resolves.toBeUndefined();
      await expect(access(exported.artifacts.thumbnails![0]!)).resolves.toBeUndefined();
      await expect(access(exported.metadata.manifest)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the manifest export profile when no CLI flags are provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "manifest-defaults"), "manifest-defaults");
      await writeDeckExportOptions(project.projectPath, {
        deckpkg: false,
        html: true,
        pdf: false,
        speakerNotes: true,
        thumbnails: false
      });

      const { stdout } = await runCli(["export", project.projectPath, "--json"]);
      const exported = JSON.parse(stdout) as { artifacts: Record<string, unknown> };

      expect(exported.artifacts).toMatchObject({
        html: path.join(project.projectPath, "exports", "manifest-defaults.html"),
        notes: path.join(project.projectPath, "exports", "notes.json")
      });
      expect(exported.artifacts).not.toHaveProperty("pdf");
      expect(exported.artifacts).not.toHaveProperty("deckpkg");
      expect(exported.artifacts).not.toHaveProperty("thumbnails");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives explicit CLI flags precedence over the manifest export profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "explicit-flags"), "explicit-flags");
      await writeDeckExportOptions(project.projectPath, {
        deckpkg: false,
        html: false,
        pdf: false,
        speakerNotes: true,
        thumbnails: false
      });

      const { stdout } = await runCli(["export", project.projectPath, "--html", "--json"]);
      const exported = JSON.parse(stdout) as { artifacts: Record<string, unknown> };

      expect(exported.artifacts.html).toBe(path.join(project.projectPath, "exports", "explicit-flags.html"));
      expect(exported.artifacts.notes).toBe(path.join(project.projectPath, "exports", "notes.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves each CLI export flag against the manifest profile", async () => {
    const project = {
      manifest: {
        export: { deckpkg: true, html: false, pdf: true, speakerNotes: true, thumbnails: false }
      }
    } as Awaited<ReturnType<typeof loadProject>>;

    expect(resolveProjectExportOptions(project, { html: true, pdf: false })).toMatchObject({
      deckpkg: true,
      html: true,
      pdf: false,
      thumbnails: false
    });
  });

  it("packages a checked project without standalone PDF or HTML artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const { stdout } = await runCli(["package", project.projectPath, "--json"]);
      const packaged = JSON.parse(stdout) as {
        status: string;
        command: string;
        deckpkgPath: string;
        artifacts: Record<string, unknown>;
      };

      expect(packaged).toMatchObject({
        status: "passed",
        command: "package",
        deckpkgPath: path.join(project.projectPath, "exports", "demo.deckpkg")
      });
      expect(packaged.artifacts).toMatchObject({
        deckpkg: packaged.deckpkgPath,
        notes: path.join(project.projectPath, "exports", "notes.json")
      });
      expect(packaged.artifacts).not.toHaveProperty("pdf");
      expect(packaged.artifacts).not.toHaveProperty("html");
      expect(packaged.artifacts.thumbnails).toHaveLength(2);
      await expect(access(packaged.deckpkgPath)).resolves.toBeUndefined();
      await expect(validateDeckPackageForPresentation(packaged.deckpkgPath)).resolves.toMatchObject({
        status: "passed",
        deckpkgPath: packaged.deckpkgPath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("launches validated desktop targets with argument-safe macOS open invocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const appPath = path.join(root, "HTMLslide Test.app");
      const project = await createProject(path.join(root, "deck with spaces"), "demo");
      await mkdir(appPath, { recursive: true });
      const invocations: Array<{ executable: string; args: readonly string[] }> = [];

      const result = await launchDesktopTarget("open", project.projectPath, "project", {
        appPath,
        platform: "darwin",
        runOpen: async (executable, args) => {
          invocations.push({ executable, args: [...args] });
        }
      });

      expect(result).toMatchObject({
        status: "passed",
        command: "open",
        appPath,
        targetPath: project.projectPath,
        targetKind: "project"
      });
      expect(invocations).toEqual([
        {
          executable: "/usr/bin/open",
          args: ["-a", appPath, project.projectPath]
        }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads app-path configuration and reports missing desktop setup with exit code 4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const appPath = path.join(root, "HTMLslide.app");
      await mkdir(appPath, { recursive: true });
      await writeFile(
        path.join(root, "app-path.json"),
        `${JSON.stringify({ schemaVersion: 1, appPath, version: "0.1.0" })}\n`
      );
      await expect(readDesktopAppPathConfig(root)).resolves.toEqual({
        schemaVersion: 1,
        appPath,
        version: "0.1.0",
        bundleId: undefined,
        updatedAt: undefined
      });

      const failure = await readDesktopAppPathConfig(path.join(root, "missing-state"))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "DESKTOP_APP_NOT_CONFIGURED",
        exitCode: EXIT_CODES.missingDependency
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists, installs, inspects, and removes managed official skills through the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-skill-"));
    const htmlslideHome = path.join(root, "state");
    try {
      const listed = JSON.parse((await runCli(["skill", "list", "--json"], { HTMLSLIDE_HOME: htmlslideHome })).stdout) as {
        status: string;
        official: Array<{ name: string; installed: unknown[] }>;
      };
      expect(listed.status).toBe("passed");
      expect(listed.official).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "deck-architect", installed: [] })])
      );

      const added = JSON.parse(
        (await runCli(["skill", "add", "deck-architect", "--json"], { HTMLSLIDE_HOME: htmlslideHome })).stdout
      ) as { action: string; locations: Array<{ directoryPath: string }>; skillName: string };
      expect(added).toMatchObject({ action: "installed", skillName: "deck-architect" });
      expect(added.locations[0]?.directoryPath).toBe(path.join(htmlslideHome, "skills", "deck-architect"));
      await expect(access(path.join(htmlslideHome, "skills", "deck-architect", ".htmlslide-managed.json"))).resolves.toBeUndefined();

      const inspected = JSON.parse(
        (await runCli(["skill", "inspect", "deck-architect", "--json"], { HTMLSLIDE_HOME: htmlslideHome })).stdout
      ) as { installed: Array<{ integrity: string; managed: boolean }>; official?: unknown };
      expect(inspected.official).toBeTruthy();
      expect(inspected.installed).toEqual([
        expect.objectContaining({ integrity: "verified", managed: true })
      ]);

      const confirmationFailure = await runCli(
        ["skill", "remove", "deck-architect", "--json"],
        { HTMLSLIDE_HOME: htmlslideHome }
      ).catch((error: unknown) => error);
      expect(confirmationFailure).toMatchObject({ code: EXIT_CODES.generic });
      expect(JSON.parse(String((confirmationFailure as { stdout?: unknown }).stdout))).toMatchObject({
        code: "SKILL_REMOVE_CONFIRMATION_REQUIRED"
      });

      const removed = JSON.parse(
        (await runCli(["skill", "remove", "deck-architect", "--yes", "--json"], { HTMLSLIDE_HOME: htmlslideHome })).stdout
      ) as { action: string; skillName: string };
      expect(removed).toMatchObject({ action: "removed", skillName: "deck-architect" });
      await expectMissing(path.join(htmlslideHome, "skills", "deck-architect"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation for declared third-party skill risks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-skill-"));
    const htmlslideHome = path.join(root, "state");
    try {
      const official = getOfficialSkill("data-report");
      if (!official) {
        throw new Error("Expected data-report official skill fixture");
      }
      const skillPath = path.join(root, "risky-skill", "SKILL.md");
      const markdown = official.markdown
        .replace("name: data-report", "name: cli-risk-test")
        .replace("scripts: false", "scripts: true");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, markdown);

      const failure = await runCli(["skill", "add", skillPath, "--json"], {
        HTMLSLIDE_HOME: htmlslideHome
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: EXIT_CODES.generic });
      const payload = JSON.parse(String((failure as { stdout?: unknown }).stdout)) as {
        code: string;
        details?: { warnings?: Array<{ code: string }> };
      };
      expect(payload.code).toBe("SKILL_CONFIRMATION_REQUIRED");
      expect(payload.details?.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "contains-scripts" })])
      );

      const installed = JSON.parse(
        (await runCli(["skill", "add", skillPath, "--yes", "--json"], { HTMLSLIDE_HOME: htmlslideHome })).stdout
      ) as { status: string; skillName: string };
      expect(installed).toMatchObject({ status: "passed", skillName: "cli-risk-test" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs official skills to validated project adapter locations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-skill-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const result = JSON.parse(
        (
          await runCli([
            "skill",
            "add",
            "brand-kit",
            "--project",
            project.projectPath,
            "--location",
            "project",
            "codex",
            "--json"
          ])
        ).stdout
      ) as { locations: Array<{ location: string }> };
      expect(result.locations.map((entry) => entry.location)).toEqual(["project", "codex"]);
      await expect(access(path.join(project.projectPath, "skills", "project", "brand-kit", "SKILL.md"))).resolves.toBeUndefined();
      await expect(access(path.join(project.projectPath, ".agents", "skills", "htmlslide", "brand-kit", "SKILL.md"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns machine-readable JSON for Commander argument failures", async () => {
    for (const args of [
      ["skill", "add", "--json"],
      ["skill", "list", "--unknown-option", "--json"]
    ]) {
      const failure = await runCli(args).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: EXIT_CODES.generic });
      expect(JSON.parse(String((failure as { stdout?: unknown }).stdout))).toMatchObject({
        status: "failed",
        code: "CLI_ARGUMENT_ERROR",
        exitCode: EXIT_CODES.generic,
        details: { commanderCode: expect.stringMatching(/^commander\./u) }
      });
    }
  });

  it("returns export-failed exit code 3 when the compiler cannot acquire the project lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      const cachePath = path.join(project.projectPath, ".htmlslide", "cache");
      await mkdir(cachePath, { recursive: true });
      await writeFile(
        path.join(cachePath, "export.lock"),
        `${JSON.stringify({ pid: process.pid, token: "active-test-owner" })}\n`
      );

      const failure = await runCli(["export", project.projectPath, "--json"]).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: EXIT_CODES.exportFailed });
      expect(JSON.parse(String((failure as { stdout?: unknown }).stdout))).toMatchObject({
        status: "failed",
        code: "EXPORT_FAILED",
        exitCode: EXIT_CODES.exportFailed
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves project-load exit codes before export starts", async () => {
    const missingPath = path.join(os.tmpdir(), `htmlslide-missing-export-${Date.now()}`);
    const failure = await runCli(["export", missingPath, "--json"]).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: EXIT_CODES.projectNotFound });
    expect(JSON.parse(String((failure as { stdout?: unknown }).stdout))).toMatchObject({
      status: "failed",
      exitCode: EXIT_CODES.projectNotFound
    });
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

      const installed = await installCliShim({
        appPath,
        appVersion: "0.1.0-test",
        bundleId: "app.htmlslide.test",
        fallbackCliPath,
        htmlslideHomeDir: homeDir,
        targetDir: binDir,
        updatedAt: "2026-07-08T00:00:00.000Z"
      });
      expect(installed.appPathJson).toBe(path.join(homeDir, "app-path.json"));
      expect(JSON.parse(await readFile(path.join(homeDir, "app-path.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        appPath,
        bundleId: "app.htmlslide.test",
        version: "0.1.0-test",
        updatedAt: "2026-07-08T00:00:00.000Z"
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

      const afterDoctor = await doctor({ targetDir: binDir, htmlslideHomeDir: homeDir });
      expect(afterDoctor.checks.find((check) => check.id === "cli-shim")).toMatchObject({
        status: "info",
        suggestedFix: "Run htmlslide setup install-cli."
      });

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

  it("validates provider credentials from an environment variable without recording the secret", async () => {
    const secret = "htmlslide-provider-validation-test-key";
    const requests: Array<{ authorization: string | null; input: string }> = [];

    const result = await validateAgentProviderCredentials({
      apiKeyEnv: "HTMLSLIDE_TEST_OPENAI_KEY",
      env: {
        HTMLSLIDE_TEST_OPENAI_KEY: secret
      },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("authorization"),
          input: String(input)
        });
        return new Response(JSON.stringify({ id: "gpt-htmlslide-test" }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      },
      model: "gpt-htmlslide-test",
      provider: "openai"
    });

    expect(result).toMatchObject({
      apiKeyEnv: "HTMLSLIDE_TEST_OPENAI_KEY",
      command: "agent validate-provider",
      credential: {
        ok: true,
        providerId: "htmlslide-provider-validation"
      },
      exitCode: EXIT_CODES.success,
      model: "gpt-htmlslide-test",
      provider: "openai",
      secretRecorded: false,
      status: "passed"
    });
    expect(requests).toEqual([
      {
        authorization: `Bearer ${secret}`,
        input: "https://api.openai.com/v1/models/gpt-htmlslide-test"
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns sanitized provider validation failures", async () => {
    const secret = "htmlslide-provider-validation-failed-test-key";
    const result = await validateAgentProviderCredentials({
      apiKeyEnv: "HTMLSLIDE_TEST_OPENAI_KEY",
      env: {
        HTMLSLIDE_TEST_OPENAI_KEY: secret
      },
      fetch: async () => new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), { status: 401 }),
      model: "gpt-htmlslide-test",
      provider: "openai"
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(EXIT_CODES.agentFailed);
    expect(result.credential).toMatchObject({
      ok: false,
      providerId: "htmlslide-provider-validation",
      recoverable: true
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("validates compatible providers against the configured base URL", async () => {
    const secret = "compatible-provider-secret";
    const requestedUrls: string[] = [];

    const result = await validateAgentProviderCredentials({
      apiKeyEnv: "HTMLSLIDE_TEST_COMPATIBLE_KEY",
      baseUrl: "https://provider.example.test/v1/",
      env: {
        HTMLSLIDE_TEST_COMPATIBLE_KEY: secret
      },
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ id: "llama-htmlslide-test" }), { status: 200 });
      },
      model: "llama-htmlslide-test",
      provider: "compatible"
    });

    expect(result).toMatchObject({
      baseUrl: "https://provider.example.test/v1",
      provider: "compatible",
      status: "passed"
    });
    expect(requestedUrls).toEqual(["https://provider.example.test/v1/models/llama-htmlslide-test"]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects provider validation when the API key environment variable is missing", async () => {
    await expect(
      runCli([
        "agent",
        "validate-provider",
        "--provider",
        "openai",
        "--model",
        "gpt-htmlslide-test",
        "--api-key-env",
        "HTMLSLIDE_TEST_PROVIDER_KEY_DO_NOT_SET",
        "--json"
      ])
    ).rejects.toMatchObject({
      code: EXIT_CODES.agentFailed,
      stdout: expect.stringContaining('"code": "AGENT_PROVIDER_API_KEY_ENV_MISSING"')
    });
  });

  it("does not echo an invalid API key environment variable name", async () => {
    const opaqueName = "opaque-credential-DO-NOT-PRINT";
    const failure = await runCli([
      "agent",
      "validate-provider",
      "--provider",
      "openai",
      "--model",
      "gpt-htmlslide-test",
      "--api-key-env",
      opaqueName,
      "--json"
    ]).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: EXIT_CODES.agentFailed,
      stdout: expect.stringContaining('"code": "AGENT_PROVIDER_API_KEY_ENV_INVALID"')
    });
    expect(String((failure as { stdout?: unknown })?.stdout ?? "")).not.toContain(opaqueName);
  });

  it.each([
    "https://user:password@provider.example.test/v1",
    "https://provider.example.test/v1?token=secret",
    "https://provider.example.test/v1#secret"
  ])("rejects a compatible provider URL containing credentials or URL metadata: %s", async (baseUrl) => {
    await expect(
      validateAgentProviderCredentials({
        apiKeyEnv: "HTMLSLIDE_TEST_COMPATIBLE_KEY",
        baseUrl,
        env: { HTMLSLIDE_TEST_COMPATIBLE_KEY: "compatible-provider-secret" },
        fetch: async () => new Response(JSON.stringify({ id: "unused" }), { status: 200 }),
        model: "llama-htmlslide-test",
        provider: "compatible"
      })
    ).rejects.toMatchObject({
      code: "AGENT_PROVIDER_BASE_URL_INVALID"
    });
  });

  it("requires a base URL for compatible provider validation without printing environment values", async () => {
    const secret = "htmlslide-compatible-provider-test-key";
    const failure = await runCli(
      [
        "agent",
        "validate-provider",
        "--provider",
        "compatible",
        "--model",
        "llama-htmlslide-test",
        "--api-key-env",
        "HTMLSLIDE_TEST_COMPATIBLE_KEY",
        "--json"
      ],
      {
        HTMLSLIDE_TEST_COMPATIBLE_KEY: secret
      }
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: EXIT_CODES.agentFailed,
      stdout: expect.stringContaining('"code": "AGENT_PROVIDER_BASE_URL_REQUIRED"')
    });
    expect(String((failure as { stdout?: unknown })?.stdout ?? "")).not.toContain(secret);
  });

  it("lists MCP tools and reports project harness status from the CLI", async () => {
    const toolsResult = await runCli(["mcp", "--list-tools", "--json"]);
    const toolsPayload = JSON.parse(toolsResult.stdout) as {
      command: string;
      implementedToolCount: number;
      status: string;
      toolCount: number;
      tools: Array<{ name: string; safety: string; description: string; implemented: boolean; deprecated?: boolean }>;
    };

    expect(toolsPayload.command).toBe("mcp list-tools");
    expect(toolsPayload.status).toBe("passed");
    expect(toolsPayload.toolCount).toBe(toolsPayload.tools.length);
    expect(toolsPayload.implementedToolCount).toBe(toolsPayload.tools.filter((tool) => tool.implemented).length);
    expect(toolsPayload.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          implemented: true,
          name: "project_get_manifest",
          safety: "read-only"
        }),
        expect.objectContaining({
          implemented: true,
          name: "slide_write",
          safety: "project-write"
        }),
        expect.objectContaining({
          implemented: true,
          name: "checkpoint_revert",
          safety: "dangerous"
        }),
        expect.objectContaining({
          deprecated: true,
          implemented: true,
          name: "read_deck"
        })
      ])
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-"));
    try {
      const project = await createProject(path.join(root, "demo"), "demo");
      await expect(runCli(["mcp", project.projectPath, "--json"])).rejects.toMatchObject({
        code: EXIT_CODES.generic,
        stderr: expect.stringContaining('"code":"MCP_JSON_REQUIRES_DIAGNOSTIC_MODE"'),
        stdout: ""
      });

      const statusResult = await runCli(["mcp", project.projectPath, "--status", "--json"]);
      const statusPayload = JSON.parse(statusResult.stdout) as {
        command: string;
        implementedToolCount: number;
        mcpStatus: string;
        projectRoot: string;
        registeredToolCount: number;
        status: string;
        toolCount: number;
        transport: string;
        tools: Array<{ name: string }>;
      };

      expect(statusPayload).toMatchObject({
        command: "mcp status",
        implementedToolCount: toolsPayload.implementedToolCount,
        mcpStatus: "started",
        projectRoot: project.projectPath,
        registeredToolCount: toolsPayload.tools.length,
        status: "passed",
        transport: "in-process",
        toolCount: toolsPayload.tools.length
      });
      expect(statusPayload.tools.map((tool) => tool.name)).toContain("check_deck");
      expect(statusPayload.tools.map((tool) => tool.name)).toContain("export_pdf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        "--speaker-notes",
        "none",
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
      expect(payload.outputs.speakerNotesMode).toBe("none");
      expect(payload.outputs.build.notesChanged).toEqual([]);
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
          "theme/tokens.json"
        ])
      });

      const deck = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(deck.speakerNotesMode).toBe("none");
      expect(deck.export.speakerNotes).toBe(false);
      expect(deck.slides.every((slide: { notes?: string }) => slide.notes === undefined)).toBe(true);
      expect(deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
        "001-title",
        "002-workflow",
        "003-review"
      ]);
      await expect(readFile(path.join(project.projectPath, "slides", "003-review.html"), "utf8")).resolves.toContain(
        'data-slide-id="003-review"'
      );
      await expect(access(path.join(project.projectPath, "notes", "001-title.md"))).rejects.toThrow();

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
        expect.arrayContaining(["slides/003-review.html"])
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
        expect.arrayContaining(["slides/003-review.html"])
      );

      const restoredDeck = JSON.parse(await readFile(path.join(project.projectPath, "deck.json"), "utf8"));
      expect(restoredDeck.title).toBe("Demo");
      expect(restoredDeck.slides.map((slide: { id: string }) => slide.id)).toEqual(["001-title", "002-workflow"]);
      await expectMissing(path.join(project.projectPath, "slides", "003-review.html"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns actionable JSON and exit code 6 for unknown agent engines", async () => {
    await expect(
      runCli(["agent", "run", "--engine", "missing-engine", "--task", "No external calls", "--json"])
    ).rejects.toMatchObject({
      code: EXIT_CODES.agentFailed,
      stdout: expect.stringContaining('"code": "AGENT_ENGINE_NOT_FOUND"')
    });
  });
});
