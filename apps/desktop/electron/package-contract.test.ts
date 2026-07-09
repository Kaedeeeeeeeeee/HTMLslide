import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      "package:alpha": "node scripts/release/package-alpha.mjs",
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
    expect(packageScript).toContain("symlink(\"/Applications\"");
    expect(packageScript).toContain("writeDeckPackageDocumentTypes");
    expect(packageScript).toContain("codesign\", [\"--force\", \"--deep\", \"--sign\", \"-\"");
    expect(packageScript).toContain("notarized: false");
  });

  it("keeps package smoke aligned with 19.13 install and repair requirements", async () => {
    const smokeScript = await readText("scripts/release/smoke-alpha-package.mjs");

    expect(smokeScript).toContain("mountDmg");
    expect(smokeScript).toContain("launchAppOnce");
    expect(smokeScript).toContain("smokeFirstRunCliProvisioning");
    expect(smokeScript).toContain("smokeFirstRunOfficialSkills");
    expect(smokeScript).toContain("smokeMovedAppCliRepair");
    expect(smokeScript).toContain("launchAppWithDeckPackage");
    expect(smokeScript).toContain("smokeCliShim");
    expect(smokeScript).toContain("HTMLSLIDE_SMOKE_QUIT_AFTER_READY");
    expect(smokeScript).toContain("unsigned-alpha");
    expect(smokeScript).toContain("manifest.notarized !== false");
  });

  it("keeps the alpha packaging workflow gated and artifact-producing", async () => {
    const workflow = await readText(".github/workflows/alpha-package.yml");
    const packageIndex = workflow.indexOf("run: pnpm package:alpha");
    const smokeIndex = workflow.indexOf("run: pnpm smoke:package:alpha");

    expect(workflow).toContain("runs-on: macos-latest");
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: \"false\"");
    expect(packageIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(packageIndex);
    expect(workflow).toContain("*.dmg");
    expect(workflow).toContain("*.zip");
    expect(workflow).toContain("*.json");
    expect(workflow).toContain("name: htmlslide-unsigned-alpha-${{ github.run_number }}");
  });
});
