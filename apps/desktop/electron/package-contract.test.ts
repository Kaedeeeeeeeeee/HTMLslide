import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(currentDir, "..", "..", "..");

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readText(relativePath)) as T;
}

describe("macOS alpha packaging contract", () => {
  it("keeps root scripts wired for package creation and smoke verification", async () => {
    const packageJson = await readJson<{ scripts?: Record<string, string> }>("package.json");

    expect(packageJson.scripts).toMatchObject({
      "docs:build": "node scripts/docs/build-docs-site.mjs",
      "version:check": "node scripts/release/check-versions.mjs",
      "package:alpha": "node scripts/release/package-alpha.mjs",
      "package:release:macos": "node scripts/release/package-release-macos.mjs",
      "release:notes": "node scripts/release/create-release-notes.mjs",
      "rc:checklist": "node scripts/release/create-rc-acceptance.mjs",
      "smoke:package:alpha": "node scripts/release/smoke-alpha-package.mjs",
      "verify:package:alpha": "pnpm package:alpha && pnpm smoke:package:alpha"
    });
  });

  it("runs Alpha packaging when any workspace package changes", async () => {
    const workflow = await readText(".github/workflows/alpha-package.yml");
    expect(workflow).toContain('      - "packages/**"');
  });

  it("keeps unsigned alpha artifact metadata explicit", async () => {
    const config = await readJson<{
      adHocSign?: boolean;
      artifactName?: string;
      bundleIdentifier?: string;
      deckPackageDocumentType?: { extension?: string };
      outputDirectory?: string;
      volumeName?: string;
    }>("build/package/alpha-macos.json");

    expect(config).toMatchObject({
      adHocSign: true,
      artifactName: "HTMLslide-${version}-unsigned-alpha-${arch}",
      bundleIdentifier: "app.htmlslide.alpha",
      deckPackageDocumentType: { extension: "deckpkg" },
      outputDirectory: "dist/alpha",
      volumeName: "HTMLslide Alpha"
    });
  });

  it("keeps the alpha package script unsigned, smokeable, and deckpkg-aware", async () => {
    const packageScript = await readText("scripts/release/package-alpha.mjs");

    expect(packageScript).toContain("hdiutil");
    expect(packageScript).toContain("ditto");
    expect(packageScript).toContain("runVersionCheck");
    expect(packageScript).toContain("pnpm\", [\"version:check\"]");
    expect(packageScript).toContain("\"@htmlslide/mcp-server\"");
    expect(packageScript).toContain("\"@htmlslide/skills\"");
    expect(packageScript).toContain("symlink(\"/Applications\"");
    expect(packageScript).toContain("writeDeckPackageDocumentTypes");
    expect(packageScript).toContain("codesign\", [\"--force\", \"--deep\", \"--sign\", \"-\"");
    expect(packageScript).toContain("assertNoBrokenSymlinks(cliRuntimePath)");
    expect(packageScript).toContain("Packaged runtime contains a broken symlink");
    expect(packageScript.split('codesign", ["--verify", "--deep", "--strict"').length - 1).toBe(2);
    expect(packageScript).toContain("APPLE_DEVELOPER_ID_APPLICATION");
    expect(packageScript).toContain("notarytool");
    expect(packageScript).toContain("stapler");
    expect(packageScript).toContain("notarized: notarization.notarized");
    expect(packageScript).toContain("artifactMetadata");
    expect(packageScript).toContain("buildArtifactMetadata(artifacts, { relativeTo: outputDir })");
    expect(packageScript).toContain("const manifestArtifacts = artifacts.map");
    const desktopRuntimeBlock = packageScript.slice(
      packageScript.indexOf("const workspaceRuntimePackages"),
      packageScript.indexOf("async function createDmg")
    );
    expect(desktopRuntimeBlock).toContain('"@htmlslide/compiler"');
    expect(desktopRuntimeBlock).toContain('"@htmlslide/linter"');
    expect(desktopRuntimeBlock).toContain('"@htmlslide/mcp-server"');
    expect(desktopRuntimeBlock).toContain('"@htmlslide/renderer"');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "pdf-lib"]');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "playwright-core"]');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "postcss"]');
    expect(desktopRuntimeBlock).toContain('[mcpSdkRequire, "@hono/node-server"]');
    expect(desktopRuntimeBlock).toContain('[mcpSdkRequire, "@modelcontextprotocol/sdk"]');
    expect(desktopRuntimeBlock).toContain('[mcpSdkRequire, "hono"]');
    expect(desktopRuntimeBlock).toContain('[mcpSdkRequire, "zod-to-json-schema"]');
    expect(packageScript).toContain("async function copyNpmRuntimeDependencyClosure");
    expect(packageScript).toContain("Object.keys(packageJson.optionalDependencies ?? {})");
    expect(desktopRuntimeBlock).toContain('[postcssRequire, "nanoid"]');
    expect(desktopRuntimeBlock).toContain('[pdfLibRequire, "@pdf-lib/standard-fonts"]');
    expect(desktopRuntimeBlock).toContain('[pdfLibRequire, "@pdf-lib/upng"]');
    expect(desktopRuntimeBlock).toContain('[pdfLibRequire, "tslib"]');

    const browserRuntimeBlock = packageScript.slice(
      packageScript.indexOf("async function deployBrowserRuntime"),
      packageScript.indexOf("async function assertNoBrokenSymlinks")
    );
    expect(browserRuntimeBlock).toContain('compilerRequire.resolve("playwright-core/package.json")');
    expect(browserRuntimeBlock).toContain('path.join(playwrightCoreRoot, "browsers.json")');
    expect(browserRuntimeBlock).toContain('browser.name === "chromium-headless-shell"');
    expect(browserRuntimeBlock).toContain("chromium_headless_shell-${headlessShell.revision}");
    expect(browserRuntimeBlock).toContain('path.join(browserRuntimePath, "chromium-headless-shell")');
    expect(browserRuntimeBlock).toContain('path.join(cliRuntimePath, "browser-runtime.json")');
    expect(browserRuntimeBlock).toContain("schemaVersion: 1");
    expect(browserRuntimeBlock).toContain("assertContainedPath");
    expect(browserRuntimeBlock).toContain("assertRegularExecutable(destinationExecutablePath");
    expect(browserRuntimeBlock).toContain("assertNoBrokenSymlinks(cliRuntimePath)");
    expect(browserRuntimeBlock).toContain('name.endsWith(".dylib")');
    expect(packageScript.indexOf("await deployBrowserRuntime(appResourcesPath)")).toBeGreaterThan(
      packageScript.indexOf("await deployCliRuntime(appResourcesPath)")
    );
    expect(packageScript).toContain("signBrowserRuntime(browserRuntime, config)");
    expect(packageScript).toContain('kind: "chromium-headless-shell"');
    expect(packageScript.indexOf("restoreWorkspaceInstallState();")).toBeGreaterThan(
      packageScript.indexOf("finally {")
    );
  });

  it("keeps signed release artifact metadata explicit", async () => {
    const config = await readJson<{
      artifactName?: string;
      bundleIdentifier?: string;
      channel?: string;
      createZip?: boolean;
      notarize?: boolean;
      outputDirectory?: string;
      signDmg?: boolean;
      signing?: string;
      staple?: boolean;
      volumeName?: string;
    }>("build/package/release-macos.json");

    expect(config).toMatchObject({
      artifactName: "HTMLslide-${version}-signed-notarized-${arch}",
      bundleIdentifier: "app.htmlslide",
      channel: "release",
      createZip: false,
      notarize: true,
      outputDirectory: "dist/release",
      signDmg: true,
      signing: "developer-id",
      staple: true,
      volumeName: "HTMLslide"
    });
  });

  it("keeps package smoke aligned with 19.13 install and repair requirements", async () => {
    const smokeScript = await readText("scripts/release/smoke-alpha-package.mjs");

    expect(smokeScript).toContain("smokeZipArtifact");
    expect(smokeScript).toContain("\"-x\", \"-k\"");
    expect(smokeScript).toContain("mountDmg");
    expect(smokeScript).toContain("launchAppOnce");
    expect(smokeScript).toContain("smokeFirstRunCliProvisioning");
    expect(smokeScript).toContain("smokeFirstRunOfficialSkills");
    expect(smokeScript).toContain("smokeMovedAppCliRepair");
    expect(smokeScript).toContain("launchAppWithDeckPackage");
    expect(smokeScript).toContain("smokeCliShim");
    expect(smokeScript).toContain("smokePackagedCliMcp");
    expect(smokeScript).toContain("\"mcp\", \"--list-tools\", \"--json\"");
    expect(smokeScript).toContain("\"mcp\", projectPath, \"--status\", \"--json\"");
    expect(smokeScript).toContain("HTMLSLIDE_SMOKE_QUIT_AFTER_READY");
    expect(smokeScript).toContain("unsigned-alpha");
    expect(smokeScript).toContain("manifest.notarized !== expectedNotarized");
    expect(smokeScript).toContain('manifest.browserRuntime?.kind !== "chromium-headless-shell"');
    expect(smokeScript).toContain("assertArtifactMetadata");
    expect(smokeScript).toContain("buildArtifactMetadata");

    const browserValidationBlock = smokeScript.slice(
      smokeScript.indexOf("async function packagedBrowserExecutablePath"),
      smokeScript.indexOf("function assertDeckPackageDocumentType")
    );
    expect(browserValidationBlock).toContain('path.join(cliRuntimePath, "browser-runtime.json")');
    expect(browserValidationBlock).toContain("config.schemaVersion !== 1");
    expect(browserValidationBlock).toContain("path.posix.isAbsolute(config.executablePath)");
    expect(browserValidationBlock).toContain("realpath(executablePath)");
    expect(browserValidationBlock).toContain("executableStats.isFile()");
    expect(browserValidationBlock).toContain("constants.X_OK");

    const packagedCliEnvironmentBlock = smokeScript.slice(
      smokeScript.indexOf("async function packagedCliEnvironment"),
      smokeScript.indexOf("function assertDeckPackageDocumentType")
    );
    expect(packagedCliEnvironmentBlock).toContain("HTMLSLIDE_CHROMIUM_EXECUTABLE");
    expect(packagedCliEnvironmentBlock).toContain("await packagedBrowserExecutablePath(appPath)");
    expect(smokeScript).toContain("env: await packagedCliEnvironment(appPath");
    expect(smokeScript).toContain("const env = await packagedCliEnvironment(movedAppPath");

    const assetExportBlock = smokeScript.slice(
      smokeScript.indexOf("async function exportFixtureDeckPackageWithPackagedCli"),
      smokeScript.indexOf("function assertPackagedDeckPackageAssets")
    );
    expect(assetExportBlock).toContain('HTMLSLIDE_CHROMIUM_EXECUTABLE: ""');
    expect(assetExportBlock).toContain("PLAYWRIGHT_BROWSERS_PATH: emptyBrowserCache");
    expect(assetExportBlock).not.toContain("env: await packagedCliEnvironment(appPath");

    const shimSmokeBlock = smokeScript.slice(
      smokeScript.indexOf("async function smokeCliShim"),
      smokeScript.indexOf("async function smokePackagedCliPresent")
    );
    expect(shimSmokeBlock).toContain("const env = await packagedCliEnvironment(appPath");
    expect(shimSmokeBlock).toContain("run(process.execPath");
    expect(shimSmokeBlock).toContain("run(shimPath");

    const presentSmokeBlock = smokeScript.slice(
      smokeScript.indexOf("async function smokePackagedCliPresent"),
      smokeScript.indexOf("async function smokePackagedCliOpenProject")
    );
    expect(presentSmokeBlock).toContain("const env = await packagedCliEnvironment(appPath");
    expect(presentSmokeBlock).toContain('run(shimPath, ["present"');

    const openSmokeBlock = smokeScript.slice(
      smokeScript.indexOf("async function smokePackagedCliOpenProject"),
      smokeScript.indexOf("async function smokePackagedCliSkills")
    );
    expect(openSmokeBlock).toContain("env: await packagedCliEnvironment(appPath");
    expect(openSmokeBlock).toContain('run(shimPath, ["open"');

    const movedAppSmokeBlock = smokeScript.slice(
      smokeScript.indexOf("async function smokeMovedAppCliRepair"),
      smokeScript.indexOf("async function main")
    );
    expect(movedAppSmokeBlock).toContain("const env = await packagedCliEnvironment(movedAppPath");
    expect(movedAppSmokeBlock).toContain('run(shimPath, ["doctor"');
  });

  it("keeps presenter display reconnect events wired through the isolated preload", async () => {
    const mainSource = await readText("apps/desktop/electron/main.ts");
    const preloadSource = await readText("apps/desktop/electron/preload.cts");
    const desktopApiSource = await readText("apps/desktop/src/desktop-api.ts");

    expect(mainSource).toContain('screen.on("display-added", notifyPresenterDisplaysChanged)');
    expect(mainSource).toContain('screen.on("display-removed", notifyPresenterDisplaysChanged)');
    expect(mainSource).toContain('screen.on("display-metrics-changed", notifyPresenterDisplaysChanged)');
    expect(mainSource).toContain("reconcileAudienceWindowDisplay");
    expect(mainSource).toContain('htmlslide:audience-window-state-changed');
    expect(preloadSource).toContain('ipcRenderer.on("htmlslide:presenter-displays-changed", listener)');
    expect(preloadSource).toContain("onPresenterDisplaysChanged");
    expect(preloadSource).toContain('ipcRenderer.on("htmlslide:audience-window-state-changed", listener)');
    expect(desktopApiSource).toContain("onPresenterDisplaysChanged(handler: () => void): () => void;");
    expect(desktopApiSource).toContain("onAudienceWindowStateChanged(handler: (state: DesktopAudienceWindowState) => void): () => void;");
  });

  it("keeps presenter screen swapping validated, stateful, and window-safe", async () => {
    const mainSource = await readText("apps/desktop/electron/main.ts");
    const preloadSource = await readText("apps/desktop/electron/preload.cts");
    const desktopApiSource = await readText("apps/desktop/src/desktop-api.ts");
    const workspaceSource = await readText("apps/desktop/src/components/Workspace.tsx");

    expect(mainSource).toContain("normalizePresenterScreenSwapRequest");
    expect(mainSource).toContain('ipcMain.handle("htmlslide:swap-presenter-screens"');
    expect(mainSource).toContain('"main-window-unavailable"');
    expect(mainSource).toContain('"audience-window-unavailable"');
    expect(mainSource).toContain('"audience-state-mismatch"');
    expect(mainSource).toContain('"same-display"');
    expect(mainSource).toContain('"target-disconnected"');
    expect(mainSource).toContain("mainWindow.getNormalBounds()");
    expect(mainSource).toContain("restoreMainWindowPresentation");
    expect(mainSource).toContain("mainWindow.setBounds(mainTargetBounds)");
    expect(mainSource).toContain("audienceWindow.setBounds(audienceTargetBounds)");
    expect(mainSource).toContain("audienceWindowDisplayId = mainDisplay.id");
    expect(mainSource).toContain("selectedDisplayId: mainDisplay.id");
    expect(preloadSource).toContain('ipcRenderer.invoke("htmlslide:swap-presenter-screens", request)');
    expect(desktopApiSource).toContain("DesktopPresenterScreenSwapRequest");
    expect(desktopApiSource).toContain("DesktopPresenterScreenSwapResult");
    expect(desktopApiSource).toContain(
      "swapPresenterScreens(request: DesktopPresenterScreenSwapRequest): Promise<DesktopPresenterScreenSwapResult>;"
    );
    expect(workspaceSource).toContain('"Swap screens"');
    expect(workspaceSource).toContain("swapPresenterScreens({ selectedDisplayId })");
    expect(workspaceSource).toContain("setSelectedDisplayId(state.selectedDisplayId)");
    expect(workspaceSource).toContain("setAudienceWindowError(state.error.message)");
  });

  it("keeps the repair-prompt clipboard bridge explicit and bounded", async () => {
    const mainSource = await readText("apps/desktop/electron/main.ts");
    const preloadSource = await readText("apps/desktop/electron/preload.cts");
    const desktopApiSource = await readText("apps/desktop/src/desktop-api.ts");

    expect(mainSource).toContain('ipcMain.handle("htmlslide:copy-agent-repair-prompt"');
    expect(mainSource).toContain("prompt.length > 100_000");
    expect(mainSource).toContain("clipboard.writeText(prompt)");
    expect(preloadSource).toContain('ipcRenderer.invoke("htmlslide:copy-agent-repair-prompt", prompt)');
    expect(desktopApiSource).toContain("copyAgentRepairPrompt(prompt: string): Promise<{ copied: boolean }>;");
  });

  it("keeps the alpha packaging workflow gated and artifact-producing", async () => {
    const workflow = await readText(".github/workflows/alpha-package.yml");
    const packageIndex = workflow.indexOf("run: pnpm package:alpha");
    const smokeIndex = workflow.indexOf("run: pnpm smoke:package:alpha");

    expect(workflow).toContain("runs-on: macos-26");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain('      - "packages/compiler/**"');
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: \"false\"");
    expect(workflow).toContain("'docs:check', 'docs:build'");
    expect(workflow).toContain("version:check");
    expect(workflow).toContain("pnpm docs:build");
    expect(workflow).toContain("pnpm version:check");
    expect(workflow).toContain("run: pnpm test:visual:browser");
    expect(packageIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(packageIndex);
    expect(workflow).toContain("pnpm rc:checklist --");
    expect(workflow).toContain("--channel alpha");
    expect(workflow).toContain("HTMLslide-alpha-rc-acceptance.md");
    expect(workflow).toContain("*.dmg");
    expect(workflow).toContain("*.zip");
    expect(workflow).toContain("*.json");
    expect(workflow).toContain("find \"$manifest_dir\" -maxdepth 1 -type f -name 'HTMLslide-*.json'");
    expect(workflow).toContain("name: htmlslide-unsigned-alpha-${{ github.run_number }}");
  });

  it("keeps the RC checklist explicit about real external-agent claims", async () => {
    const checklistScript = await readText("scripts/release/create-rc-acceptance.mjs");
    const publicTestingDocs = await readText("docs/testing.md");
    const releaseNotesScript = await readText("scripts/release/create-release-notes.mjs");

    expect(checklistScript).toContain("Validate Real Claude/Codex Compatibility And Gemini Boundary");
    expect(checklistScript).toContain("sanitized task/command");
    expect(checklistScript).toContain("source-write manifest validation");
    expect(checklistScript).toContain("Gemini CLI remains detection-only");
    expect(publicTestingDocs).toContain("real Claude/Codex claim validation or explicit no-claim N/A");
    expect(publicTestingDocs).toContain("Gemini detection-only status");
    expect(releaseNotesScript).toContain("real Claude/Codex compatibility validation or explicit no-claim N/A");
  });

  it("keeps the signed release workflow gated, notarized, and release-publishing", async () => {
    const workflow = await readText(".github/workflows/release-macos.yml");
    const releaseContract = await readText("scripts/release/validate-release-contract.mjs");
    const installDependenciesIndex = workflow.indexOf("run: pnpm install --frozen-lockfile");
    const installChromiumIndex = workflow.indexOf("run: pnpm exec playwright install chromium");
    const testIndex = workflow.indexOf("run: pnpm test");

    expect(workflow).toContain("runs-on: macos-26");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("environment: macos-release");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("docs:build");
    expect(workflow).toContain("version:check");
    expect(workflow).toContain("pnpm docs:build");
    expect(workflow).toContain("pnpm version:check");
    expect(workflow).toContain("run: pnpm test:visual:browser");
    expect(installChromiumIndex).toBeGreaterThan(installDependenciesIndex);
    expect(testIndex).toBeGreaterThan(installChromiumIndex);
    expect(workflow).toContain("package:release:macos");
    expect(workflow).toContain("release:notes");
    expect(workflow).toContain("release_tag:");
    expect(workflow).toContain("WORKFLOW_RELEASE_TAG: ${{ github.event.inputs.release_tag || '' }}");
    expect(workflow).toContain("APPLE_DEVELOPER_ID_APPLICATION");
    expect(workflow).toContain("APPLE_DEVELOPER_ID_CERTIFICATE_BASE64");
    expect(workflow).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(workflow).toContain("security import");
    expect(workflow).toContain("identity_output=\"$(security find-identity -v -p codesigning \"$keychain_path\")\"");
    expect(workflow).toContain("grep -Fq \"\\\"$APPLE_DEVELOPER_ID_APPLICATION\\\"\"");
    expect(workflow).toContain("pnpm package:release:macos");
    expect(workflow).toContain("HTMLSLIDE_PACKAGE_SMOKE_CHANNEL: release");
    expect(workflow).toContain("HTMLSLIDE_PACKAGE_SMOKE_DIR: dist/release");
    expect(workflow).toContain("run: pnpm smoke:package:alpha");
    expect(workflow).toContain("node scripts/release/validate-release-contract.mjs");
    expect(workflow).toContain('--manifest "$manifest"');
    expect(workflow).toContain("--expected-arch arm64");
    expect(releaseContract).toContain("manifest.notarized !== true");
    expect(releaseContract).toContain("manifest.stapled !== true");
    expect(releaseContract).toContain("manifest.artifactMetadata");
    expect(workflow).toContain("find dist/release -maxdepth 1 -type f -name 'HTMLslide-*.json'");
    expect(workflow).not.toContain("find dist/release -name '*.json' -type f");
    expect(releaseContract).toContain("createHash(\"sha256\")");
    expect(releaseContract).toContain("artifact metadata SHA-256 mismatch");
    expect(workflow).toContain("pnpm rc:checklist --");
    expect(workflow).toContain("--channel release");
    expect(workflow).toContain("HTMLslide-release-rc-acceptance.md");
    expect(workflow).toContain("signed-notarized");
    expect(workflow).toContain("release-artifacts/RELEASE_NOTES.md");
    expect(workflow).toContain("release_tag=\"manual-${GITHUB_RUN_NUMBER}\"");
    expect(workflow).toContain("Create draft GitHub Release for candidate");
    expect(workflow).not.toContain("gh release create \"$tag\" --title \"HTMLslide $tag\" --notes-file release-artifacts/RELEASE_NOTES.md");
    expect(workflow).not.toContain("Verify RC checklist promotion gate");
    expect(workflow).toContain("name: htmlslide-signed-notarized-${{ github.run_id }}");
    expect(workflow).toContain("Upload signed notarized candidate");

    const promotionWorkflow = await readText(".github/workflows/promote-release.yml");
    expect(promotionWorkflow).toContain("contents: write");
    expect(promotionWorkflow).toContain("actions: read");
    expect(promotionWorkflow).toContain("environment: macos-release");
    expect(promotionWorkflow).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4");
    expect(promotionWorkflow).toContain("gh release download");
    expect(promotionWorkflow).toContain("gh release edit \"$RELEASE_TAG\"");
    expect(promotionWorkflow).toContain("--draft=false");
  });

  it("keeps CI building the publishable docs site", async () => {
    const workflow = await readText(".github/workflows/ci.yml");
    const desktopE2eBlock = workflow.slice(
      workflow.indexOf("  desktop-e2e:"),
      workflow.indexOf("  desktop-a11y:")
    );

    expect(workflow).toContain("'docs:check', 'docs:build'");
    expect(workflow).toContain("version:check");
    expect(workflow).toContain("run: pnpm docs:check");
    expect(workflow).toContain("run: pnpm docs:build");
    expect(workflow).toContain("run: pnpm version:check");
    expect(desktopE2eBlock).toContain("run: pnpm exec playwright install chromium");
  });

  it("keeps GitHub Actions on Node 24 runtimes and pins hosted runner images", async () => {
    const workflowPaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/docs-pages.yml",
      ".github/workflows/alpha-package.yml",
      ".github/workflows/release-macos.yml",
      ".github/workflows/promote-release.yml"
    ];
    const workflows = await Promise.all(workflowPaths.map((workflowPath) => readText(workflowPath)));

    for (const workflow of workflows) {
      expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7");
      expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6");
      expect(workflow).toContain("pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6");
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).not.toMatch(/actions\/checkout@v[1-6]\b/);
      expect(workflow).not.toMatch(/actions\/setup-node@v[1-5]\b/);
      expect(workflow).not.toMatch(/pnpm\/action-setup@v[1-5]\b/);
      expect(workflow).not.toMatch(/actions\/upload-artifact@v[1-6]\b/);
      expect(workflow).not.toMatch(/actions\/download-artifact@v[1-3]\b/);
    }

    for (const workflow of [workflows[0], workflows[2], workflows[3]]) {
      expect(workflow).not.toContain("macos-latest");
      expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7");
    }
    for (const workflow of workflows) {
      expect(workflow).not.toContain("ubuntu-latest");
    }
    expect(workflows[0]?.match(/runs-on: macos-26/g)).toHaveLength(2);
    expect(workflows[0]?.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(2);
    expect(workflows[1]).toContain("runs-on: ubuntu-24.04");
  });

  it("keeps release version checks anchored to core constants", async () => {
    const versionSource = await readText("packages/core/src/version.ts");
    const checkScript = await readText("scripts/release/check-versions.mjs");
    const releaseNotesScript = await readText("scripts/release/create-release-notes.mjs");

    expect(versionSource).toContain("HTMLSLIDE_APP_VERSION");
    expect(versionSource).toContain("DECK_SCHEMA_VERSION");
    expect(versionSource).toContain("DECK_PACKAGE_SCHEMA_VERSION");
    expect(versionSource).toContain("EXPORT_MANIFEST_SCHEMA_VERSION");
    expect(versionSource).toContain("CHECK_REPORT_SCHEMA_VERSION");
    expect(versionSource).toContain("AGENT_RUN_REPORT_SCHEMA_VERSION");
    expect(versionSource).toContain("CHECKPOINT_SCHEMA_VERSION");
    expect(checkScript).toContain("HTMLSLIDE_APP_VERSION");
    expect(checkScript).toContain("DECK_SCHEMA_VERSION");
    expect(checkScript).toContain("DECK_PACKAGE_SCHEMA_VERSION");
    expect(checkScript).toContain("EXPORT_MANIFEST_SCHEMA_VERSION");
    expect(checkScript).toContain("package.json version");
    expect(checkScript).toContain("Release tag");
    expect(checkScript).toContain("GITHUB_REF_TYPE");
    expect(checkScript).toContain("checkRiskyVersionLiterals");
    expect(releaseNotesScript).toContain("deckSchemaVersion: versionConstants.DECK_SCHEMA_VERSION");
  });

  it("keeps docs site generation deterministic and Pages-ready", async () => {
    const buildScript = await readText("scripts/docs/build-docs-site.mjs");

    expect(buildScript).toContain("dist\", \"docs-site");
    expect(buildScript).toContain(".nojekyll");
    expect(buildScript).toContain("favicon.svg");
    expect(buildScript).toContain("HTMLslide Documentation");
    expect(buildScript).toContain("validateGeneratedLinks");
    expect(buildScript).toContain("copyAsset");
    expect(buildScript).toContain("!file.endsWith(\".md\")");
  });

  it("builds the hidden Pages marker required by the deployed artifact", async () => {
    await execFileAsync(process.execPath, ["scripts/docs/build-docs-site.mjs"], { cwd: root });

    await expect(readText("dist/docs-site/.nojekyll")).resolves.toBe("");
  });

  it("keeps the docs Pages workflow deployable", async () => {
    const workflow = await readText(".github/workflows/docs-pages.yml");

    expect(workflow).toContain("name: Docs Pages");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("- \"v*\"");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("name: github-pages");
    expect(workflow).toContain("run: pnpm docs:check");
    expect(workflow).toContain("run: pnpm docs:build");
    expect(workflow).toContain("actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6");
    expect(workflow).toContain("actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5");
    expect(workflow).toContain("path: dist/docs-site");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("enablement: true");
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5");
  });
});
