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
    expect(packageScript).toContain("buildArtifactMetadata(artifacts)");
    const desktopRuntimeBlock = packageScript.slice(
      packageScript.indexOf("const workspaceRuntimePackages"),
      packageScript.indexOf("async function createDmg")
    );
    expect(desktopRuntimeBlock).toContain('"@htmlslide/compiler"');
    expect(desktopRuntimeBlock).toContain('"@htmlslide/renderer"');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "pdf-lib"]');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "playwright-core"]');
    expect(desktopRuntimeBlock).toContain('[compilerRequire, "postcss"]');
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
    const installDependenciesIndex = workflow.indexOf("run: pnpm install --frozen-lockfile");
    const installChromiumIndex = workflow.indexOf("run: pnpm exec playwright install chromium");
    const testIndex = workflow.indexOf("run: pnpm test");

    expect(workflow).toContain("runs-on: macos-26");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("contents: write");
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
    expect(workflow).toContain("pnpm package:release:macos");
    expect(workflow).toContain("HTMLSLIDE_PACKAGE_SMOKE_CHANNEL: release");
    expect(workflow).toContain("HTMLSLIDE_PACKAGE_SMOKE_DIR: dist/release");
    expect(workflow).toContain("run: pnpm smoke:package:alpha");
    expect(workflow).toContain("manifest.notarized !== true");
    expect(workflow).toContain("manifest.stapled !== true");
    expect(workflow).toContain("manifest.artifactMetadata");
    expect(workflow).toContain("crypto.createHash('sha256')");
    expect(workflow).toContain("release DMG metadata sha256 mismatch");
    expect(workflow).toContain("pnpm rc:checklist --");
    expect(workflow).toContain("--channel release");
    expect(workflow).toContain("HTMLslide-release-rc-acceptance.md");
    expect(workflow).toContain("signed-notarized");
    expect(workflow).toContain("release-artifacts/RELEASE_NOTES.md");
    expect(workflow).toContain("release_tag=\"manual-${GITHUB_RUN_NUMBER}\"");
    expect(workflow).toContain("gh release create \"$tag\" --title \"HTMLslide $tag\" --notes-file release-artifacts/RELEASE_NOTES.md");
    expect(workflow).toContain("gh release edit \"$tag\" --title \"HTMLslide $tag\" --notes-file release-artifacts/RELEASE_NOTES.md");
    expect(workflow).toContain("name: htmlslide-signed-notarized-${{ github.run_number }}");
    expect(workflow).toContain("gh release upload");
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
      ".github/workflows/release-macos.yml"
    ];
    const workflows = await Promise.all(workflowPaths.map((workflowPath) => readText(workflowPath)));

    for (const workflow of workflows) {
      expect(workflow).toContain("actions/checkout@v7");
      expect(workflow).toContain("actions/setup-node@v6");
      expect(workflow).toContain("pnpm/action-setup@v6");
      expect(workflow).not.toMatch(/actions\/checkout@v[1-6]\b/);
      expect(workflow).not.toMatch(/actions\/setup-node@v[1-5]\b/);
      expect(workflow).not.toMatch(/pnpm\/action-setup@v[1-5]\b/);
      expect(workflow).not.toMatch(/actions\/upload-artifact@v[1-6]\b/);
    }

    for (const workflow of [workflows[0], workflows[2], workflows[3]]) {
      expect(workflow).not.toContain("macos-latest");
      expect(workflow).toContain("actions/upload-artifact@v7");
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
    expect(workflow).toContain("actions/configure-pages@v6");
    expect(workflow).toContain("actions/upload-pages-artifact@v5");
    expect(workflow).toContain("path: dist/docs-site");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("enablement: true");
    expect(workflow).toContain("actions/deploy-pages@v5");
  });
});
