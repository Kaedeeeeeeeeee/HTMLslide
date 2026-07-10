import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_CONTENT_SECURITY_POLICY } from "@htmlslide/renderer";
import { buildSlidePreviewDocument } from "../src/index";

const temporaryRoots: string[] = [];

const svgBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="spark"><path d="M0 0h8v8H0z"/></symbol></svg>'
);
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webpBytes = Buffer.from("RIFFpreviewWEBP", "ascii");
const fontBytes = Buffer.from("preview-font", "utf8");
const videoBytes = Buffer.from("preview-video", "utf8");

const dataUrl = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

const createPreviewProject = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-preview-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "preview-deck");
  await Promise.all([
    mkdir(path.join(projectRoot, "assets"), { recursive: true }),
    mkdir(path.join(projectRoot, "notes"), { recursive: true }),
    mkdir(path.join(projectRoot, "slides"), { recursive: true }),
    mkdir(path.join(projectRoot, "theme"), { recursive: true })
  ]);

  await Promise.all([
    writeFile(path.join(projectRoot, "deck.json"), `${JSON.stringify({
      schemaVersion: "0.1.0",
      id: "preview_deck",
      title: "Preview Deck",
      language: "en-US",
      aspectRatio: "16:9",
      viewport: { width: 1600, height: 900 },
      safeArea: { top: 40, right: 48, bottom: 40, left: 48 },
      theme: { css: "theme/theme.css", tokens: "theme/tokens.json" },
      slides: [
        {
          id: "001-preview",
          title: "Inline Preview",
          source: "slides/001-preview.html",
          notes: "notes/001-preview.md",
          kind: "content",
          status: "ready"
        },
        {
          id: "002-hidden",
          title: "Not Requested",
          source: "slides/002-hidden.html",
          kind: "content",
          status: "draft"
        }
      ]
    }, null, 2)}\n`),
    writeFile(path.join(projectRoot, "slides", "001-preview.html"), `<section class="slide" data-slide-id="001-preview">
  <img class="symbol" src="../assets/icons.svg#spark" alt="" />
  <img class="responsive" srcset="../assets/photo.png 1x, ../assets/photo@2x.webp 2x" alt="" />
  <video src="../assets/demo.mp4" poster="../assets/photo.png"></video>
  <div class="inline-image" style="background-image: url('../assets/photo.png')"></div>
</section>\n`),
    writeFile(
      path.join(projectRoot, "slides", "002-hidden.html"),
      '<section class="slide" data-slide-id="002-hidden">HIDDEN_SLIDE_CONTENT<img src="../assets/missing-hidden.png" alt="" /></section>\n'
    ),
    writeFile(path.join(projectRoot, "notes", "001-preview.md"), "Preview speaker notes.\n"),
    writeFile(path.join(projectRoot, "theme", "theme.css"), `@font-face {
  font-family: Preview;
  src: url("../assets/preview.woff2") format("woff2");
}
.slide {
  background-image: url("../assets/icons.svg#spark");
}\n`),
    writeFile(path.join(projectRoot, "theme", "tokens.json"), '{"accent":"#2563eb"}\n'),
    writeFile(path.join(projectRoot, "assets", "icons.svg"), svgBytes),
    writeFile(path.join(projectRoot, "assets", "photo.png"), pngBytes),
    writeFile(path.join(projectRoot, "assets", "photo@2x.webp"), webpBytes),
    writeFile(path.join(projectRoot, "assets", "preview.woff2"), fontBytes),
    writeFile(path.join(projectRoot, "assets", "demo.mp4"), videoBytes)
  ]);

  return projectRoot;
};

type TreeEntry = {
  path: string;
  type: "directory" | "file";
  contents?: string;
};

const snapshotTree = async (root: string): Promise<TreeEntry[]> => {
  const entries: TreeEntry[] = [];
  const visit = async (directoryPath: string, relativeDirectory = ""): Promise<void> => {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolutePath = path.join(directoryPath, child.name);
      if (child.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          contents: (await readFile(absolutePath)).toString("base64")
        });
      }
    }
  };
  await visit(root);
  return entries;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildSlidePreviewDocument", () => {
  it("inlines theme and slide assets with MIME data URLs and preserves SVG fragments", async () => {
    const projectRoot = await createPreviewProject();

    const preview = await buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" });

    expect(preview).toMatchObject({
      projectRoot,
      slideId: "001-preview",
      sourcePath: "slides/001-preview.html",
      title: "Inline Preview",
      viewport: { width: 1600, height: 900 },
      notes: "Preview speaker notes.\n"
    });
    expect(preview.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.htmlDocument).toContain(PREVIEW_CONTENT_SECURITY_POLICY);
    expect(preview.htmlDocument).toContain(`${dataUrl("image/svg+xml", svgBytes)}#spark`);
    expect(preview.htmlDocument).toContain(dataUrl("image/png", pngBytes));
    expect(preview.htmlDocument).toContain(dataUrl("image/webp", webpBytes));
    expect(preview.htmlDocument).toContain(dataUrl("font/woff2", fontBytes));
    expect(preview.htmlDocument).toContain(dataUrl("video/mp4", videoBytes));
    expect(preview.htmlDocument).not.toContain("../assets/");
    expect(preview.htmlDocument).not.toContain("HIDDEN_SLIDE_CONTENT");
    expect(preview.htmlDocument).not.toContain("missing-hidden.png");
  });

  it("rejects an unknown slide id", async () => {
    const projectRoot = await createPreviewProject();

    await expect(buildSlidePreviewDocument(projectRoot, { slideId: "missing-slide" }))
      .rejects.toThrow('Unknown slide id "missing-slide"');
  });

  it("does not write project files or runtime/export directories", async () => {
    const projectRoot = await createPreviewProject();
    const before = await snapshotTree(projectRoot);

    await buildSlidePreviewDocument(path.join(projectRoot, "slides", "001-preview.html"), {
      slideId: "001-preview"
    });

    expect(await snapshotTree(projectRoot)).toEqual(before);
    expect(before.some((entry) => entry.path.startsWith("exports"))).toBe(false);
    expect(before.some((entry) => entry.path.startsWith(".htmlslide"))).toBe(false);
  });

  it("returns deterministic documents and source digests for an unchanged project", async () => {
    const projectRoot = await createPreviewProject();

    const first = await buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" });
    const second = await buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" });

    expect(second).toEqual(first);
  });

  it("keeps the selected-slide preview independent from unrelated slide sources and assets", async () => {
    const projectRoot = await createPreviewProject();
    const first = await buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" });

    await writeFile(
      path.join(projectRoot, "slides", "002-hidden.html"),
      '<section class="slide" data-slide-id="002-hidden"><img src="../assets/still-missing.png" alt="" /></section>\n'
    );
    const second = await buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" });

    expect(second).toEqual(first);
  });

  it("rejects an oversized inline asset before building the IPC document", async () => {
    const projectRoot = await createPreviewProject();
    await writeFile(
      path.join(projectRoot, "slides", "001-preview.html"),
      '<section class="slide" data-slide-id="001-preview"><video src="../assets/oversized.mp4"></video></section>\n'
    );
    const oversizedAsset = await open(path.join(projectRoot, "assets", "oversized.mp4"), "w");
    try {
      await oversizedAsset.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await oversizedAsset.close();
    }

    await expect(buildSlidePreviewDocument(projectRoot, { slideId: "001-preview" }))
      .rejects.toThrow("the read limit is 33554432 bytes");
  });
});
