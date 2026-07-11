import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright-core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithChromium, type BrowserRenderOptions, type BrowserRenderError } from "../src/browser-renderer";

const VIEWPORT = { width: 320, height: 180 };
const THUMBNAIL_SIZE = { width: 173, height: 91 };
const chromiumExecutablePath = chromium.executablePath();
const temporaryRoots: string[] = [];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const createRenderRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-browser-renderer-"));
  temporaryRoots.push(root);
  return root;
};

const buildHtml = (slides: string, head = ""): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Renderer fixture</title>
<style>
@page { size: ${VIEWPORT.width}px ${VIEWPORT.height}px; margin: 0; }
html, body { margin: 0; padding: 0; background: white; }
.htmlslide-deck { display: block; margin: 0; padding: 0; }
.htmlslide-page {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: ${VIEWPORT.width}px;
  height: ${VIEWPORT.height}px;
  margin: 0;
  overflow: hidden;
  break-after: page;
  page-break-after: always;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
.htmlslide-page:last-child { break-after: auto; page-break-after: auto; }
</style>
${head}
</head>
<body><main class="htmlslide-deck">${slides}</main></body>
</html>`;

const writeRenderHtml = async (root: string, html: string): Promise<string> => {
  const renderRoot = path.join(root, "render-root");
  await mkdir(renderRoot, { recursive: true });
  const htmlPath = path.join(renderRoot, "deck.html");
  await writeFile(htmlPath, html);
  return htmlPath;
};

const optionsFor = (
  htmlPath: string,
  slideIds: string[],
  overrides: Partial<BrowserRenderOptions> = {}
): BrowserRenderOptions => ({
  executablePath: chromiumExecutablePath,
  htmlPath,
  slideIds,
  thumbnailSize: THUMBNAIL_SIZE,
  title: "Deterministic Renderer Test",
  viewport: VIEWPORT,
  ...overrides
});

const paeth = (left: number, up: number, upperLeft: number): number => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

const readPngPixel = (png: Uint8Array, x: number, y: number): [number, number, number] => {
  const bytes = Buffer.from(png);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  expect(bitDepth).toBe(8);
  expect([2, 6]).toContain(colorType);
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(width);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(y).toBeLessThan(height);

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const encoded = inflateSync(Buffer.concat(idat));
  const decoded = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * (stride + 1);
    const filter = encoded[sourceStart];
    for (let column = 0; column < stride; column += 1) {
      const raw = encoded[sourceStart + 1 + column] ?? 0;
      const target = row * stride + column;
      const left = column >= channels ? (decoded[target - channels] ?? 0) : 0;
      const up = row > 0 ? (decoded[target - stride] ?? 0) : 0;
      const upperLeft = row > 0 && column >= channels ? (decoded[target - stride - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paeth(left, up, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      decoded[target] = value & 0xff;
    }
  }

  const pixelOffset = y * stride + x * channels;
  return [decoded[pixelOffset] ?? 0, decoded[pixelOffset + 1] ?? 0, decoded[pixelOffset + 2] ?? 0];
};

beforeAll(async () => {
  await access(chromiumExecutablePath);
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("renderWithChromium", () => {
  it("renders authored DOM content into exact-size PNGs and a normalized, stable PDF", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml(`
<article class="htmlslide-page" data-slide-id="blue" style="background: rgb(18, 52, 86)">
  <div style="position:absolute;left:32px;top:24px;width:80px;height:60px;background:rgb(240,160,32)"></div>
</article>
<article class="htmlslide-page" data-slide-id="green" style="background: rgb(24, 120, 72)"></article>`)
    );
    const options = optionsFor(htmlPath, ["blue", "green"]);

    const first = await renderWithChromium(options);
    const second = await renderWithChromium(options);
    const blue = first.thumbnails.get("blue");
    const green = first.thumbnails.get("green");
    expect(blue).toBeDefined();
    expect(green).toBeDefined();
    expect({ width: blue!.readUInt32BE(16), height: blue!.readUInt32BE(20) }).toEqual(THUMBNAIL_SIZE);
    expect({ width: green!.readUInt32BE(16), height: green!.readUInt32BE(20) }).toEqual(THUMBNAIL_SIZE);
    expect(readPngPixel(blue!, 20, 18)).toEqual([240, 160, 32]);
    expect(readPngPixel(blue!, 120, 60)).toEqual([18, 52, 86]);
    expect(readPngPixel(green!, 120, 60)).toEqual([24, 120, 72]);

    const pdf = await PDFDocument.load(first.pdf, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getTitle()).toBe(options.title);
    expect(pdf.getCreator()).toBe("HTMLslide compiler");
    expect(pdf.getProducer()).toBe("HTMLslide compiler");
    expect(pdf.getCreationDate().toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(pdf.getModificationDate().toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(sha256(first.pdf)).toBe(sha256(second.pdf));
    expect(sha256(blue!)).toBe(sha256(second.thumbnails.get("blue")!));
    expect(sha256(green!)).toBe(sha256(second.thumbnails.get("green")!));
  }, 60_000);

  it("keeps page scripts disabled", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml(
        '<article class="htmlslide-page" data-slide-id="scripted" style="background:rgb(20,140,80)"></article>',
        '<script>document.addEventListener("DOMContentLoaded", () => { document.querySelector(".htmlslide-page").style.background = "rgb(220,20,40)"; });</script>'
      )
    );

    const result = await renderWithChromium(optionsFor(htmlPath, ["scripted"]));
    expect(readPngPixel(result.thumbnails.get("scripted")!, 120, 60)).toEqual([20, 140, 80]);
  }, 30_000);

  it("keeps the authored viewport active while scaling responsive thumbnails", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml(
        '<article class="htmlslide-page responsive" data-slide-id="responsive"></article>',
        '<style>.responsive{background:rgb(180,30,40)}@media (min-width:300px){.responsive{background:rgb(20,130,70)}}</style>'
      )
    );

    const result = await renderWithChromium(optionsFor(htmlPath, ["responsive"]));
    expect(readPngPixel(result.thumbnails.get("responsive")!, 120, 60)).toEqual([20, 130, 70]);
  }, 30_000);

  it("blocks network resources with an actionable error", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml('<article class="htmlslide-page" data-slide-id="remote"><img src="https://example.com/image.png" alt=""></article>')
    );

    await expect(renderWithChromium(optionsFor(htmlPath, ["remote"]))).rejects.toMatchObject({
      code: "RENDER_RESOURCE_FAILURE"
    });
    await expect(renderWithChromium(optionsFor(htmlPath, ["remote"]))).rejects.toThrow(/Blocked requests:.*https:\/\/example\.com\/image\.png.*render root/i);
  }, 30_000);

  it("fails when an image inside the render root is missing or invalid", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml('<article class="htmlslide-page" data-slide-id="missing"><img src="missing.png" alt=""></article>')
    );

    await expect(renderWithChromium(optionsFor(htmlPath, ["missing"]))).rejects.toThrow(/missing\.png.*(exists|repair)/i);
  }, 30_000);

  it("fails when a used font face cannot be decoded", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml(
        '<article class="htmlslide-page" data-slide-id="font"><span>Font probe</span></article>',
        '<style>@font-face{font-family:"BrokenFixture";src:url(data:font/woff2;base64,AAAA)} span{font-family:"BrokenFixture"}</style>'
      )
    );

    await expect(renderWithChromium(optionsFor(htmlPath, ["font"]))).rejects.toThrow(/font failed to load/i);
  }, 30_000);

  it("blocks file assets outside the render root", async () => {
    const root = await createRenderRoot();
    await writeFile(
      path.join(root, "outside.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
    );
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml('<article class="htmlslide-page" data-slide-id="outside"><img src="../outside.png" alt=""></article>')
    );

    await expect(renderWithChromium(optionsFor(htmlPath, ["outside"]))).rejects.toThrow(
      /outside\.png.*outside render root/i
    );
  }, 30_000);

  it("fails for an unknown slide id", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml('<article class="htmlslide-page" data-slide-id="known"></article>')
    );

    await expect(renderWithChromium(optionsFor(htmlPath, ["unknown"]))).rejects.toMatchObject({
      code: "UNKNOWN_SLIDE_ID"
    });
  }, 30_000);

  it("reports an actionable error for an unavailable Chromium executable", async () => {
    const root = await createRenderRoot();
    const htmlPath = await writeRenderHtml(
      root,
      buildHtml('<article class="htmlslide-page" data-slide-id="known"></article>')
    );
    const missingExecutable = path.join(root, "missing-chromium");

    await expect(
      renderWithChromium(optionsFor(htmlPath, ["known"], { executablePath: missingExecutable }))
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserRenderError>>({
        code: "CHROMIUM_UNAVAILABLE",
        message: expect.stringMatching(/HTMLSLIDE_CHROMIUM_EXECUTABLE.*working Chromium executable/i)
      })
    );
  });
});
