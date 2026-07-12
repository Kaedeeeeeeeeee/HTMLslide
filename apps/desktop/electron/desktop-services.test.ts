import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_CAPTURE_LIMIT_CHARS,
  COMMAND_CAPTURE_TRUNCATION_MARKER
} from "@htmlslide/agent-adapters";
import {
  createMockPassedCheck,
  createMockProvider,
  type AgentRunEvent,
  type AgentRunLog,
  type FetchLike,
  type JsonObject,
  type ModelProvider
} from "@htmlslide/agent";
import { OFFICIAL_SKILLS } from "@htmlslide/skills";
import { exportDeck } from "../../../packages/compiler/src/index";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDesktopQaIgnoreRule,
  diffDesktopCheckpoint,
  findCliRuntime,
  getDesktopCliIntegration,
  getDesktopOfficialSkills,
  installDesktopCliIntegration,
  installDesktopOfficialSkills,
  listDesktopPresenterDisplays,
  loadDesktopPresenterDeck,
  loadDesktopPresenterDeckPackage,
  loadProjectPreview,
  loadSlidePreview,
  markRecentProjectMissing,
  readDesktopLibrary,
  removeRecentProject,
  resolveDesktopCliIntegrationTarget,
  resolveCreateProjectRequest,
  revertDesktopCheckpoint,
  runDesktopByokAgent,
  runDesktopExternalAgent,
  runHtmlslideCli,
  runDesktopMockAgent,
  sanitizeDesktopAgentMetadata,
  saveDesktopSlideNotes,
  summarizeDeckProject,
  uninstallDesktopCliIntegration,
  upsertRecentProject,
  writeDesktopLibrary,
  type CliRunResult,
  type CliRuntime,
  type DesktopCliRunner,
  type DesktopAiEngineSettings,
  type DesktopExternalAgentId,
  type DesktopExternalAgentStatus,
  type DesktopCredentialStore,
  type DesktopAgentRunReport,
  type DesktopProjectRecord
} from "./desktop-services.js";

const tempDirs: string[] = [];
const testModulePath = fileURLToPath(import.meta.url);
const TEST_CLI_RUNTIME: CliRuntime = {
  cliPath: testModulePath,
  cwd: path.dirname(testModulePath),
  mode: "development",
  rootPath: path.dirname(testModulePath)
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "htmlslide-desktop-test-"));
  tempDirs.push(dir);
  return dir;
}

function createFakeCredentialStore(entries: Record<string, string> = {}): DesktopCredentialStore & { entries: Map<string, string> } {
  const storeEntries = new Map(Object.entries(entries));
  return {
    available: true,
    entries: storeEntries,
    label: "Fake Keychain",
    async getPassword(service, account) {
      return storeEntries.get(`${service}:${account}`);
    },
    async setPassword(service, account, password) {
      storeEntries.set(`${service}:${account}`, password);
    },
    async deletePassword(service, account) {
      storeEntries.delete(`${service}:${account}`);
    }
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeDeck(projectPath: string): Promise<void> {
  await mkdir(path.join(projectPath, "slides"), { recursive: true });
  await mkdir(path.join(projectPath, "notes"), { recursive: true });
  await writeFile(
    path.join(projectPath, "deck.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        id: "deck_desktop_test",
        title: "Desktop Test Deck",
        language: "en",
        aspectRatio: "16:9",
        viewport: { width: 1920, height: 1080 },
        slides: [
          {
            id: "001-title",
            title: "Title",
            source: "slides/001-title.html",
            notes: "notes/001-title.md",
            durationSec: 75,
            kind: "title",
            status: "ready"
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(projectPath, "slides", "001-title.html"),
    `<section class="slide" data-slide-id="001-title"><h1>Title</h1><ul><li>First point</li><li>Second point</li></ul></section>\n`
  );
  await writeFile(path.join(projectPath, "notes", "001-title.md"), "# Notes\n\nSpeaker note body.\n");
}

async function writeExportedDeckPackage(projectPath: string): Promise<string> {
  await writeDeck(projectPath);
  const exported = await exportDeck({
    projectPath,
    title: "Desktop Test Deck",
    language: "en",
    viewport: { width: 1920, height: 1080 },
    safeArea: { top: 72, right: 96, bottom: 72, left: 96 },
    slides: [
      {
        id: "001-title",
        title: "Title",
        sourcePath: "slides/001-title.html",
        notesPath: "notes/001-title.md",
        durationSec: 75
      }
    ]
  });
  if (!exported.artifacts.deckpkg) {
    throw new Error("Expected compiler export to create a deckpkg artifact.");
  }
  return exported.artifacts.deckpkg;
}

function projectRecord(projectPath: string, title: string): DesktopProjectRecord {
  return {
    id: `proj_${title}`,
    lastOpenedAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
    path: projectPath,
    slideCount: 1,
    status: "Needs check",
    title
  };
}

function externalAgentSettings(commandTemplate: string, selectedId: DesktopExternalAgentId = "generic"): DesktopAiEngineSettings {
  return {
    apiKey: {
      hasKey: false,
      model: "gpt-5-mini",
      provider: "openai"
    },
    externalAgent: {
      customCommand: commandTemplate,
      selectedId
    },
    mode: "external-agent",
    version: 1
  };
}

function readyExternalAgentStatus(
  id: Extract<DesktopExternalAgentId, "claude-code" | "codex-cli">
): DesktopExternalAgentStatus {
  return {
    authenticated: true,
    capabilities: {
      cancelRun: true,
      headlessRun: true,
      readDiff: true,
      streamLogs: true
    },
    checkedAt: "2026-07-11T00:00:00.000Z",
    command: id === "claude-code" ? "claude" : "codex",
    id,
    installed: true,
    kind: id,
    label: id === "claude-code" ? "Claude Code" : "Codex CLI",
    status: "ready",
    summary: "Detected, authenticated, and headless contract verified",
    version: "9.9.9"
  };
}

function byokSettings(
  provider: "openai" | "anthropic" | "compatible" = "openai",
  overrides: { baseUrl?: string; model?: string } = {}
): DesktopAiEngineSettings {
  return {
    apiKey: {
      hasKey: true,
      baseUrl: overrides.baseUrl,
      model: overrides.model ?? (provider === "anthropic"
        ? "claude-sonnet-4-5"
        : provider === "compatible"
          ? "openai-compatible/default"
          : "gpt-5-mini"),
      provider
    },
    externalAgent: {
      customCommand: "",
      selectedId: "codex-cli"
    },
    mode: "htmlslide-agent",
    version: 1
  };
}

function byokSourceWrites(title = "BYOK Generated Deck") {
  return [
    {
      path: "deck.json",
      content: `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          id: "deck_byok_test",
          title,
          language: "en",
          aspectRatio: "16:9",
          viewport: { width: 1920, height: 1080 },
          slides: [
            {
              id: "001-title",
              title,
              source: "slides/001-title.html",
              notes: "notes/001-title.md",
              durationSec: 75,
              kind: "title",
              status: "ready"
            }
          ]
        },
        null,
        2
      )}\n`
    },
    {
      path: "slides/001-title.html",
      content: `<section class="slide" data-slide-id="001-title"><h1>${title}</h1><ul><li>Provider source write</li></ul></section>\n`
    },
    {
      path: "notes/001-title.md",
      content: `# ${title}\n\nGenerated through provider source writes.\n`
    }
  ];
}

function createSourceWriteTestProvider(title = "BYOK Generated Deck"): ModelProvider {
  const provider = createMockProvider({
    checkResults: [createMockPassedCheck()],
    id: "test-byok-provider"
  });

  return {
    id: "test-byok-provider",
    label: "Test BYOK Provider",
    async validateCredentials() {
      return { ok: true };
    },
    async complete(request) {
      const response = await provider.complete(request);
      if (request.stage !== "build") {
        return response;
      }

      return {
        ...response,
        output: {
          ...(response.output as Record<string, unknown>),
          sourceWrites: byokSourceWrites(title)
        }
      };
    }
  };
}

function createOpenAiByokFetch(title = "BYOK OpenAI Deck"): { calls: Array<{ url: string; body?: unknown; method?: string }>; fetch: FetchLike } {
  const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const url = String(input);
    calls.push({ body, method: init?.method, url });

    if (init?.method === "GET" && url.endsWith("/models/gpt-5-mini")) {
      return jsonResponse({ id: "gpt-5-mini" });
    }

    if (init?.method === "POST" && url.endsWith("/chat/completions")) {
      const requestBody = body as { messages?: Array<{ content?: string }> };
      const userContent = requestBody.messages?.[1]?.content ?? "{}";
      const userInput = JSON.parse(userContent) as { stage?: string };
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(openAiStageOutput(userInput.stage, title))
            }
          }
        ],
        usage: {
          completion_tokens: 7,
          prompt_tokens: 11,
          total_tokens: 18
        }
      });
    }

    return jsonResponse({ error: { message: `Unexpected fetch ${init?.method ?? "GET"} ${url}` } }, { status: 500 });
  };

  return { calls, fetch };
}

function createAnthropicByokFetch(title = "BYOK Anthropic Deck"): { calls: Array<{ url: string; body?: unknown; method?: string }>; fetch: FetchLike } {
  const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const url = String(input);
    calls.push({ body, method: init?.method, url });

    if (init?.method === "GET" && url.endsWith("/models/claude-sonnet-4-5")) {
      return jsonResponse({ id: "claude-sonnet-4-5" });
    }

    if (init?.method === "POST" && url.endsWith("/messages")) {
      const requestBody = body as { messages?: Array<{ content?: string }>; tool_choice?: { name?: string } };
      const userContent = requestBody.messages?.[0]?.content ?? "{}";
      const userInput = JSON.parse(userContent) as { stage?: string };
      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: `toolu_${userInput.stage ?? "unknown"}`,
            name: requestBody.tool_choice?.name ?? `htmlslide_${userInput.stage ?? "unknown"}_output`,
            input: openAiStageOutput(userInput.stage, title)
          }
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 8
        }
      });
    }

    return jsonResponse({ error: { message: `Unexpected fetch ${init?.method ?? "GET"} ${url}` } }, { status: 500 });
  };

  return { calls, fetch };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

function openAiStageOutput(stage: string | undefined, title: string): unknown {
  switch (stage) {
    case "brief":
      return {
        title,
        brief: "Build a provider-backed deck.",
        language: "en-US",
        audience: "reviewers",
        durationMinutes: 8
      };
    case "outline":
      return {
        title,
        language: "en-US",
        audience: "reviewers",
        durationMinutes: 8,
        slides: [{ id: "001-title", title, kind: "title", goal: "Introduce provider-backed generation." }]
      };
    case "visual-direction":
      return {
        directions: [
          {
            id: "direction-provider",
            label: "Provider Light",
            rationale: "Simple readable provider output.",
            sampleSlideIds: ["001-title"],
            tokens: {
              accent: "#2357d9",
              background: "#ffffff",
              text: "#111827"
            }
          }
        ],
        selectedDirectionId: null
      };
    case "build":
      return {
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        notesChanged: ["001-title"],
        slidesChanged: ["001-title"],
        themeChanged: [],
        sourceWrites: byokSourceWrites(title)
      };
    case "check":
      return {
        status: "passed",
        summary: { errors: 0, warnings: 0, info: 0 },
        issues: []
      };
    case "export":
      return {
        artifacts: [{ type: "pdf", path: "exports/provider.pdf" }]
      };
    case "review":
      return {
        summary: "Provider-backed deck is ready for review.",
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        issuesRemaining: 0,
        nextActions: ["Review deck"]
      };
    default:
      throw new Error(`Unexpected OpenAI stage: ${stage ?? "unknown"}`);
  }
}

async function writeExternalAgentScript(projectPath: string, name: string, source: string): Promise<string> {
  const scriptFile = path.join(projectPath, ".htmlslide", "runs", `${name}.mjs`);
  await mkdir(path.dirname(scriptFile), { recursive: true });
  await writeFile(scriptFile, source.trimStart(), "utf8");
  return scriptFile;
}

async function readProjectTextFiles(projectPath: string): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];

  async function walk(directoryPath: string): Promise<void> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      files.push({
        path: path.relative(projectPath, entryPath),
        text: await readFile(entryPath, "utf8")
      });
    }
  }

  await walk(projectPath);
  return files;
}

describe("desktop services", () => {
  it("resolves new deck requests inside the selected workspace", async () => {
    const workspacePath = await tempDir();

    expect(
      resolveCreateProjectRequest({
        folderName: "quarterly-launch-review",
        title: "  Quarterly Launch Review  ",
        workspacePath
      })
    ).toEqual({
      folderName: "quarterly-launch-review",
      projectPath: path.join(workspacePath, "quarterly-launch-review"),
      templateId: "default",
      title: "Quarterly Launch Review",
      workspacePath
    });
  });

  it("preserves a selected new deck template id", async () => {
    const workspacePath = await tempDir();

    expect(
      resolveCreateProjectRequest({
        folderName: "quarterly-launch-review",
        templateId: "default",
        title: "Quarterly Launch Review",
        workspacePath
      }).templateId
    ).toBe("default");
  });

  it("rejects unsafe new deck folder names", async () => {
    const workspacePath = await tempDir();

    for (const folderName of ["../escape", "Escape", ".hidden", "deck/child", "deck child", "deck..child"]) {
      expect(() =>
        resolveCreateProjectRequest({
          folderName,
          title: "Deck",
          workspacePath
        })
      ).toThrow();
    }
  });

  it("creates and updates the desktop library deterministically", async () => {
    const root = await tempDir();
    const libraryPath = path.join(root, "library.json");
    const firstProject = projectRecord(path.join(root, "one"), "One");
    const secondProject = projectRecord(path.join(root, "two"), "Two");

    expect(await readDesktopLibrary(libraryPath, "/workspace")).toEqual({
      defaultWorkspace: "/workspace",
      onboardingCompleted: false,
      recentProjects: [],
      version: 1
    });

    await writeDesktopLibrary(libraryPath, {
      defaultWorkspace: "/workspace",
      onboardingCompleted: true,
      recentProjects: [firstProject],
      version: 1
    });
    await upsertRecentProject(libraryPath, secondProject, "/workspace");
    await upsertRecentProject(libraryPath, { ...firstProject, status: "Ready" }, "/workspace");

    const raw = JSON.parse(await readFile(libraryPath, "utf8")) as { recentProjects: DesktopProjectRecord[] };
    expect(raw.recentProjects.map((project) => project.title)).toEqual(["One", "Two"]);
    expect(raw.recentProjects[0]?.status).toBe("Ready");
    expect((await readDesktopLibrary(libraryPath, "/workspace")).onboardingCompleted).toBe(true);
  });

  it("treats a legacy desktop library as already onboarded", async () => {
    const root = await tempDir();
    const libraryPath = path.join(root, "library.json");
    await writeFile(libraryPath, JSON.stringify({
      defaultWorkspace: "/legacy-workspace",
      recentProjects: [],
      version: 1
    }));

    expect(await readDesktopLibrary(libraryPath, "/workspace")).toMatchObject({
      defaultWorkspace: "/legacy-workspace",
      onboardingCompleted: true
    });
  });

  it("removes and marks recent projects without touching project files", async () => {
    const root = await tempDir();
    const libraryPath = path.join(root, "library.json");
    const firstProject = projectRecord(path.join(root, "one"), "One");
    const secondProject = projectRecord(path.join(root, "two"), "Two");
    await mkdir(firstProject.path, { recursive: true });
    await writeFile(path.join(firstProject.path, "sentinel.txt"), "project source");

    await writeDesktopLibrary(libraryPath, {
      defaultWorkspace: "/workspace",
      onboardingCompleted: false,
      recentProjects: [firstProject, secondProject],
      version: 1
    });

    const missingLibrary = await markRecentProjectMissing(libraryPath, { id: firstProject.id }, "/workspace");
    expect(missingLibrary.recentProjects.map((project) => project.status)).toEqual(["Missing files", "Needs check"]);

    const removedLibrary = await removeRecentProject(libraryPath, { path: firstProject.path }, "/workspace");
    expect(removedLibrary.recentProjects.map((project) => project.title)).toEqual(["Two"]);
    await expect(readFile(path.join(firstProject.path, "sentinel.txt"), "utf8")).resolves.toBe("project source");
  });

  it("loads a project preview from deck source files", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    const summary = await summarizeDeckProject(projectPath);
    const preview = await loadProjectPreview(projectPath);

    expect(summary.title).toBe("Desktop Test Deck");
    expect(summary.slideCount).toBe(1);
    expect(summary.status).toBe("Needs check");
    expect(preview.slides[0]).toMatchObject({
      bullets: ["First point", "Second point"],
      duration: "1:15",
      id: "001-title",
      speakerNotes: "# Notes\n\nSpeaker note body.",
      status: "ready"
    });
    expect(preview.slides[0]).not.toHaveProperty("html");
  });

  it("saves speaker notes through the manifest-declared notes path", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    await expect(saveDesktopSlideNotes(projectPath, "001-title", "# Updated notes\n")).resolves.toMatchObject({
      notesPath: "notes/001-title.md",
      slideId: "001-title"
    });
    await expect(readFile(path.join(projectPath, "notes", "001-title.md"), "utf8")).resolves.toBe("# Updated notes\n");
  });

  it("stores QA ignore rules inside the project runtime directory", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    await expect(addDesktopQaIgnoreRule(projectPath, "text-overflow")).resolves.toEqual({
      issueTypes: ["text-overflow"]
    });
    await expect(readFile(path.join(projectPath, ".htmlslide", "qa-ignores.json"), "utf8")).resolves.toContain(
      '"text-overflow"'
    );
  });

  it("rejects speaker notes that traverse a symlink", async () => {
    const projectPath = await tempDir();
    const outsidePath = await tempDir();
    await writeDeck(projectPath);
    await writeFile(path.join(outsidePath, "notes.md"), "outside\n");
    await rm(path.join(projectPath, "notes", "001-title.md"));
    await symlink(
      path.join(outsidePath, "notes.md"),
      path.join(projectPath, "notes", "001-title.md")
    );

    await expect(saveDesktopSlideNotes(projectPath, "001-title", "should not write\n")).rejects.toThrow(
      "symbolic links"
    );
    await expect(readFile(path.join(outsidePath, "notes.md"), "utf8")).resolves.toBe("outside\n");
  });

  it("builds an isolated compiler document for one slide without exposing raw HTML in project metadata", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    await writeFile(
      path.join(projectPath, "slides", "001-title.html"),
      `<section class="slide" data-slide-id="001-title"><h1>Hostile title</h1><script>parent.document.body.dataset.previewEscaped = "true"</script></section>\n`
    );

    const [projectPreview, slidePreview] = await Promise.all([
      loadProjectPreview(projectPath),
      loadSlidePreview(projectPath, "001-title")
    ]);

    expect(projectPreview.slides[0]).not.toHaveProperty("html");
    expect(slidePreview).toMatchObject({
      notes: "# Notes\n\nSpeaker note body.\n",
      projectRoot: projectPath,
      slideId: "001-title",
      sourcePath: "slides/001-title.html",
      title: "Title",
      viewport: { height: 1080, width: 1920 }
    });
    expect(slidePreview.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(slidePreview.htmlDocument).toContain('http-equiv="Content-Security-Policy"');
    expect(slidePreview.htmlDocument).toContain("script-src 'none'");
    expect(slidePreview.htmlDocument).toContain("previewEscaped");
  });

  it("rejects project-relative paths that escape the deck folder", async () => {
    const projectPath = await tempDir();
    await mkdir(path.join(projectPath, "slides"), { recursive: true });
    await writeFile(
      path.join(projectPath, "deck.json"),
      `${JSON.stringify({
        title: "Bad Deck",
        slides: [{ id: "bad", title: "Bad", source: "../outside.html" }]
      })}\n`
    );

    await expect(loadProjectPreview(projectPath)).rejects.toThrow("Unsafe project path");
  });

  it("finds a packaged CLI runtime under Electron resources", async () => {
    const root = await tempDir();
    const resourcesPath = path.join(root, "HTMLslide.app", "Contents", "Resources");
    const cliPath = path.join(resourcesPath, "app", "cli-runtime", "dist", "bin", "htmlslide.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, "#!/usr/bin/env node\n");

    expect(findCliRuntime(path.join(resourcesPath, "app", "dist", "electron"), resourcesPath)).toEqual({
      mode: "packaged",
      cliPath,
      cwd: path.join(resourcesPath, "app", "cli-runtime")
    });
  });

  it("finds the development CLI runtime from a workspace child path", async () => {
    const root = await tempDir();
    const cliPath = path.join(root, "packages", "cli", "dist", "bin", "htmlslide.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(cliPath, "#!/usr/bin/env node\n");

    expect(findCliRuntime(path.join(root, "apps", "desktop", "dist", "electron"))).toEqual({
      mode: "development",
      cliPath,
      cwd: root,
      rootPath: root
    });
  });

  it("resolves the app-managed CLI target from environment overrides", async () => {
    const root = await tempDir();
    const target = await resolveDesktopCliIntegrationTarget({
      HTMLSLIDE_CLI_TARGET_DIR: path.join(root, "bin"),
      HTMLSLIDE_HOME: path.join(root, "state")
    });

    expect(target).toEqual({
      htmlslideHomeDir: path.join(root, "state"),
      source: "env",
      targetDir: path.join(root, "bin"),
      targetPath: path.join(root, "bin", "htmlslide")
    });
  });

  it("checks, installs, and uninstalls the app-managed CLI shim through the embedded CLI", async () => {
    const root = await tempDir();
    const targetDir = path.join(root, "bin");
    const homeDir = path.join(root, "state");
    const cliRuntime = {
      cliPath: path.join(root, "cli-runtime", "htmlslide.js"),
      cwd: path.join(root, "cli-runtime"),
      mode: "development" as const,
      rootPath: root
    };
    const calls: string[][] = [];
    const resultFor = (args: string[]): CliRunResult => {
      if (args[0] === "setup" && args[1] === "status") {
        return {
          exitCode: 0,
          json: {
            command: "setup status",
            htmlslideHomeDir: homeDir,
            installed: false,
            managed: false,
            message: `HTMLslide CLI shim is not installed at ${path.join(targetDir, "htmlslide")}.`,
            onPath: false,
            status: "info",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      if (args[0] === "setup" && args[1] === "install-cli") {
        return {
          exitCode: 0,
          json: {
            action: "installed",
            command: "setup install-cli",
            htmlslideHomeDir: homeDir,
            message: `Installed HTMLslide CLI shim at ${path.join(targetDir, "htmlslide")}.`,
            status: "passed",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      if (args[0] === "setup" && args[1] === "uninstall-cli") {
        return {
          exitCode: 0,
          json: {
            action: "removed",
            command: "setup uninstall-cli",
            htmlslideHomeDir: homeDir,
            message: `Removed HTMLslide CLI shim from ${path.join(targetDir, "htmlslide")}.`,
            status: "passed",
            targetDir,
            targetPath: path.join(targetDir, "htmlslide")
          },
          ok: true,
          stderr: "",
          stdout: ""
        };
      }

      throw new Error(`Unexpected CLI integration call: ${args.join(" ")}`);
    };
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return resultFor(args);
    };
    const options = {
      appPath: path.join(root, "HTMLslide.app"),
      appVersion: "0.1.0-test",
      bundleId: "app.htmlslide.test",
      cliRuntime,
      cliRunner: runner,
      env: {
        HTMLSLIDE_CLI_TARGET_DIR: targetDir,
        HTMLSLIDE_HOME: homeDir
      },
      now: "2026-07-08T00:00:00.000Z"
    };

    const status = await getDesktopCliIntegration(options);
    expect(status).toMatchObject({
      available: true,
      installed: false,
      manualInstallCommand: expect.stringContaining("setup"),
      mode: "development",
      status: "info",
      targetPath: path.join(targetDir, "htmlslide")
    });

    const installed = await installDesktopCliIntegration(options);
    expect(installed).toMatchObject({
      action: "installed",
      available: true,
      message: `Installed HTMLslide CLI shim at ${path.join(targetDir, "htmlslide")}.`,
      targetPath: path.join(targetDir, "htmlslide")
    });

    const uninstalled = await uninstallDesktopCliIntegration(options);
    expect(uninstalled).toMatchObject({
      action: "removed",
      message: `Removed HTMLslide CLI shim from ${path.join(targetDir, "htmlslide")}.`
    });

    expect(calls).toEqual([
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      [
        "setup",
        "install-cli",
        "--target-path",
        path.join(targetDir, "htmlslide"),
        "--app-path",
        path.join(root, "HTMLslide.app"),
        "--app-version",
        "0.1.0-test",
        "--bundle-id",
        "app.htmlslide.test",
        "--fallback-cli-path",
        cliRuntime.cliPath,
        "--json"
      ],
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      ["setup", "uninstall-cli", "--target-path", path.join(targetDir, "htmlslide"), "--json"],
      ["setup", "status", "--target-path", path.join(targetDir, "htmlslide"), "--json"]
    ]);
  });

  it("installs official skills into the isolated HTMLslide home directory", async () => {
    const homeDir = await tempDir();
    const options = {
      env: {
        HTMLSLIDE_HOME: homeDir
      },
      now: "2026-07-08T00:00:00.000Z"
    };

    const before = await getDesktopOfficialSkills(options);
    expect(before).toMatchObject({
      htmlslideHomeDir: homeDir,
      installed: false,
      installedCount: 0,
      missing: expect.arrayContaining(OFFICIAL_SKILLS.map((skill) => skill.metadata.name)),
      skillCount: OFFICIAL_SKILLS.length,
      status: "warning"
    });
    expect(before.skills).toHaveLength(OFFICIAL_SKILLS.length);
    expect(before.skills.find((skill) => skill.name === "deck-architect")).toMatchObject({
      description: OFFICIAL_SKILLS.find((skill) => skill.metadata.name === "deck-architect")?.metadata.description,
      installed: false,
      license: "Apache-2.0",
      riskLevel: "low",
      stale: false,
      status: "missing",
      type: "planning"
    });

    const installed = await installDesktopOfficialSkills(options);
    expect(installed).toMatchObject({
      action: "installed",
      installed: true,
      installedCount: OFFICIAL_SKILLS.length,
      skillCount: OFFICIAL_SKILLS.length,
      status: "passed"
    });
    expect(installed.skills.every((skill) => skill.status === "installed" && skill.installed && !skill.stale)).toBe(true);

    const deckArchitect = await readFile(path.join(homeDir, "skills", "deck-architect", "SKILL.md"), "utf8");
    expect(deckArchitect).toContain("name: deck-architect");
    expect(deckArchitect).toContain("Do not write generated exports or secrets.");
    await expect(
      readFile(path.join(homeDir, "skills", "deck-architect", ".htmlslide-managed.json"), "utf8")
    ).resolves.toContain('"manager": "htmlslide"');

    const unchanged = await installDesktopOfficialSkills(options);
    expect(unchanged).toMatchObject({
      action: "unchanged",
      installed: true,
      installedCount: OFFICIAL_SKILLS.length,
      status: "passed"
    });

    await writeFile(
      path.join(homeDir, "skills", "deck-architect", ".htmlslide-managed.json"),
      "{invalid",
      "utf8"
    );
    const corrupted = await getDesktopOfficialSkills(options);
    expect(corrupted).toMatchObject({ installed: false, status: "warning" });
    expect(corrupted.stale).toContain("deck-architect");
  });

  it("reports and updates stale official skill files", async () => {
    const homeDir = await tempDir();
    const stalePath = path.join(homeDir, "skills", "deck-architect", "SKILL.md");
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, "# stale\n", "utf8");

    const options = {
      env: {
        HTMLSLIDE_HOME: homeDir
      }
    };
    const before = await getDesktopOfficialSkills(options);
    expect(before.stale).toContain("deck-architect");
    expect(before.skills.find((skill) => skill.name === "deck-architect")).toMatchObject({
      installed: false,
      stale: true,
      status: "stale"
    });

    const updated = await installDesktopOfficialSkills(options);
    expect(updated).toMatchObject({
      action: "updated",
      installed: true,
      stale: [],
      status: "passed"
    });
    await expect(readFile(stalePath, "utf8")).resolves.toContain("name: deck-architect");
    await expect(
      readFile(path.join(homeDir, "skills", "deck-architect", ".htmlslide-managed.json"), "utf8")
    ).resolves.toContain('"manager": "htmlslide"');
  });

  it("runs the mock agent and then real project check/export through the CLI runner", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 1,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              html: path.join(projectPath, "exports", "deck.html"),
              notes: path.join(projectPath, "exports", "notes.json"),
              thumbnails: [path.join(projectPath, "exports", "thumbnails", "001-title.png")]
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDesktopMockAgent(
      {
        brief: "Make a deterministic product-alpha deck",
        projectPath,
        runId: "run-desktop-test"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        chooseVisualDirection: (directions) => directions[1]?.id ?? ""
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("htmlslide-mock");
    expect(result.agent.ok).toBe(true);
    expect(result.agent.checkpoint).toMatchObject({
      id: "checkpoint-run-desktop-test",
      strategy: "file-copy",
      restore: {
        canRevert: true
      }
    });
    expect(result.applied).toMatchObject({
      projectPath,
      title: "Mock HTMLslide Deck",
      slideIds: ["001-title", "002-workflow", "003-review"]
    });
    expect(result.checkpointDiff?.summary).toMatchObject({
      changed: 3,
      added: 6,
      deleted: 0
    });
    expect(result.check?.ok).toBe(true);
    expect(result.export?.ok).toBe(true);
    expect(result.project?.project).toMatchObject({
      path: projectPath,
      title: "Mock HTMLslide Deck",
      slideCount: 3
    });
    expect(result.project?.slides.map((slide) => slide.id)).toEqual(["001-title", "002-workflow", "003-review"]);
    expect(result.project?.slides[2]).toMatchObject({
      id: "003-review",
      sourcePath: "slides/003-review.html"
    });
    expect(result.project?.slides[2]).not.toHaveProperty("html");
    expect(result.summary).toMatchObject({
      checkErrors: 0,
      checkStatus: "passed",
      checkWarnings: 1,
      completedStages: 8,
      exportStatus: "passed",
      runId: "run-desktop-test",
      status: "succeeded"
    });
    expect(result.summary.exportArtifacts).toEqual([
      path.join(projectPath, "exports", "deck.html"),
      path.join(projectPath, "exports", "notes.json"),
      path.join(projectPath, "exports", "thumbnails", "001-title.png")
    ]);
    const expectedReportPath = path.join(projectPath, ".htmlslide", "reports", "agent-run-run-desktop-test.json");
    expect(result.agentReportPath).toBe(expectedReportPath);
    const reportText = await readFile(path.join(projectPath, ".htmlslide", "reports", "latest-agent-run.json"), "utf8");
    const report = JSON.parse(reportText) as DesktopAgentRunReport;
    expect(report).toMatchObject({
      kind: "htmlslide-agent-run-report",
      providerId: "htmlslide-mock",
      runId: "run-desktop-test",
      schemaVersion: "0.1.0",
      status: "succeeded"
    });
    expect(report).not.toHaveProperty("provider");
    expect(report.outputs.outline?.slides.map((slide) => slide.id)).toEqual([
      "001-title",
      "002-workflow",
      "003-review"
    ]);
    expect(report.outputs.visualDirection?.directions.map((direction) => direction.id)).toEqual([
      "direction-editorial",
      "direction-systems"
    ]);
    expect(report.outputs.selectedVisualDirectionId).toBe("direction-systems");
    expect(report.outputs.build).toMatchObject({
      slidesChanged: ["001-title", "002-workflow", "003-review"],
      sourceWriteCount: 0,
      sourceWritePaths: []
    });
    expect(report.applied).toMatchObject({
      source: "mock-project-writer",
      selectedVisualDirectionId: "direction-systems",
      slideIds: ["001-title", "002-workflow", "003-review"]
    });
    expect(report.checkpointDiff?.summary).toMatchObject({
      added: 6,
      changed: 3,
      deleted: 0
    });
    expect(report.cli.check).toMatchObject({
      ok: true,
      status: "passed",
      summary: {
        errors: 0,
        warnings: 1
      }
    });
    expect(report.cli.export?.artifactPaths).toEqual([
      path.join(projectPath, "exports", "deck.html"),
      path.join(projectPath, "exports", "notes.json"),
      path.join(projectPath, "exports", "thumbnails", "001-title.png")
    ]);
    await expect(readFile(expectedReportPath, "utf8")).resolves.toBe(reportText);
    expect(reportText).not.toContain('"content":');
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "brief",
      "outline",
      "visual-direction",
      "build",
      "check",
      "repair",
      "export",
      "review"
    ]);
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);

    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8"));
    expect(deck.agent.lastRunId).toBe("run-desktop-test");
    expect(deck.slides).toHaveLength(3);

    const diff = await diffDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test"
    });
    expect(diff.added.map((file) => file.path)).toEqual(
      expect.arrayContaining(["slides/002-workflow.html", "slides/003-review.html", "theme/theme.css"])
    );

    await expect(revertDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test"
    })).rejects.toThrow("explicit confirmation");

    const reverted = await revertDesktopCheckpoint({
      projectPath,
      runId: "run-desktop-test",
      confirmed: true
    });
    expect(reverted.restored).toEqual(expect.arrayContaining(["deck.json", "slides/001-title.html"]));
    expect(reverted.deleted).toEqual(
      expect.arrayContaining(["slides/002-workflow.html", "slides/003-review.html", "theme/theme.css"])
    );
    expect(reverted.project?.project).toMatchObject({
      title: "Desktop Test Deck",
      slideCount: 1
    });
    const restoredDeck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8"));
    expect(restoredDeck.title).toBe("Desktop Test Deck");
    expect(restoredDeck.slides).toHaveLength(1);
  });

  it("refuses a symlinked agent report directory without writing outside the project", async () => {
    const projectPath = await tempDir();
    const outsidePath = await tempDir();
    const outsideReports = path.join(outsidePath, "reports");
    await writeDeck(projectPath);
    await mkdir(outsideReports);

    await expect(runDesktopMockAgent(
      {
        brief: "Do not follow report symlinks.",
        projectPath,
        runExport: false,
        runId: "run-report-symlink"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        cliRunner: async () => {
          await symlink(outsideReports, path.join(projectPath, ".htmlslide", "reports"));
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: {
              status: "passed",
              summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
              issues: []
            }
          };
        }
      }
    )).rejects.toThrow(/runtime path must be a real project directory/);

    await expect(access(path.join(outsideReports, "latest-agent-run.json"))).rejects.toThrow();
  });

  it("delivers normalized core and desktop records live and keeps them in the final arrays", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const observedEvents: AgentRunEvent[] = [];
    const observedLogs: AgentRunLog[] = [];
    let coreDeliveredBeforeDesktopCheck = false;

    const result = await runDesktopMockAgent(
      {
        brief: "Observe the live mock run.",
        projectPath,
        runExport: false,
        runId: "run-mock-live-observers"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: async (args) => {
          coreDeliveredBeforeDesktopCheck = observedEvents.some((event) => event.type === "run-completed")
            && observedLogs.some((log) => log.stage === "review");
          expect(args[0]).toBe("check");
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: {
              status: "passed",
              summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
              issues: []
            }
          };
        },
        onEvent: (event) => observedEvents.push(event),
        onLog: (log) => observedLogs.push(log)
      }
    );

    expect(result.ok).toBe(true);
    expect(coreDeliveredBeforeDesktopCheck).toBe(true);
    expect(observedEvents).toEqual(result.events);
    expect(observedLogs).toEqual(result.logs);
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1)
    );
    expect(result.events.some((event) => event.summary === "Applied mock agent source files.")).toBe(true);
    expect(result.events.some((event) => event.summary === "Check passed after applying mock source files.")).toBe(true);
    expect(result.logs.some((log) => log.message === "htmlslide check completed with exit code 0.")).toBe(true);
    expect(result.events.filter((event) => event.type === "run-created")).toHaveLength(1);
  });

  it("isolates throwing BYOK observers while retaining credential, apply, and CLI records", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    let eventCalls = 0;
    let logCalls = 0;

    const result = await runDesktopByokAgent(
      {
        brief: "Run despite observer failures.",
        projectPath,
        runExport: false,
        runId: "run-byok-observer-isolation",
        targetSlideCount: 1
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: async () => ({
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
            issues: []
          }
        }),
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-observer-secret"
        }),
        onEvent: () => {
          eventCalls += 1;
          throw new Error("event observer failed");
        },
        onLog: () => {
          logCalls += 1;
          throw new Error("log observer failed");
        },
        providerFactory: () => createSourceWriteTestProvider("Observer Isolation Deck"),
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(true);
    expect(eventCalls).toBe(result.events.length);
    expect(logCalls).toBe(result.logs.length);
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1)
    );
    expect(result.events.some((event) => event.summary.includes("credential validated"))).toBe(true);
    expect(result.events.some((event) => event.summary === "Applied HTMLslide Agent source writes.")).toBe(true);
    expect(result.logs.some((log) => log.message === "htmlslide check completed with exit code 0.")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-observer-secret");
  });

  it("fails BYOK CLI-runtime preflight before credential, provider, CLI, or source-write work", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const originalDeck = await readFile(path.join(projectPath, "deck.json"), "utf8");
    let credentialReads = 0;
    let providerConstructions = 0;
    let cliCalls = 0;
    const credentialStore: DesktopCredentialStore = {
      available: true,
      label: "Observed Keychain",
      async getPassword() {
        credentialReads += 1;
        return "sk-must-not-be-read";
      },
      async setPassword() {
        return undefined;
      },
      async deletePassword() {
        return undefined;
      }
    };

    const result = await runDesktopByokAgent(
      {
        brief: "Do not start without the authoritative CLI runtime.",
        projectPath,
        runId: "run-byok-missing-cli-runtime",
        targetSlideCount: 1
      },
      {
        cliRunner: async () => {
          cliCalls += 1;
          throw new Error("CLI must not run without a runtime.");
        },
        credentialStore,
        providerFactory: () => {
          providerConstructions += 1;
          return createSourceWriteTestProvider("Must Not Be Written");
        },
        settings: byokSettings("openai")
      }
    );

    expect(result).toMatchObject({
      error: "HTMLslide CLI runtime is not available. Rebuild the app or reinstall HTMLslide before running HTMLslide Agent.",
      ok: false,
      summary: {
        runId: "run-byok-missing-cli-runtime",
        status: "failed"
      }
    });
    expect(credentialReads).toBe(0);
    expect(providerConstructions).toBe(0);
    expect(cliCalls).toBe(0);
    await expect(readFile(path.join(projectPath, "deck.json"), "utf8")).resolves.toBe(originalDeck);
    await expect(access(path.join(projectPath, ".htmlslide"))).rejects.toThrow();
  });

  it("revalidates a stale BYOK CLI runtime descriptor before reading credentials", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    let credentialReads = 0;

    const result = await runDesktopByokAgent(
      {
        brief: "Reject a stale runtime descriptor.",
        projectPath,
        runId: "run-byok-stale-cli-runtime"
      },
      {
        cliRuntime: {
          cliPath: path.join(projectPath, "missing-cli.js"),
          cwd: projectPath,
          mode: "development",
          rootPath: projectPath
        },
        credentialStore: {
          available: true,
          label: "Observed Keychain",
          async getPassword() {
            credentialReads += 1;
            return "not-read";
          },
          async setPassword() {},
          async deletePassword() {}
        },
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing-cli\.js|no such file/i);
    expect(credentialReads).toBe(0);
  });

  it("rejects a provider deck manifest that mismatches the accepted outline before applying writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const originalDeck = await readFile(path.join(projectPath, "deck.json"), "utf8");
    const originalSlide = await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8");
    const provider = createMockProvider({
      checkResults: [createMockPassedCheck()],
      id: "test-byok-manifest-mismatch"
    });
    const writes = byokSourceWrites("Mismatched Manifest");
    const manifest = JSON.parse(writes[0]!.content) as { slides: Array<{ id: string }> };
    manifest.slides[0]!.id = "999-not-in-outline";
    writes[0] = {
      path: "deck.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`
    };
    let cliCalls = 0;

    await expect(runDesktopByokAgent(
      {
        brief: "Reject a mismatched provider manifest.",
        projectPath,
        runExport: false,
        runId: "run-byok-manifest-mismatch",
        targetSlideCount: 1
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        cliRunner: async () => {
          cliCalls += 1;
          throw new Error("CLI must not run after manifest validation fails.");
        },
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-manifest-mismatch"
        }),
        providerFactory: () => ({
          id: "test-byok-manifest-mismatch",
          label: "Manifest Mismatch Provider",
          async validateCredentials() {
            return { ok: true };
          },
          async complete(request) {
            const response = await provider.complete(request);
            return request.stage === "build"
              ? {
                  ...response,
                  output: {
                    ...(response.output as Record<string, unknown>),
                    sourceWrites: writes
                  }
                }
              : response;
          }
        }),
        settings: byokSettings("openai")
      }
    )).rejects.toThrow("generated deck.json slide IDs/order do not match the accepted outline");

    expect(cliCalls).toBe(0);
    await expect(readFile(path.join(projectPath, "deck.json"), "utf8")).resolves.toBe(originalDeck);
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.toBe(originalSlide);
  });

  it("rejects missing provider-manifest source references before applying writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const originalDeck = await readFile(path.join(projectPath, "deck.json"), "utf8");
    const provider = createMockProvider({
      checkResults: [createMockPassedCheck()],
      id: "test-byok-missing-reference"
    });
    const writes = byokSourceWrites("Missing Reference");
    const manifest = JSON.parse(writes[0]!.content) as { slides: Array<{ source: string }> };
    manifest.slides[0]!.source = "slides/not-generated.html";
    writes[0] = {
      path: "deck.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`
    };

    await expect(runDesktopByokAgent(
      {
        brief: "Reject a missing manifest reference.",
        projectPath,
        runExport: false,
        runId: "run-byok-missing-reference",
        targetSlideCount: 1
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-missing-reference"
        }),
        providerFactory: () => ({
          id: "test-byok-missing-reference",
          label: "Missing Reference Provider",
          async validateCredentials() {
            return { ok: true };
          },
          async complete(request) {
            const response = await provider.complete(request);
            return request.stage === "build"
              ? {
                  ...response,
                  output: {
                    ...(response.output as Record<string, unknown>),
                    sourceWrites: writes
                  }
                }
              : response;
          }
        }),
        settings: byokSettings("openai")
      }
    )).rejects.toThrow("is not included in sourceWrites and does not already exist safely");

    await expect(readFile(path.join(projectPath, "deck.json"), "utf8")).resolves.toBe(originalDeck);
    await expect(access(path.join(projectPath, "slides", "not-generated.html"))).rejects.toThrow();
  });

  it("cancels a BYOK run while credential validation is pending", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const abortController = new AbortController();
    let validationStarted = false;

    const result = await runDesktopByokAgent(
      {
        brief: "Cancel credential validation.",
        projectPath,
        runExport: false,
        runId: "run-byok-cancel-preflight"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        signal: abortController.signal,
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-preflight-secret"
        }),
        providerFactory: () => ({
          ...createSourceWriteTestProvider("Never Built"),
          validateCredentials() {
            validationStarted = true;
            queueMicrotask(() => abortController.abort("Stop provider preflight."));
            return new Promise(() => undefined);
          }
        }),
        settings: byokSettings("openai")
      }
    );

    expect(validationStarted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.agent).toBeUndefined();
    expect(result.summary.status).toBe("cancelled");
    expect(result.stages.find((stage) => stage.stage === "brief")?.status).toBe("cancelled");
    expect(result.events.at(-1)).toMatchObject({ status: "cancelled", type: "run-cancelled" });
  });

  it("cancels a BYOK run while Keychain credential retrieval is pending", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const credentialStore: DesktopCredentialStore = {
      available: true,
      label: "Pending Keychain",
      getPassword(_service, _account, options) {
        receivedSignal = options?.signal;
        queueMicrotask(() => abortController.abort("Stop Keychain lookup."));
        return new Promise(() => undefined);
      },
      async setPassword() {
        return undefined;
      },
      async deletePassword() {
        return undefined;
      }
    };

    const result = await runDesktopByokAgent(
      {
        brief: "Cancel credential lookup.",
        projectPath,
        runExport: false,
        runId: "run-byok-cancel-keychain"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        signal: abortController.signal,
        credentialStore,
        settings: byokSettings("openai")
      }
    );

    expect(receivedSignal).toBe(abortController.signal);
    expect(result.ok).toBe(false);
    expect(result.summary.status).toBe("cancelled");
    expect(result.events.at(-1)).toMatchObject({ status: "cancelled", type: "run-cancelled" });
  });

  it("fails a BYOK run when Keychain credential retrieval exceeds its timeout", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const credentialStore: DesktopCredentialStore = {
      available: true,
      label: "Pending Keychain",
      getPassword: () => new Promise(() => undefined),
      async setPassword() {
        return undefined;
      },
      async deletePassword() {
        return undefined;
      }
    };

    const result = await runDesktopByokAgent(
      {
        brief: "Bound credential lookup.",
        projectPath,
        runExport: false,
        runId: "run-byok-timeout-keychain"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialAccessTimeoutMs: 20,
        credentialStore,
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.summary.status).toBe("failed");
    expect(result.error).toBe("Pending Keychain credential retrieval timed out after 20ms.");
  });

  it("fails a BYOK run when credential validation exceeds its bounded preflight timeout", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    const result = await runDesktopByokAgent(
      {
        brief: "Bound credential validation.",
        projectPath,
        runExport: false,
        runId: "run-byok-timeout-preflight"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-timeout-secret"
        }),
        credentialValidationTimeoutMs: 20,
        providerFactory: () => ({
          ...createSourceWriteTestProvider("Never Built"),
          validateCredentials: () => new Promise(() => undefined)
        }),
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.agent).toBeUndefined();
    expect(result.summary.status).toBe("failed");
    expect(result.error).toBe("Provider credential validation timed out after 20ms.");
    expect(JSON.stringify(result)).not.toContain("sk-timeout-secret");
  });

  it("runs the default OpenAI BYOK provider through injected fetch and applies source writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 0,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              deckpkg: path.join(projectPath, "exports", "openai.deckpkg"),
              pdf: path.join(projectPath, "exports", "openai.pdf")
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };
    const credentialStore = createFakeCredentialStore({
      "app.htmlslide.ai-key:provider:openai": "sk-openai-secret"
    });
    const providerFetch = createOpenAiByokFetch("BYOK OpenAI Deck");

    const result = await runDesktopByokAgent(
      {
        brief: "Create a deck through the real provider adapter.",
        projectPath,
        runId: "run-byok-openai",
        targetSlideCount: 1
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        credentialStore,
        providerFetch: providerFetch.fetch,
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(true);
    expect(result.agent?.ok).toBe(true);
    expect(result.applied).toMatchObject({
      filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
      source: "provider-source-writes",
      writeCount: 3
    });
    expect(result.checkpointDiff?.summary).toMatchObject({
      added: 0,
      changed: 3,
      deleted: 0
    });
    expect(result.project?.project).toMatchObject({
      path: projectPath,
      title: "BYOK OpenAI Deck"
    });
    const deck = JSON.parse(await readFile(path.join(projectPath, "deck.json"), "utf8"));
    expect(deck.title).toBe("BYOK OpenAI Deck");
    expect(JSON.stringify(result.logs)).not.toContain("sk-openai-secret");
    const reportText = await readFile(path.join(projectPath, ".htmlslide", "reports", "latest-agent-run.json"), "utf8");
    const report = JSON.parse(reportText) as DesktopAgentRunReport;
    expect(result.agentReportPath).toBe(path.join(projectPath, ".htmlslide", "reports", "agent-run-run-byok-openai.json"));
    expect(report).toMatchObject({
      kind: "htmlslide-agent-run-report",
      provider: {
        model: "gpt-5-mini",
        provider: "openai"
      },
      providerId: "htmlslide-byok",
      runId: "run-byok-openai",
      status: "succeeded"
    });
    expect(report.outputs.outline?.slides.map((slide) => slide.id)).toEqual(["001-title"]);
    expect(report.outputs.visualDirection?.directions.map((direction) => direction.id)).toEqual(["direction-provider"]);
    expect(report.outputs.build).toMatchObject({
      sourceWriteCount: 3,
      sourceWritePaths: ["deck.json", "slides/001-title.html", "notes/001-title.md"]
    });
    expect(report.applied).toMatchObject({
      filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
      source: "provider-source-writes",
      writeCount: 3
    });
    expect(report.cli.export?.artifactPaths).toEqual([
      path.join(projectPath, "exports", "openai.deckpkg"),
      path.join(projectPath, "exports", "openai.pdf")
    ]);
    expect(reportText).not.toContain("sk-openai-secret");
    expect(reportText).not.toContain("Provider source write");
    expect(reportText).not.toContain("Generated through provider source writes");
    expect(reportText).not.toContain('"content":');
    for (const file of await readProjectTextFiles(projectPath)) {
      expect(file.text, file.path).not.toContain("sk-openai-secret");
    }
    expect(providerFetch.calls[0]).toMatchObject({
      method: "GET",
      url: "https://api.openai.com/v1/models/gpt-5-mini"
    });
    const completionCalls = providerFetch.calls.filter((call) => call.url === "https://api.openai.com/v1/chat/completions");
    expect(completionCalls.length).toBeGreaterThan(0);
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);
  });

  it("runs compatible BYOK providers against the configured base URL", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
            issues: []
          }
        };
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };
    const credentialStore = createFakeCredentialStore({
      "app.htmlslide.ai-key:provider:compatible": "provider-token-secret"
    });
    const providerFetch = createOpenAiByokFetch("Compatible BYOK Deck");

    const result = await runDesktopByokAgent(
      {
        brief: "Create through compatible endpoint.",
        projectPath,
        runExport: false,
        runId: "run-byok-compatible"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        credentialStore,
        providerFetch: providerFetch.fetch,
        settings: byokSettings("compatible", {
          baseUrl: "https://compatible.example.test/v1",
          model: "gpt-5-mini"
        })
      }
    );

    expect(result.ok).toBe(true);
    expect(result.settings).toMatchObject({
      baseUrl: "https://compatible.example.test/v1",
      model: "gpt-5-mini",
      provider: "compatible"
    });
    const report = JSON.parse(
      await readFile(path.join(projectPath, ".htmlslide", "reports", "latest-agent-run.json"), "utf8")
    ) as DesktopAgentRunReport;
    expect(report.provider).toEqual({
      baseUrlSha256: "6e067d1e19d6075c41b9ece4d7d9524ac78e3313fe346f719ae46c5c98d4b072",
      model: "gpt-5-mini",
      provider: "compatible"
    });
    expect(report.provider).not.toHaveProperty("baseUrl");
    expect(providerFetch.calls[0]?.url).toBe("https://compatible.example.test/v1/models/gpt-5-mini");
    expect(providerFetch.calls.some((call) => call.url === "https://compatible.example.test/v1/chat/completions")).toBe(true);
    expect(JSON.stringify(result.logs)).not.toContain("provider-token-secret");
    expect(calls).toEqual([["check", projectPath, "--json"]]);
  });

  it("blocks compatible BYOK runs without a base URL", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];

    const result = await runDesktopByokAgent(
      {
        brief: "Create through compatible endpoint.",
        projectPath,
        runId: "run-byok-compatible-missing-base-url"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:compatible": "provider-token-secret"
        }),
        cliRunner: async (args) => {
          calls.push(args);
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        settings: byokSettings("compatible")
      }
    );

    expect(result).toMatchObject({
      error: "OpenAI-compatible BYOK provider requires a base URL in AI Engines settings.",
      ok: false,
      providerId: "htmlslide-byok",
      summary: {
        provider: "compatible",
        status: "failed"
      }
    });
    expect(result.agent).toBeUndefined();
    expect(JSON.stringify(result.logs)).not.toContain("provider-token-secret");
    expect(calls).toEqual([]);
  });

  it("runs Anthropic BYOK providers through injected fetch and applies source writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 0,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              deckpkg: path.join(projectPath, "exports", "anthropic.deckpkg"),
              pdf: path.join(projectPath, "exports", "anthropic.pdf")
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };
    const credentialStore = createFakeCredentialStore({
      "app.htmlslide.ai-key:provider:anthropic": "anthropic-secret"
    });
    const providerFetch = createAnthropicByokFetch("BYOK Anthropic Deck");

    const result = await runDesktopByokAgent(
      {
        brief: "Create through Anthropic.",
        projectPath,
        runId: "run-byok-anthropic"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        credentialStore,
        providerFetch: providerFetch.fetch,
        settings: byokSettings("anthropic")
      }
    );

    expect(result.ok).toBe(true);
    expect(result.agent?.ok).toBe(true);
    expect(result.applied).toMatchObject({
      filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
      source: "provider-source-writes",
      writeCount: 3
    });
    expect(result.project?.project).toMatchObject({
      path: projectPath,
      title: "BYOK Anthropic Deck"
    });
    expect(JSON.stringify(result.logs)).not.toContain("anthropic-secret");
    expect(providerFetch.calls[0]).toMatchObject({
      method: "GET",
      url: "https://api.anthropic.com/v1/models/claude-sonnet-4-5"
    });
    const completionCalls = providerFetch.calls.filter((call) => call.url === "https://api.anthropic.com/v1/messages");
    expect(completionCalls.length).toBeGreaterThan(0);
    const firstCompletionBody = completionCalls[0]?.body as { tool_choice?: { type?: string; name?: string } };
    expect(firstCompletionBody.tool_choice).toEqual({
      type: "tool",
      name: "htmlslide_brief_output"
    });
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);
  });

  it("runs the BYOK desktop agent only after loading a stored provider key", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 0,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              deckpkg: path.join(projectPath, "exports", "byok.deckpkg"),
              pdf: path.join(projectPath, "exports", "byok.pdf")
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };
    const credentialStore = createFakeCredentialStore({
      "app.htmlslide.ai-key:provider:openai": "sk-test-secret"
    });
    const providerInputs: Array<{ apiKey: string; baseUrl?: string; model: string; provider: string }> = [];
    let credentialValidationCalls = 0;
    let chosenDirections = 0;

    const result = await runDesktopByokAgent(
      {
        brief: "Create a deck through the built-in HTMLslide Agent.",
        projectPath,
        runId: "run-byok-test",
        targetSlideCount: 1
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        credentialStore,
        providerFactory: (input) => {
          providerInputs.push(input);
          const provider = createSourceWriteTestProvider("Injected BYOK Deck");
          return {
            ...provider,
            async validateCredentials() {
              credentialValidationCalls += 1;
              return { ok: true };
            }
          };
        },
        chooseVisualDirection: (directions) => {
          chosenDirections = directions.length;
          return directions[0]?.id ?? "";
        },
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("htmlslide-byok");
    expect(result.settings).toMatchObject({
      model: "gpt-5-mini",
      provider: "openai"
    });
    expect(providerInputs).toEqual([
      {
        apiKey: "sk-test-secret",
        baseUrl: undefined,
        model: "gpt-5-mini",
        provider: "openai"
      }
    ]);
    expect(credentialValidationCalls).toBe(1);
    expect(chosenDirections).toBe(2);
    expect(result.agent?.ok).toBe(true);
    expect(result.summary).toMatchObject({
      checkStatus: "passed",
      exportStatus: "passed",
      model: "gpt-5-mini",
      provider: "openai",
      runId: "run-byok-test",
      status: "succeeded"
    });
    expect(result.summary.exportArtifacts).toEqual([
      path.join(projectPath, "exports", "byok.deckpkg"),
      path.join(projectPath, "exports", "byok.pdf")
    ]);
    expect(result.applied).toMatchObject({
      filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
      source: "provider-source-writes",
      writeCount: 3
    });
    expect(result.project?.project).toMatchObject({
      path: projectPath,
      title: "Injected BYOK Deck"
    });
    expect(JSON.stringify(result.logs)).not.toContain("sk-test-secret");
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);
  });

  it("skips BYOK export when the real CLI check fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const result = await runDesktopByokAgent(
      {
        brief: "Create a deck that fails real check.",
        projectPath,
        runId: "run-byok-check-failed",
        targetSlideCount: 1
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: async (args) => {
          calls.push(args);
          if (args[0] === "check") {
            return {
              ok: false,
              exitCode: 2,
              stdout: "",
              stderr: "",
              json: {
                status: "failed",
                summary: { errors: 1, warnings: 0, info: 0, suggestions: 0 },
                issues: [{ severity: "error", type: "missing-notes", message: "Missing notes." }]
              }
            };
          }
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-check-failed"
        }),
        providerFactory: () => createSourceWriteTestProvider("BYOK Failed Check Deck"),
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.agent?.ok).toBe(true);
    expect(result.check?.ok).toBe(false);
    expect(result.export).toBeUndefined();
    expect(result.summary).toMatchObject({
      checkErrors: 1,
      checkStatus: "failed",
      exportArtifacts: []
    });
    expect(calls).toEqual([["check", projectPath, "--json"]]);
  });

  it("applies BYOK repair source writes after build source writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const provider = createMockProvider({ id: "test-byok-repair-provider" });
    const result = await runDesktopByokAgent(
      {
        brief: "Create and repair a deck.",
        projectPath,
        runId: "run-byok-repair-writes",
        targetSlideCount: 1
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: async (args) => {
          calls.push(args);
          if (args[0] === "check") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                status: "passed",
                summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
                issues: []
              }
            };
          }
          if (args[0] === "export") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                status: "passed",
                artifacts: { pdf: path.join(projectPath, "exports", "repair.pdf") }
              }
            };
          }
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-repair-secret"
        }),
        providerFactory: () => ({
          id: "test-byok-repair-provider",
          label: "Test BYOK Repair Provider",
          async validateCredentials() {
            return { ok: true };
          },
          async complete(request) {
            const response = await provider.complete(request);
            if (request.stage === "build") {
              return {
                ...response,
                output: {
                  ...(response.output as Record<string, unknown>),
                  sourceWrites: byokSourceWrites("BYOK Repair Deck")
                }
              };
            }
            if (request.stage === "repair") {
              return {
                ...response,
                output: {
                  ...(response.output as Record<string, unknown>),
                  sourceWrites: [
                    {
                      path: "notes/001-title.md",
                      content: "# BYOK Repair Deck\n\nRepair notes overwrite build notes.\n"
                    }
                  ]
                }
              };
            }
            return response;
          }
        }),
        settings: byokSettings("openai")
      }
    );

    expect(result.ok).toBe(true);
    expect(result.agent?.outputs.repairs).toHaveLength(1);
    expect(result.applied?.stages).toEqual([
      {
        filesChanged: ["deck.json", "slides/001-title.html", "notes/001-title.md"],
        stage: "build",
        writeCount: 3
      },
      {
        attempt: 1,
        filesChanged: ["notes/001-title.md"],
        stage: "repair",
        writeCount: 1
      }
    ]);
    await expect(readFile(path.join(projectPath, "notes", "001-title.md"), "utf8")).resolves.toContain(
      "Repair notes overwrite build notes."
    );
    expect(JSON.stringify(result.logs)).not.toContain("sk-repair-secret");
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);
  });

  it("blocks BYOK desktop agent runs when settings metadata has no stored key", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const result = await runDesktopByokAgent(
      {
        brief: "Create a deck through the built-in HTMLslide Agent.",
        projectPath,
        runId: "run-byok-missing-key"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialStore: createFakeCredentialStore(),
        cliRunner: async (args) => {
          calls.push(args);
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        settings: byokSettings("openai")
      }
    );

    expect(result).toMatchObject({
      error: "Stored openai API key was not found. Save the key again in AI Engines settings.",
      ok: false,
      providerId: "htmlslide-byok",
      summary: {
        failedStages: 1,
        model: "gpt-5-mini",
        provider: "openai",
        runId: "run-byok-missing-key",
        status: "failed"
      }
    });
    expect(result.events.at(-1)).toMatchObject({
      stage: "brief",
      status: "failed"
    });
    expect(result.agent).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("blocks BYOK desktop agent runs when provider credential validation fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const result = await runDesktopByokAgent(
      {
        brief: "Create a deck through the built-in HTMLslide Agent.",
        projectPath,
        runId: "run-byok-invalid-key"
      },
      {
        cliRuntime: TEST_CLI_RUNTIME,
        credentialStore: createFakeCredentialStore({
          "app.htmlslide.ai-key:provider:openai": "sk-invalid-secret"
        }),
        cliRunner: async (args) => {
          calls.push(args);
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        providerFactory: () => ({
          id: "test-invalid-byok-provider",
          label: "Invalid BYOK Provider",
          async validateCredentials() {
            return {
              ok: false,
              reason: "Provider rejected the stored API key.",
              recoverable: true
            };
          },
          async complete() {
            throw new Error("Provider complete should not run after credential validation failure.");
          }
        }),
        settings: byokSettings("openai")
      }
    );

    expect(result).toMatchObject({
      error: "Provider rejected the stored API key.",
      ok: false,
      providerId: "htmlslide-byok",
      summary: {
        failedStages: 1,
        runId: "run-byok-invalid-key",
        status: "failed"
      }
    });
    expect(JSON.stringify(result.logs)).not.toContain("sk-invalid-secret");
    expect(result.agent).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("skips export when real project check fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "",
        json: {
          status: "failed",
          summary: {
            errors: 1,
            warnings: 0,
            info: 0,
            suggestions: 0
          },
          issues: [{ severity: "error", type: "missing-file", message: "Missing slide source." }]
        }
      };
    };

    const result = await runDesktopMockAgent(
      {
        brief: "Check without exporting",
        projectPath
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner
      }
    );

    expect(result.ok).toBe(false);
    expect(result.agent.ok).toBe(true);
    expect(result.check?.ok).toBe(false);
    expect(result.export).toBeUndefined();
    expect(result.summary).toMatchObject({
      checkErrors: 1,
      checkStatus: "failed"
    });
    expect(calls).toEqual([["check", projectPath, "--json"]]);
  });

  it("propagates cancellation into desktop CLI check and does not start export", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const abortController = new AbortController();
    const calls: string[][] = [];
    let receivedSignal: AbortSignal | undefined;

    const result = await runDesktopMockAgent(
      {
        brief: "Cancel during the real check boundary.",
        projectPath,
        runId: "run-mock-cancel-during-check"
      },
      {
        signal: abortController.signal,
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: async (args, options) => {
          calls.push(args);
          receivedSignal = options.signal;
          expect(args[0]).toBe("check");
          abortController.abort("Stop during desktop check.");
          return {
            ok: false,
            exitCode: 6,
            stdout: "",
            stderr: "",
            error: "check cancelled"
          };
        }
      }
    );

    expect(receivedSignal).toBe(abortController.signal);
    expect(calls).toEqual([["check", projectPath, "--json"]]);
    expect(result.ok).toBe(false);
    expect(result.export).toBeUndefined();
    expect(result.project).toBeUndefined();
    expect(result.agent.status).toBe("cancelled");
    expect(result.summary.status).toBe("cancelled");
    expect(result.events.at(-1)).toMatchObject({
      sequence: result.events.length,
      status: "cancelled",
      type: "run-cancelled"
    });
    expect(result.stages.find((stage) => stage.stage === "check")?.status).toBe("cancelled");
  });

  it("waits for a desktop CLI process to exit after escalating cancellation", async () => {
    const root = await tempDir();
    const scriptPath = path.join(root, "stubborn-cli.mjs");
    const readyPath = path.join(root, "ready.txt");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => undefined);
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => undefined, 1000);
`, "utf8");
    const abortController = new AbortController();
    const run = runHtmlslideCli([readyPath], {
      cliPath: scriptPath,
      cwd: root,
      signal: abortController.signal,
      timeoutMs: 5_000
    });

    let pid: number | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && pid === undefined) {
      try {
        pid = Number(await readFile(readyPath, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(pid).toBeTypeOf("number");
    abortController.abort("Stop stubborn CLI.");
    const result = await run;

    let processStillAlive = false;
    try {
      process.kill(pid as number, 0);
      processStillAlive = true;
    } catch {
      processStillAlive = false;
    }
    if (processStillAlive) {
      process.kill(pid as number, "SIGKILL");
    }
    expect(processStillAlive).toBe(false);
    expect(result).toMatchObject({ ok: false, exitCode: 6 });
    expect(result.error).toContain("cancelled: Stop stubborn CLI.");
  });

  it("bounds desktop CLI stdout and stderr captures while draining the process", async () => {
    const root = await tempDir();
    const scriptPath = path.join(root, "noisy-cli.mjs");
    await writeFile(scriptPath, `
process.stdout.write("o".repeat(${COMMAND_CAPTURE_LIMIT_CHARS + 16_384}));
process.stderr.write("e".repeat(${COMMAND_CAPTURE_LIMIT_CHARS + 16_384}));
`, "utf8");

    const result = await runHtmlslideCli([], {
      cliPath: scriptPath,
      cwd: root,
      timeoutMs: 5_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(COMMAND_CAPTURE_LIMIT_CHARS + COMMAND_CAPTURE_TRUNCATION_MARKER.length);
    expect(result.stderr.length).toBe(COMMAND_CAPTURE_LIMIT_CHARS + COMMAND_CAPTURE_TRUNCATION_MARKER.length);
    expect(result.stdout.match(/output truncated/gu)).toHaveLength(1);
    expect(result.stderr.match(/output truncated/gu)).toHaveLength(1);
  });

  it("bounds and sanitizes desktop agent metadata before service storage", () => {
    const secret = "sk-metadatasecret123456789";
    let deep: JsonObject = { value: secret };
    for (let index = 0; index < 20; index += 1) {
      deep = { child: deep };
    }
    const metadata = {
      deep,
      items: Array.from({ length: 500 }, () => ({
        message: `api_key=${secret} ${"x".repeat(10_000)}`,
        values: Array.from({ length: 500 }, () => secret)
      }))
    } as JsonObject;

    const sanitized = sanitizeDesktopAgentMetadata(metadata);
    const serialized = JSON.stringify(sanitized);
    const items = sanitized?.items as JsonObject[];

    expect(items).toHaveLength(100);
    expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(100_000);
    expect(JSON.stringify(sanitized?.deep)).not.toContain("value");
  });

  it("runs a configured generic external agent through check and export", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const scriptFile = await writeExternalAgentScript(
      projectPath,
      "edit-slide",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const promptFile = requireArg(args, "--prompt-file");
const manifestFile = requireArg(args, "--writes-manifest");
const slideFile = path.join(projectRoot, "slides", "001-title.html");
const leakedKey = "sk-" + "external-secret123456";
const githubToken = "github_pat_1234567890abcdefghijklmnop";
console.log("external stream started");
console.log("api_key=" + leakedKey);
console.log(githubToken);
fs.readFileSync(promptFile, "utf8");
fs.writeFileSync(slideFile, '<section class="slide" data-slide-id="001-title"><h1>Edited externally</h1><ul><li>External point</li></ul></section>\\n');
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["slides/001-title.html"] }));
console.error("external stream wrote manifest");
console.error("Bearer " + leakedKey);
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );
    const commandTemplate = `"${process.execPath}" "${scriptFile}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);

      if (args[0] === "check") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            summary: {
              errors: 0,
              warnings: 0,
              info: 0,
              suggestions: 0
            },
            issues: []
          }
        };
      }

      if (args[0] === "export") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          json: {
            status: "passed",
            artifacts: {
              deckpkg: path.join(projectPath, "exports", "desktop-test.deckpkg"),
              pdf: path.join(projectPath, "exports", "desktop-test.pdf")
            }
          }
        };
      }

      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    };

    const result = await runDesktopExternalAgent(
      {
        brief: "Tighten the title slide.",
        projectPath,
        runId: "run-external-test"
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        cliRunner: runner,
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("external-agent");
    expect(result.adapter?.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-external-secret123456");
    expect(JSON.stringify(result)).not.toContain("github_pat_1234567890abcdefghijklmnop");
    if (result.adapter?.ok === true) {
      expect(result.adapter.stdout).toContain("api_key=[redacted]");
      expect(result.adapter.stderr).toContain("Bearer [redacted]");
      expect(result.adapter.stdout).not.toContain("sk-external-secret123456");
      expect(result.adapter.stderr).not.toContain("sk-external-secret123456");
    }
    expect(result.summary).toMatchObject({
      checkStatus: "passed",
      exportStatus: "passed",
      filesChanged: ["slides/001-title.html"],
      runId: "run-external-test",
      status: "succeeded"
    });
    expect(result.summary.exportArtifacts).toEqual([
      path.join(projectPath, "exports", "desktop-test.deckpkg"),
      path.join(projectPath, "exports", "desktop-test.pdf")
    ]);
    expect(result.checkpointDiff?.summary).toMatchObject({
      changed: 1,
      added: 0,
      deleted: 0
    });
    expect(result.project?.slides[0]).toMatchObject({
      id: "001-title",
      sourcePath: "slides/001-title.html"
    });
    expect(result.project?.slides[0]).not.toHaveProperty("html");
    const stdoutLogText = result.logs
      .filter((log) => log.metadata?.stream === "stdout")
      .map((log) => log.message)
      .join("\n");
    const logText = result.logs.map((log) => log.message).join("\n");
    expect(stdoutLogText).toContain("external stream started");
    expect(stdoutLogText).toContain("api_key=[redacted]");
    expect(logText).toContain("external stream wrote manifest");
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).not.toContain("sk-external-secret123456");
    expect(calls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);

    const prompt = await readFile(path.join(projectPath, ".htmlslide", "runs", "run-external-test", "prompt.md"), "utf8");
    expect(prompt).toContain("Tighten the title slide.");
    expect(prompt).toContain("deck.json, slides/, notes/, theme/, or assets/");
    for (const file of await readProjectTextFiles(projectPath)) {
      expect(file.text, file.path).not.toContain("sk-external-secret123456");
    }
  });

  it("passes external cancellation to the adapter and streams redacted logs without CLI follow-up", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const abortController = new AbortController();
    const cliCalls: string[][] = [];
    const observedLogs: AgentRunLog[] = [];
    let receivedSignal: AbortSignal | undefined;
    let logDeliveredInsideRunner = false;
    const commandTemplate = "fake-agent --project \"{{projectPath}}\" --prompt-file \"{{promptFile}}\" --writes-manifest \"{{writeManifest}}\"";

    const result = await runDesktopExternalAgent(
      {
        brief: "Cancel the fake external agent.",
        projectPath,
        runId: "run-external-cancel"
      },
      {
        signal: abortController.signal,
        agentRunner: async (invocation) => {
          receivedSignal = invocation.signal;
          invocation.onOutput?.({
            stream: "stdout",
            text: "api_key=sk-external-observer-"
          });
          expect(observedLogs.some((log) => log.metadata?.stream === "stdout")).toBe(false);
          invocation.onOutput?.({
            stream: "stdout",
            text: "secret123456\n"
          });
          logDeliveredInsideRunner = observedLogs.some((log) => log.message === "api_key=[redacted]");
          abortController.abort("Stop external run.");
          return {
            exitCode: 1,
            stdout: "api_key=sk-external-observer-secret123456",
            stderr: "",
            cancelled: true
          };
        },
        cliRunner: async (args) => {
          cliCalls.push(args);
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        onLog: (log) => observedLogs.push(log),
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(receivedSignal).toBe(abortController.signal);
    expect(logDeliveredInsideRunner).toBe(true);
    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.summary.status).toBe("cancelled");
    expect(result.check).toBeUndefined();
    expect(result.export).toBeUndefined();
    expect(result.adapter?.status).toBe("cancelled");
    expect(result.adapter?.adapter.capabilities.cancelRun).toBe(true);
    expect(result.logs).toEqual(observedLogs);
    expect(JSON.stringify(result)).not.toContain("sk-external-observer-secret123456");
  });

  it.each([
    { selectedId: "claude-code" as const, command: "claude", expectedArg: "--print" },
    { selectedId: "codex-cli" as const, command: "codex", expectedArg: "workspace-write" }
  ])("runs the built-in $selectedId adapter through checkpoint, check, export, and diff", async ({
    command,
    expectedArg,
    selectedId
  }) => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    await writeFile(path.join(projectPath, "README.md"), "Real project guidance.\n", "utf8");
    const cliCalls: string[][] = [];
    const agentInvocations: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    let taskPrompt = "";

    const result = await runDesktopExternalAgent(
      {
        brief: `Edit this deck with ${selectedId}.`,
        projectPath,
        runId: `run-${selectedId}`
      },
      {
        cliRuntime: {
          cliPath: "/fake/htmlslide.js",
          cwd: "/fake",
          mode: "development",
          rootPath: "/fake"
        },
        externalAgentStatuses: [readyExternalAgentStatus(selectedId)],
        agentRunner: async (invocation) => {
          agentInvocations.push({
            command: invocation.command,
            args: invocation.args,
            cwd: invocation.cwd
          });
          const promptArgument = invocation.args.at(-1) ?? "";
          const promptPath = /instructions in (.+?\.md)\./u.exec(promptArgument)?.[1];
          if (promptPath === undefined) {
            throw new Error(`Built-in adapter prompt did not reference a task file: ${promptArgument}`);
          }
          taskPrompt = await readFile(promptPath, "utf8");
          await writeFile(
            path.join(invocation.cwd, "slides", "001-title.html"),
            `<section class="slide" data-slide-id="001-title"><h1>Edited by ${selectedId}</h1></section>\n`,
            "utf8"
          );
          await writeFile(path.join(invocation.cwd, "README.md"), "Unexpected guidance edit.\n", "utf8");
          await mkdir(path.join(invocation.cwd, "exports"), { recursive: true });
          await writeFile(path.join(invocation.cwd, "exports", "unexpected.txt"), "discard me\n", "utf8");
          invocation.onOutput?.({
            stream: "stdout",
            text: `${selectedId} edit complete github_pat_1234567890abcdefghijklmnop\n`
          });
          return {
            exitCode: 0,
            stdout: `${selectedId} edit complete github_pat_1234567890abcdefghijklmnop`,
            stderr: ""
          };
        },
        cliRunner: async (args) => {
          cliCalls.push(args);
          if (args[0] === "check") {
            return {
              exitCode: 0,
              json: { status: "passed", summary: { errors: 0, warnings: 0, info: 0 } },
              ok: true,
              stderr: "",
              stdout: ""
            };
          }
          if (args[0] === "export") {
            return {
              exitCode: 0,
              json: { status: "passed", artifacts: { pdf: path.join(projectPath, "exports", "deck.pdf") } },
              ok: true,
              stderr: "",
              stdout: ""
            };
          }
          throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
        },
        settings: externalAgentSettings("", selectedId)
      }
    );

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("external-agent");
    expect(result.adapter?.adapter.kind).toBe(selectedId);
    expect(JSON.stringify(result)).not.toContain("github_pat_1234567890abcdefghijklmnop");
    expect(result.adapter?.stdout).toBe("[built-in structured output omitted]");
    expect(result.summary.filesChanged).toEqual(["slides/001-title.html"]);
    expect(result.checkpointDiff?.summary.changed).toBe(1);
    expect(agentInvocations).toHaveLength(1);
    expect(agentInvocations[0]?.command).toBe(command);
    expect(agentInvocations[0]?.cwd).not.toBe(projectPath);
    expect(path.basename(agentInvocations[0]?.cwd ?? "")).toMatch(/^htmlslide-agent-workspace-/u);
    expect(agentInvocations[0]?.args).toContain(expectedArg);
    expect(taskPrompt).not.toContain("## Write manifest");
    expect(taskPrompt).not.toContain("writes.json");
    expect(taskPrompt).not.toContain(projectPath);
    await expect(readFile(path.join(projectPath, "README.md"), "utf8")).resolves.toBe("Real project guidance.\n");
    await expect(access(path.join(projectPath, "exports", "unexpected.txt"))).rejects.toThrow();
    await expect(access(agentInvocations[0]?.cwd ?? "")).rejects.toThrow();
    expect(cliCalls).toEqual([
      ["check", projectPath, "--json"],
      ["export", projectPath, "--json"]
    ]);
  });

  it("rejects source symlinks before a built-in external agent starts", async () => {
    const projectPath = await tempDir();
    const outsidePath = await tempDir();
    await writeDeck(projectPath);
    await writeFile(path.join(outsidePath, "outside.txt"), "outside\n", "utf8");
    await mkdir(path.join(projectPath, "assets"), { recursive: true });
    await symlink(path.join(outsidePath, "outside.txt"), path.join(projectPath, "assets", "linked.txt"));
    let agentStarted = false;

    const result = await runDesktopExternalAgent(
      {
        brief: "Do not follow source symlinks.",
        projectPath,
        runId: "run-codex-symlink"
      },
      {
        agentRunner: async () => {
          agentStarted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        externalAgentStatuses: [readyExternalAgentStatus("codex-cli")],
        settings: externalAgentSettings("", "codex-cli")
      }
    );

    expect(agentStarted).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      providerId: "external-agent"
    });
    expect(result.error).toContain("do not follow symlinks");
  });

  it("cancels a built-in agent in its isolated workspace without applying staged source", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const originalSource = await readFile(path.join(projectPath, "slides", "001-title.html"), "utf8");
    const abortController = new AbortController();
    let isolatedWorkspace = "";
    let cliCalled = false;

    const result = await runDesktopExternalAgent(
      {
        brief: "Cancel before applying built-in output.",
        projectPath,
        runId: "run-codex-isolated-cancel"
      },
      {
        agentRunner: async (invocation) => {
          isolatedWorkspace = invocation.cwd;
          await writeFile(
            path.join(invocation.cwd, "slides", "001-title.html"),
            '<section class="slide" data-slide-id="001-title"><h1>Cancelled agent edit</h1></section>\n',
            "utf8"
          );
          abortController.abort("Cancel isolated built-in run.");
          return { cancelled: true, exitCode: 1, stdout: "cancelled", stderr: "" };
        },
        cliRunner: async () => {
          cliCalled = true;
          throw new Error("CLI must not run after cancellation.");
        },
        externalAgentStatuses: [readyExternalAgentStatus("codex-cli")],
        settings: externalAgentSettings("", "codex-cli"),
        signal: abortController.signal
      }
    );

    expect(result.summary.status).toBe("cancelled");
    expect(cliCalled).toBe(false);
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.toBe(originalSource);
    await expect(access(isolatedWorkspace)).rejects.toThrow();
  });

  it("rejects symlinked source paths created inside a built-in agent workspace", async () => {
    const projectPath = await tempDir();
    const outsidePath = await tempDir();
    await writeDeck(projectPath);
    await writeFile(
      path.join(outsidePath, "001-title.html"),
      '<section class="slide" data-slide-id="001-title"><h1>Outside source</h1></section>\n',
      "utf8"
    );

    const result = await runDesktopExternalAgent(
      {
        brief: "Reject runtime-created source symlinks.",
        projectPath,
        runId: "run-codex-runtime-symlink"
      },
      {
        agentRunner: async (invocation) => {
          await rm(path.join(invocation.cwd, "slides"), { recursive: true, force: true });
          await symlink(outsidePath, path.join(invocation.cwd, "slides"));
          return { exitCode: 0, stdout: "done", stderr: "" };
        },
        externalAgentStatuses: [readyExternalAgentStatus("codex-cli")],
        settings: externalAgentSettings("", "codex-cli")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("symlinked source path");
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.not.toContain(
      "Outside source"
    );
  });

  it("preserves concurrent real-project edits instead of overwriting them with built-in output", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const userEdit = '<section class="slide" data-slide-id="001-title"><h1>User edit</h1></section>\n';
    let cliCalled = false;

    const result = await runDesktopExternalAgent(
      {
        brief: "Do not overwrite concurrent user edits.",
        projectPath,
        runId: "run-codex-conflict"
      },
      {
        agentRunner: async (invocation) => {
          await writeFile(path.join(projectPath, "slides", "001-title.html"), userEdit, "utf8");
          await writeFile(
            path.join(invocation.cwd, "slides", "001-title.html"),
            '<section class="slide" data-slide-id="001-title"><h1>Agent edit</h1></section>\n',
            "utf8"
          );
          return { exitCode: 0, stdout: "done", stderr: "" };
        },
        cliRunner: async () => {
          cliCalled = true;
          throw new Error("CLI must not run after a source conflict.");
        },
        externalAgentStatuses: [readyExternalAgentStatus("codex-cli")],
        settings: externalAgentSettings("", "codex-cli")
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Project source changed while Codex CLI was running");
    expect(cliCalled).toBe(false);
    await expect(readFile(path.join(projectPath, "slides", "001-title.html"), "utf8")).resolves.toBe(userEdit);
  });

  it("bounds service-level external logs before registry delivery", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const abortController = new AbortController();
    const commandTemplate = "fake-agent --project \"{{projectPath}}\" --prompt-file \"{{promptFile}}\" --writes-manifest \"{{writeManifest}}\"";

    const result = await runDesktopExternalAgent(
      {
        brief: "Bound noisy command logs.",
        projectPath,
        runId: "run-external-log-limit"
      },
      {
        signal: abortController.signal,
        agentRunner: async (invocation) => {
          invocation.onOutput?.({
            stream: "stdout",
            text: Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n") + "\n"
          });
          abortController.abort("Stop noisy command.");
          return {
            exitCode: 1,
            stdout: "",
            stderr: "",
            cancelled: true
          };
        },
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(result.summary.status).toBe("cancelled");
    expect(result.logs).toHaveLength(500);
    expect(result.logs.at(-1)?.message).toBe("Desktop service log limit reached (500 records).");
  });

  it("keeps Gemini detection-only and requires a configured Generic command", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);

    const gemini = await runDesktopExternalAgent(
      {
        brief: "Edit the deck.",
        projectPath,
        runId: "run-gemini-blocked"
      },
      {
        settings: externalAgentSettings("", "gemini-cli")
      }
    );
    expect(gemini).toMatchObject({
      error: "Gemini CLI remains detection-only until its non-interactive authentication and permission contract is tested.",
      ok: false,
      providerId: "external-agent"
    });

    const emptyCommand = await runDesktopExternalAgent(
      {
        brief: "Edit the deck.",
        projectPath,
        runId: "run-empty-command"
      },
      {
        settings: externalAgentSettings("")
      }
    );
    expect(emptyCommand).toMatchObject({
      error: "Generic command template is required before running an external agent.",
      ok: false
    });
  });

  it("rechecks built-in readiness before creating a checkpoint or starting the command", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    let agentStarted = false;
    const notAuthenticated: DesktopExternalAgentStatus = {
      ...readyExternalAgentStatus("codex-cli"),
      authenticated: false,
      status: "not-authenticated",
      summary: "Login required"
    };

    const result = await runDesktopExternalAgent(
      {
        brief: "Do not start before readiness passes.",
        projectPath,
        runId: "run-codex-not-ready"
      },
      {
        agentRunner: async () => {
          agentStarted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        externalAgentStatuses: [notAuthenticated],
        settings: externalAgentSettings("", "codex-cli")
      }
    );

    expect(result).toMatchObject({ error: "Login required", ok: false });
    expect(agentStarted).toBe(false);
    await expect(access(path.join(projectPath, ".htmlslide", "checkpoints", "run-codex-not-ready"))).rejects.toThrow();
  });

  it("fails external agent runs that report artifact writes", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const scriptFile = await writeExternalAgentScript(
      projectPath,
      "forbidden-artifact",
      `
import fs from "node:fs";
import path from "node:path";
const args = readPairs(process.argv.slice(2));
const projectRoot = requireArg(args, "--project");
const manifestFile = requireArg(args, "--writes-manifest");
const exportFile = path.join(projectRoot, "exports", "bad.html");
fs.mkdirSync(path.dirname(exportFile), { recursive: true });
fs.writeFileSync(exportFile, "not a source edit");
fs.writeFileSync(manifestFile, JSON.stringify({ writes: ["exports/bad.html"] }));
function readPairs(argv) {
  const pairs = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    pairs.set(argv[index], argv[index + 1]);
  }
  return pairs;
}
function requireArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error("Missing " + name);
  return value;
}
`
    );
    const commandTemplate = `"${process.execPath}" "${scriptFile}" --project "{{projectPath}}" --prompt-file "{{promptFile}}" --writes-manifest "{{writeManifest}}"`;

    const result = await runDesktopExternalAgent(
      {
        brief: "Write an artifact.",
        projectPath,
        runId: "run-forbidden-artifact"
      },
      {
        settings: externalAgentSettings(commandTemplate)
      }
    );

    expect(result.ok).toBe(false);
    expect(result.adapter?.ok).toBe(false);
    if (result.adapter?.ok === false) {
      expect(result.adapter.failure.type).toBe("forbidden-file-write");
      expect(result.adapter.failure.path).toBe(path.join(projectPath, "exports", "bad.html"));
    }
    expect(result.check).toBeUndefined();
    expect(result.export).toBeUndefined();
  });

  it("returns a presenter preparation error when deckpkg export fails", async () => {
    const projectPath = await tempDir();
    await writeDeck(projectPath);
    const calls: string[][] = [];
    const runner: DesktopCliRunner = async (args) => {
      calls.push(args);
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "Export failed because the deck has blocking QA issues.",
        error: "Export failed"
      };
    };

    const result = await loadDesktopPresenterDeck(projectPath, {
      cliRuntime: {
        cliPath: "/fake/htmlslide.js",
        cwd: "/fake",
        mode: "development",
        rootPath: "/fake"
      },
      cliRunner: runner
    });

    expect(result).toMatchObject({
      error: "Export failed",
      ok: false,
      origin: "project-export",
      projectPath,
      source: "invalid"
    });
    expect(calls).toEqual([["export", projectPath, "--json"]]);
  });

  it("reads a standalone deck package without running a project export", async () => {
    const projectPath = await tempDir();
    const deckpkgPath = await writeExportedDeckPackage(projectPath);

    const result = await loadDesktopPresenterDeckPackage(deckpkgPath);

    expect(result).toMatchObject({
      ok: true,
      origin: "deckpkg-file",
      projectPath: undefined,
      deckpkgPath
    });
    expect(result.ok && result.deck.title).toBe("Desktop Test Deck");
    expect(result.ok && result.deck.slides).toHaveLength(1);
    expect(result.ok && result.deck.slides[0]?.notesMarkdown).toContain("Speaker note body.");
    expect(result.ok && result.deck.slides[0]?.html).toContain('data-slide-id="001-title"');
    expect(result.ok && result.deck.slides[0]?.htmlDocument).toContain('data-htmlslide-mode="present"');
    expect(result.ok && result.deck.slides[0]?.thumbnail.bytes.byteLength).toBe(0);
    expect(result.ok && result.deck.slides[0]?.thumbnail.dataUrl).toMatch(/^data:image\/png;base64,/u);
  }, 15_000);

  it("returns a missing result for a standalone deck package path that does not exist", async () => {
    const projectPath = await tempDir();
    const deckpkgPath = path.join(projectPath, "missing.deckpkg");

    const result = await loadDesktopPresenterDeckPackage(deckpkgPath);

    expect(result).toMatchObject({
      ok: false,
      origin: "deckpkg-file",
      source: "missing",
      deckpkgPath,
      error: "Deck package file was not found."
    });
  });

  it("returns validation issues for a malformed standalone deck package", async () => {
    const projectPath = await tempDir();
    const deckpkgPath = path.join(projectPath, "broken.deckpkg");
    await writeFile(deckpkgPath, "not a zip");

    const result = await loadDesktopPresenterDeckPackage(deckpkgPath);

    expect(result).toMatchObject({
      ok: false,
      origin: "deckpkg-file",
      source: "invalid",
      deckpkgPath,
      error: "Deck package validation failed."
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues?.some((issue) => issue.type === "invalid-deckpkg-archive")).toBe(true);
    }
  });

  it("normalizes presenter display targets with the primary display first", () => {
    const displays = listDesktopPresenterDisplays({
      getPrimaryDisplay: () => ({
        id: 20,
        internal: false,
        label: "",
        scaleFactor: 2,
        bounds: { x: 1920.4, y: 0, width: 2560.6, height: 1440.2 },
        workArea: { x: 1920, y: 24, width: 2560, height: 1416 }
      }),
      getAllDisplays: () => [
        {
          id: 10,
          internal: true,
          label: "Built-in Display",
          scaleFactor: 2,
          bounds: { x: 0, y: 0, width: 1728, height: 1117 },
          workArea: { x: 0, y: 37, width: 1728, height: 1080 }
        },
        {
          id: 20,
          internal: false,
          label: "",
          scaleFactor: 2,
          bounds: { x: 1920.4, y: 0, width: 2560.6, height: 1440.2 },
          workArea: { x: 1920, y: 24, width: 2560, height: 1416 }
        }
      ]
    });

    expect(displays).toEqual([
      {
        id: 20,
        label: "Primary display",
        primary: true,
        internal: false,
        scaleFactor: 2,
        bounds: { x: 1920, y: 0, width: 2561, height: 1440 },
        workArea: { x: 1920, y: 24, width: 2560, height: 1416 }
      },
      {
        id: 10,
        label: "Built-in Display",
        primary: false,
        internal: true,
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 1728, height: 1117 },
        workArea: { x: 0, y: 37, width: 1728, height: 1080 }
      }
    ]);
  });
});
