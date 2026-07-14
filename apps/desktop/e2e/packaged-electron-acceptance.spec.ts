import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { readDeckPackage } from "@htmlslide/presenter";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readPdfPageCount } from "../../../packages/compiler/src/index";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, "..", "..", "..");
const defaultPackagedAppPath = path.join(repoRoot, "dist", "alpha", "HTMLslide.app");
const packagedAppPath = process.env.HTMLSLIDE_PACKAGED_APP_PATH?.trim() ||
  (existsSync(defaultPackagedAppPath) ? defaultPackagedAppPath : undefined);
const execFile = promisify(execFileCallback);

const packagedE2eSlideIds = [
  "001-title",
  "002-problem",
  "003-workflow",
  "004-provider",
  "005-source",
  "006-validation",
  "007-export",
  "008-review"
] as const;

type FakeProvider = {
  baseUrl: string;
  calls: Array<{ method: string; path: string; stage?: string }>;
  close: () => Promise<void>;
};

function outlineSlides(title: string): Array<{
  id: string;
  title: string;
  kind: "title" | "content" | "data" | "closing";
  goal: string;
}> {
  return [
    { id: "001-title", title, kind: "title", goal: "Frame the packaged eight-slide generation proof." },
    { id: "002-problem", title: "Why local BYOK matters", kind: "content", goal: "Explain the local-first provider workflow." },
    { id: "003-workflow", title: "The generation workflow", kind: "content", goal: "Trace brief, outline, build, check, export, and review." },
    { id: "004-provider", title: "Provider contract", kind: "data", goal: "Show structured JSON from the compatible provider." },
    { id: "005-source", title: "Editable source output", kind: "content", goal: "Keep deck.json, HTML slides, and notes editable." },
    { id: "006-validation", title: "Check before export", kind: "content", goal: "Confirm the generated deck passes the shared check." },
    { id: "007-export", title: "Artifacts with page parity", kind: "content", goal: "Confirm export artifacts describe the same eight slides." },
    { id: "008-review", title: "Ready for review", kind: "closing", goal: "Summarize the complete packaged-app run." }
  ];
}

function sourcePaths(): string[] {
  return [
    "deck.json",
    ...packagedE2eSlideIds.map((slideId) => `slides/${slideId}.html`),
    ...packagedE2eSlideIds.map((slideId) => `notes/${slideId}.md`)
  ];
}

function exportArtifacts(): Array<{ type: "pdf" | "html" | "deckpkg" | "thumbnails" | "speaker-notes"; path: string }> {
  return [
    { type: "pdf", path: "exports/packaged-provider-e2e-deck.pdf" },
    { type: "html", path: "exports/packaged-provider-e2e-deck.html" },
    { type: "deckpkg", path: "exports/packaged-provider-e2e-deck.deckpkg" },
    { type: "speaker-notes", path: "exports/notes.json" },
    ...packagedE2eSlideIds.map((slideId) => ({
      type: "thumbnails" as const,
      path: `exports/thumbnails/${slideId}.png`
    }))
  ];
}

function sourceWrites(title: string): Array<{ path: string; content: string }> {
  const slides = outlineSlides(title);
  return [
    {
      path: "deck.json",
      content: `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          id: "deck_packaged_e2e",
          title,
          language: "en-US",
          aspectRatio: "16:9",
          viewport: { width: 1920, height: 1080 },
          speakerNotesMode: "full-script",
          export: { pdf: true, html: true, deckpkg: true, thumbnails: true, speakerNotes: true },
          slides: slides.map((slide) => ({
            id: slide.id,
            title: slide.title,
            source: `slides/${slide.id}.html`,
            notes: `notes/${slide.id}.md`,
            durationSec: 75,
            kind: slide.kind,
            status: "ready"
          }))
        },
        null,
        2
      )}\n`
    },
    ...slides.map((slide) => ({
      path: `slides/${slide.id}.html`,
      content: `<section class="slide" data-slide-id="${slide.id}"><h1>${slide.title}</h1><p>${slide.goal}</p></section>\n`
    })),
    ...slides.map((slide) => ({
      path: `notes/${slide.id}.md`,
      content: `# ${slide.title}\n\nDeck title: ${title}\n\nPackaged GUI provider generation acceptance. ${slide.goal}\n`
    }))
  ];
}

function stageOutput(stage: string | undefined, title: string): unknown {
  const slides = outlineSlides(title);
  switch (stage) {
    case "brief":
      return {
        title,
        brief: "Build an eight-slide packaged GUI provider deck.",
        language: "en-US",
        audience: "release reviewers",
        durationMinutes: 8
      };
    case "outline":
      return { title, language: "en-US", audience: "release reviewers", durationMinutes: 8, slides };
    case "visual-direction":
      return {
        directions: [{
          id: "direction-packaged-provider",
          label: "Packaged Provider Proof",
          rationale: "A readable provider-backed deck for packaged acceptance.",
          sampleSlideIds: [...packagedE2eSlideIds],
          tokens: { accent: "#2357d9", background: "#ffffff", text: "#111827" }
        }],
        selectedDirectionId: null
      };
    case "build":
      return {
        filesChanged: sourcePaths(),
        notesChanged: packagedE2eSlideIds.map((slideId) => `notes/${slideId}.md`),
        slidesChanged: [...packagedE2eSlideIds],
        themeChanged: [],
        sourceWrites: sourceWrites(title)
      };
    case "check":
      return { status: "passed", summary: { errors: 0, warnings: 0, info: 0 }, issues: [] };
    case "export":
      return { artifacts: exportArtifacts() };
    case "review":
      return {
        summary: "Packaged GUI provider generation is ready for review.",
        filesChanged: sourcePaths(),
        issuesRemaining: 0,
        nextActions: ["Review eight-slide deck", "Open presenter mode"]
      };
    default:
      throw new Error(`Unexpected packaged provider stage: ${stage ?? "unknown"}`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFakeProvider(title: string): Promise<FakeProvider> {
  const calls: FakeProvider["calls"] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/v1/models/gpt-5-mini") {
        calls.push({ method, path: url.pathname });
        writeJson(response, 200, { id: "gpt-5-mini" });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(request) as { messages?: Array<{ content?: string }> };
        const userContent = body.messages?.[1]?.content ?? "{}";
        const stage = (JSON.parse(userContent) as { stage?: string }).stage;
        calls.push({ method, path: url.pathname, stage });
        writeJson(response, 200, {
          choices: [{ message: { content: JSON.stringify(stageOutput(stage, title)) } }],
          usage: { completion_tokens: 9, prompt_tokens: 13, total_tokens: 22 }
        });
        return;
      }
      calls.push({ method, path: url.pathname });
      writeJson(response, 500, { error: { message: `Unexpected fake provider request: ${method} ${url.pathname}` } });
    } catch (error) {
      writeJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function packagedExecutable(appPath: string): Promise<string> {
  if (!appPath.endsWith(".app")) {
    await access(appPath);
    return appPath;
  }

  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plistPath]);
  const executablePath = path.join(appPath, "Contents", "MacOS", stdout.trim());
  await access(executablePath);
  return executablePath;
}

async function expectNoFrameworkOverlay(page: Page): Promise<void> {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator("[data-nextjs-dialog-overlay], #webpack-dev-server-client-overlay")).toHaveCount(0);
  await expect(page.getByText(/\[plugin:vite|Internal server error|Failed to resolve import|Failed to load module script/i)).toHaveCount(0);
}

async function chooseVisualDirection(page: Page): Promise<void> {
  const choicePanel = page.getByRole("region", { name: "Visual direction choices" });
  await expect(choicePanel).toBeVisible({ timeout: 30_000 });
  await expect(choicePanel.getByRole("button", { name: /Choose .* visual direction/ }).first()).toBeVisible();
  await choicePanel.getByRole("button", { name: /Choose .* visual direction/ }).first().click();
  await expect(choicePanel).toBeHidden({ timeout: 30_000 });
}

test.describe("HTMLslide packaged Electron acceptance", () => {
  test.describe.configure({ timeout: 180_000 });

  let electronApp: ElectronApplication | undefined;
  let tempRoot: string | undefined;

  test.afterEach(async () => {
    await electronApp?.close().catch(() => undefined);
    electronApp = undefined;
    if (tempRoot) {
      await rm(tempRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      tempRoot = undefined;
    }
  });

  test("generates and exports a real deck through the packaged GUI", async () => {
    test.skip(!packagedAppPath, "Set HTMLSLIDE_PACKAGED_APP_PATH or build dist/alpha/HTMLslide.app to run packaged acceptance.");
    if (!packagedAppPath) {
      return;
    }

    tempRoot = await mkdtemp(path.join(os.tmpdir(), "htmlslide-packaged-e2e-"));
    const fakeProviderTitle = "Packaged Provider E2E Deck";
    const fakeApiKey = "sk-packaged-e2e-provider-key";
    const fakeProvider = await startFakeProvider(fakeProviderTitle);
    const homeDir = path.join(tempRoot, "home");
    const userDataDir = path.join(tempRoot, "user-data");
    const workspaceDir = path.join(tempRoot, "workspace");
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true })
    ]);

    try {
      const executablePath = await packagedExecutable(packagedAppPath);
      const inheritedEnv = { ...process.env };
      delete inheritedEnv.HTMLSLIDE_CHROMIUM_EXECUTABLE;
      electronApp = await electron.launch({
        executablePath,
        args: [],
        env: {
          ...inheritedEnv,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
          HOME: homeDir,
          HTMLSLIDE_DEFAULT_WORKSPACE: workspaceDir,
          HTMLSLIDE_DISABLE_AUTO_CLI_PROVISIONING: "1",
          HTMLSLIDE_DISABLE_AUTO_SKILLS_PROVISIONING: "1",
          HTMLSLIDE_E2E_CREDENTIAL_STORE: "memory",
          HTMLSLIDE_USER_DATA_DIR: userDataDir
        }
      });

      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const setup = await page.evaluate(() => window.htmlslideDesktop.getSetup());
      expect(setup.cli.mode).toBe("packaged");
      expect(setup.cli.cliPath).toContain(path.join("Resources", "app", "cli-runtime"));

      await page.locator(".onboarding-actions").getByRole("button", { name: "Skip into No AI mode", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "AI Engines", exact: true }).click();
      await page.getByRole("button", { name: /HTMLslide Agent/ }).click();
      await page.getByLabel("Provider").selectOption("compatible");
      await page.getByLabel("Model").fill("gpt-5-mini");
      await page.getByLabel("Base URL").fill(fakeProvider.baseUrl);
      await page.getByLabel("API key").fill(fakeApiKey);
      await page.getByRole("button", { name: "Save Key", exact: true }).click();
      await expect(page.getByRole("status", { name: "AI engine operation status" })).toContainText("OpenAI-compatible key saved", {
        timeout: 30_000
      });

      await page.getByRole("button", { name: "Recent", exact: true }).click();
      await page.locator(".library-main").getByRole("button", { name: "New Deck", exact: true }).first().click();
      const newDeckPanel = page.locator(".new-deck-panel");
      await expect(newDeckPanel).toBeVisible();
      await newDeckPanel.getByLabel("Deck title").fill("Packaged Provider Demo");
      await newDeckPanel.getByLabel("Brief").fill("Create an eight-slide packaged GUI provider deck.");
      await newDeckPanel.getByRole("button", { name: /HTMLslide Agent/ }).click();
      await expect(newDeckPanel.getByText("Key ready")).toBeVisible();
      await newDeckPanel.getByLabel("Slides").selectOption("8");
      await newDeckPanel.getByLabel("Speaker notes").selectOption("full-script");
      await newDeckPanel.getByRole("button", { name: "Create & Generate", exact: true }).click();
      await chooseVisualDirection(page);

      await expect(page.getByText("HTMLslide Agent completed check and export")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText(/check: Check passed/)).toBeVisible();
      await expect(page.getByText(/export: [1-9][0-9]* artifacts/)).toBeVisible();
      await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();

      expect(fakeProvider.calls).toContainEqual({ method: "GET", path: "/v1/models/gpt-5-mini" });
      expect(fakeProvider.calls.map((call) => call.stage).filter(Boolean)).toEqual([
        "brief",
        "outline",
        "visual-direction",
        "build",
        "check",
        "export",
        "review"
      ]);

      const projectDir = await realpath(path.join(workspaceDir, "packaged-provider-demo"));
      const settingsText = await readFile(path.join(userDataDir, "ai-engine-settings.json"), "utf8");
      expect(settingsText).toContain(fakeProvider.baseUrl);
      expect(settingsText).not.toContain(fakeApiKey);

      const manifestText = await readFile(path.join(projectDir, "deck.json"), "utf8");
      const manifest = JSON.parse(manifestText) as {
        export?: Record<string, boolean>;
        speakerNotesMode?: string;
        slides?: Array<{ id: string; source: string; notes?: string }>;
        title?: string;
      };
      expect(manifest.title).toBe(fakeProviderTitle);
      expect(manifest.speakerNotesMode).toBe("full-script");
      expect(manifest.export).toEqual({ deckpkg: true, html: true, pdf: true, speakerNotes: true, thumbnails: true });
      expect(manifest.slides?.map((slide) => slide.id)).toEqual([...packagedE2eSlideIds]);
      expect(manifest.slides?.map((slide) => slide.source)).toEqual(packagedE2eSlideIds.map((id) => `slides/${id}.html`));
      expect(manifest.slides?.map((slide) => slide.notes)).toEqual(packagedE2eSlideIds.map((id) => `notes/${id}.md`));

      const sourceTexts = await Promise.all(sourcePaths().map((sourcePath) => readFile(path.join(projectDir, sourcePath), "utf8")));
      expect(sourceTexts).toHaveLength(17);
      expect(sourceTexts.join("\n")).toContain(fakeProviderTitle);
      const pdfPath = path.join(projectDir, "exports", "packaged-provider-e2e-deck.pdf");
      const htmlPath = path.join(projectDir, "exports", "packaged-provider-e2e-deck.html");
      const deckpkgPath = path.join(projectDir, "exports", "packaged-provider-e2e-deck.deckpkg");
      const notesJsonPath = path.join(projectDir, "exports", "notes.json");
      const thumbnailPaths = packagedE2eSlideIds.map((id) => path.join(projectDir, "exports", "thumbnails", `${id}.png`));
      await Promise.all([
        access(pdfPath),
        access(htmlPath),
        access(deckpkgPath),
        access(notesJsonPath),
        ...thumbnailPaths.map((thumbnailPath) => access(thumbnailPath))
      ]);
      expect(await readPdfPageCount(pdfPath)).toBe(8);
      const deckPackage = await readDeckPackage(deckpkgPath);
      expect(deckPackage.manifest.slideCount).toBe(8);
      expect(deckPackage.manifest.pageCount).toBe(8);
      expect(deckPackage.manifest.slides.map((slide) => slide.id)).toEqual([...packagedE2eSlideIds]);
      expect(deckPackage.slides).toHaveLength(8);
      expect(JSON.parse(await readFile(notesJsonPath, "utf8"))).toMatchObject({ slideCount: 8 });

      const exportManifestText = await readFile(path.join(projectDir, "exports", "export-manifest.json"), "utf8");
      const exportManifest = JSON.parse(exportManifestText) as { artifacts?: unknown[] };
      expect(exportManifest.artifacts).toHaveLength(12);
      const agentReportText = await readFile(path.join(projectDir, ".htmlslide", "reports", "latest-agent-run.json"), "utf8");
      const agentReport = JSON.parse(agentReportText) as {
        cli?: { check?: { ok?: boolean }; export?: { ok?: boolean; artifactPaths?: string[] } };
        outputs?: { checks?: Array<{ status?: string }>; export?: { artifacts?: unknown[] }; review?: { issuesRemaining?: number } };
        providerId?: string;
        status?: string;
        targetSlideCount?: number;
      };
      expect(agentReport).toMatchObject({ providerId: "htmlslide-byok", status: "succeeded", targetSlideCount: 8 });
      expect(agentReport.outputs?.checks).toEqual([{ status: "passed", summary: { errors: 0, warnings: 0, info: 0 }, issues: [] }]);
      expect(agentReport.outputs?.export?.artifacts).toEqual(exportArtifacts());
      expect(agentReport.outputs?.review).toMatchObject({ issuesRemaining: 0 });
      expect(agentReport.cli?.check).toMatchObject({ ok: true });
      expect(agentReport.cli?.export).toMatchObject({ ok: true, artifactPaths: expect.arrayContaining([pdfPath, htmlPath, deckpkgPath, notesJsonPath]) });
      for (const text of [settingsText, manifestText, ...sourceTexts, exportManifestText, agentReportText]) {
        expect(text).not.toContain(fakeApiKey);
      }
      await expectNoFrameworkOverlay(page);
    } finally {
      await fakeProvider.close();
    }
  });
});
