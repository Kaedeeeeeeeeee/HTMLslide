import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request
} from "playwright-core";

export type BrowserRenderSize = {
  width: number;
  height: number;
};

export type BrowserRenderOptions = {
  htmlPath: string;
  title: string;
  viewport: BrowserRenderSize;
  thumbnailSize: BrowserRenderSize;
  slideIds: string[];
  executablePath?: string;
};

export type BrowserRenderResult = {
  pdf: Buffer;
  thumbnails: Map<string, Buffer>;
};

export type ChromiumRuntimeStatus =
  | { available: true; executablePath: string; version: string }
  | { available: false; executablePath: string; error: string };

export class BrowserRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserRenderError";
    this.code = code;
  }
}

type RenderDiagnostics = {
  blockedRequests: Map<string, string>;
  consoleErrors: string[];
  failedRequests: Map<string, string>;
  pageErrors: string[];
};

const FIXED_PDF_DATE = new Date("2000-01-01T00:00:00.000Z");
const PDF_APPLICATION_NAME = "HTMLslide compiler";
const BROWSER_RUNTIME_ERROR_ENV = "HTMLSLIDE_BROWSER_RUNTIME_ERROR";
const RESOURCE_WAIT_TIMEOUT_MS = 15_000;
const READINESS_TIMEOUT_MS = 16_000;
const LAYOUT_TIMEOUT_MS = 3_000;
const LAYOUT_FRAME_LIMIT = 120;
const PDF_RENDER_TIMEOUT_MS = 20_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
// Browser shutdown can take longer than rendering on loaded macOS workers.
// Keep cleanup fail-closed, but allow the process a bounded grace period.
const CLEANUP_TIMEOUT_MS = 30_000;

const assertSize = (name: string, size: BrowserRenderSize): void => {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new BrowserRenderError(
      "INVALID_RENDER_SIZE",
      `${name} must contain positive integer width and height values. Received ${size.width}x${size.height}.`
    );
  }
};

const resolveExecutablePath = (explicitPath?: string): string => {
  const configuredPath = explicitPath?.trim() || process.env.HTMLSLIDE_CHROMIUM_EXECUTABLE?.trim();
  return configuredPath || chromium.executablePath();
};

export const inspectChromiumRuntime = async (explicitPath?: string): Promise<ChromiumRuntimeStatus> => {
  const executablePath = resolveExecutablePath(explicitPath);
  const configurationError = process.env[BROWSER_RUNTIME_ERROR_ENV]?.trim();
  if (configurationError) {
    return { available: false, executablePath, error: configurationError };
  }
  let browser: Browser | undefined;
  try {
    await access(executablePath, fsConstants.X_OK);
    browser = await chromium.launch({ executablePath, headless: true });
    return {
      available: true,
      executablePath,
      version: browser.version()
    };
  } catch (error) {
    return {
      available: false,
      executablePath,
      error: errorMessage(error)
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const injectStyle = async (page: Page, content: string): Promise<void> => {
  await page.evaluate((css) => {
    const style = document.createElement("style");
    style.setAttribute("data-htmlslide-browser-renderer", "true");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
  }, content);
};

const consoleMessageText = (message: ConsoleMessage): string => {
  const location = message.location();
  const source = location.url ? ` (${location.url}${location.lineNumber ? `:${location.lineNumber}` : ""})` : "";
  return `${message.text()}${source}`;
};

const requestFailureText = (request: Request): string => request.failure()?.errorText ?? "unknown request failure";

const isPathInside = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
};

const installNetworkIsolation = async (
  context: BrowserContext,
  diagnostics: RenderDiagnostics,
  renderRoot: string
): Promise<void> => {
  await context.routeWebSocket(/^(?:ws|wss):\/\//i, (webSocket) => {
    diagnostics.blockedRequests.set(webSocket.url(), "WebSocket connections are not allowed");
    webSocket.close({ code: 1008, reason: "HTMLslide renderer network policy" });
  });

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      diagnostics.blockedRequests.set(url, "malformed URL");
      await route.abort("blockedbyclient");
      return;
    }

    if (parsedUrl.protocol === "data:" || parsedUrl.protocol === "about:") {
      await route.continue();
      return;
    }

    if (parsedUrl.protocol === "file:") {
      let requestedPath: string;
      try {
        requestedPath = path.resolve(fileURLToPath(parsedUrl));
      } catch {
        diagnostics.blockedRequests.set(url, "invalid file URL");
        await route.abort("blockedbyclient");
        return;
      }
      let effectivePath = requestedPath;
      try {
        effectivePath = await realpath(requestedPath);
      } catch {
        // Missing in-root files continue so request diagnostics can report the asset path.
      }
      if (isPathInside(renderRoot, effectivePath)) {
        await route.continue();
        return;
      }
      diagnostics.blockedRequests.set(url, `file is outside render root ${renderRoot}`);
      await route.abort("blockedbyclient");
      return;
    }

    diagnostics.blockedRequests.set(url, `protocol ${parsedUrl.protocol || "<missing>"} is not allowed`);
    await route.abort("blockedbyclient");
  });
};

const waitForAssets = async (page: Page): Promise<string[]> => {
  const deadline = Date.now() + RESOURCE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      fontFailures: Array.from(document.fonts)
        .filter((font) => font.status === "error")
        .map((font) => `${font.family} (${font.style} ${font.weight})`),
      fontsLoaded: document.fonts.status === "loaded",
      images: Array.from(document.images).map((image) => ({
        complete: image.complete,
        height: image.naturalHeight,
        source: image.currentSrc || image.src || image.getAttribute("src") || "<missing src>",
        width: image.naturalWidth
      }))
    }));
    const failures = state.images
      .filter((image) => image.complete && (image.width <= 0 || image.height <= 0))
      .map((image) => `${image.source}: image completed without decodable dimensions`);
    failures.push(...state.fontFailures.map((font) => `font failed to load: ${font}`));
    if (failures.length > 0) {
      return failures;
    }
    if (state.fontsLoaded && state.images.every((image) => image.complete)) {
      return [];
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for document fonts and images after ${RESOURCE_WAIT_TIMEOUT_MS}ms.`);
};

const waitForStableLayout = async (page: Page): Promise<void> => {
  await withTimeout(
    (async () => {
      const readLayoutSignature = (): Promise<string> =>
        page.evaluate(() => {
          const pageRects = Array.from(document.querySelectorAll<HTMLElement>(".htmlslide-page[data-slide-id]")).map(
            (element) => {
              const rect = element.getBoundingClientRect();
              return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 1_000) / 1_000);
            }
          );
          return JSON.stringify([
            document.documentElement.scrollWidth,
            document.documentElement.scrollHeight,
            document.body.scrollWidth,
            document.body.scrollHeight,
            pageRects
          ]);
        });

      let previous = await readLayoutSignature();
      let stableFrames = 0;
      for (let frame = 0; frame < LAYOUT_FRAME_LIMIT; frame += 1) {
        await delay(17);
        const current = await readLayoutSignature();
        stableFrames = current === previous ? stableFrames + 1 : 0;
        if (stableFrames >= 2) {
          return;
        }
        previous = current;
      }
      throw new Error(`Layout did not remain stable for two frames within ${LAYOUT_FRAME_LIMIT} render intervals.`);
    })(),
    LAYOUT_TIMEOUT_MS,
    "Chromium layout stabilization"
  );
};

const formatResourceError = (diagnostics: RenderDiagnostics, imageFailures: string[]): BrowserRenderError | undefined => {
  const details: string[] = [];
  if (diagnostics.blockedRequests.size > 0) {
    details.push(
      `Blocked requests: ${Array.from(diagnostics.blockedRequests, ([url, reason]) => `${url} (${reason})`).join(", ")}. Copy resources into the render root and reference them with file-relative URLs.`
    );
  }
  if (diagnostics.failedRequests.size > 0) {
    details.push(
      `Failed resources: ${Array.from(diagnostics.failedRequests, ([url, reason]) => `${url} (${reason})`).join(", ")}. Verify that every local asset exists and is readable.`
    );
  }
  if (imageFailures.length > 0) {
    details.push(`Failed images: ${imageFailures.join(", ")}. Replace or repair the referenced image files.`);
  }
  if (details.length === 0) {
    return undefined;
  }
  return new BrowserRenderError("RENDER_RESOURCE_FAILURE", `Chromium could not load all render resources. ${details.join(" ")}`);
};

const formatPageError = (diagnostics: RenderDiagnostics): BrowserRenderError | undefined => {
  const details = [
    ...diagnostics.pageErrors.map((message) => `Page error: ${message}`),
    ...diagnostics.consoleErrors.map((message) => `Console error: ${message}`)
  ];
  return details.length > 0
    ? new BrowserRenderError(
        "RENDER_PAGE_ERROR",
        `Chromium reported errors while rendering. ${details.join(" ")}. Fix the render HTML/CSS before exporting.`
      )
    : undefined;
};

const assertSlideIds = async (page: Page, slideIds: string[]): Promise<void> => {
  const duplicates = slideIds.filter((slideId, index) => slideIds.indexOf(slideId) !== index);
  if (duplicates.length > 0) {
    throw new BrowserRenderError(
      "DUPLICATE_SLIDE_ID",
      `slideIds must be unique. Duplicate values: ${Array.from(new Set(duplicates)).join(", ")}.`
    );
  }

  for (const slideId of slideIds) {
    const count = await page.locator(".htmlslide-page[data-slide-id]").evaluateAll(
      (elements, expectedId) => elements.filter((element) => element.getAttribute("data-slide-id") === expectedId).length,
      slideId
    );
    if (count === 0) {
      throw new BrowserRenderError(
        "UNKNOWN_SLIDE_ID",
        `Slide "${slideId}" was not found in the render document. Ensure slideIds match .htmlslide-page[data-slide-id] values.`
      );
    }
    if (count > 1) {
      throw new BrowserRenderError(
        "DUPLICATE_SLIDE_ELEMENT",
        `Slide "${slideId}" matched ${count} .htmlslide-page elements. Each render slide id must be unique.`
      );
    }
  }
};

const normalizePdf = async (bytes: Uint8Array, title: string, expectedPageCount: number): Promise<Buffer> => {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.getPageCount() !== expectedPageCount) {
    throw new BrowserRenderError(
      "PDF_PAGE_COUNT_MISMATCH",
      `Chromium produced ${pdf.getPageCount()} PDF pages for ${expectedPageCount} slides. Check @page sizing and print-only slide visibility rules.`
    );
  }

  pdf.setTitle(title);
  pdf.setCreator(PDF_APPLICATION_NAME);
  pdf.setProducer(PDF_APPLICATION_NAME);
  pdf.setCreationDate(FIXED_PDF_DATE);
  pdf.setModificationDate(FIXED_PDF_DATE);
  return Buffer.from(
    await pdf.save({
      addDefaultPage: false,
      objectsPerTick: 100_000,
      useObjectStreams: false
    })
  );
};

const renderThumbnails = async (
  page: Page,
  slideIds: string[],
  viewport: BrowserRenderSize,
  thumbnailSize: BrowserRenderSize
): Promise<Map<string, Buffer>> => {
  const scaleX = thumbnailSize.width / viewport.width;
  const scaleY = thumbnailSize.height / viewport.height;
  await injectStyle(
    page,
    `
html, body {
  width: ${viewport.width}px !important;
  min-width: ${viewport.width}px !important;
  max-width: ${viewport.width}px !important;
  height: ${viewport.height}px !important;
  min-height: ${viewport.height}px !important;
  max-height: ${viewport.height}px !important;
  margin: 0 !important;
  overflow: hidden !important;
}
.htmlslide-deck {
  position: relative !important;
  display: block !important;
  width: ${viewport.width}px !important;
  height: ${viewport.height}px !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  gap: 0 !important;
  overflow: hidden !important;
}
.htmlslide-page[data-slide-id] {
  display: none !important;
}
.htmlslide-page[data-slide-id][data-htmlslide-render-target="true"] {
  position: absolute !important;
  inset: 0 auto auto 0 !important;
  display: block !important;
  width: ${viewport.width}px !important;
  min-width: ${viewport.width}px !important;
  max-width: ${viewport.width}px !important;
  height: ${viewport.height}px !important;
  min-height: ${viewport.height}px !important;
  max-height: ${viewport.height}px !important;
  margin: 0 !important;
  overflow: hidden !important;
  transform: scale(${scaleX}, ${scaleY}) !important;
  transform-origin: top left !important;
  box-shadow: none !important;
  outline: none !important;
}
* {
  animation: none !important;
  caret-color: transparent !important;
  cursor: none !important;
  transition: none !important;
}
`
  );

  const thumbnails = new Map<string, Buffer>();
  for (const slideId of slideIds) {
    const slides = page.locator(".htmlslide-page[data-slide-id]");
    await slides.evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute("data-htmlslide-render-target");
      }
    });
    const targetIndex = await slides.evaluateAll(
      (elements, expectedId) => elements.findIndex((element) => element.getAttribute("data-slide-id") === expectedId),
      slideId
    );
    if (targetIndex < 0) {
      throw new BrowserRenderError("UNKNOWN_SLIDE_ID", `Slide "${slideId}" disappeared before thumbnail capture.`);
    }
    const targetSlide = slides.nth(targetIndex);
    await targetSlide.evaluate((element) => element.setAttribute("data-htmlslide-render-target", "true"));
    await waitForStableLayout(page);
    const bytes = await targetSlide.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      timeout: SCREENSHOT_TIMEOUT_MS,
      type: "png"
    });
    const buffer = Buffer.from(bytes);
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
      throw new BrowserRenderError("INVALID_THUMBNAIL", `Chromium returned an invalid PNG for slide "${slideId}".`);
    }
    const actualWidth = buffer.readUInt32BE(16);
    const actualHeight = buffer.readUInt32BE(20);
    if (actualWidth !== thumbnailSize.width || actualHeight !== thumbnailSize.height) {
      throw new BrowserRenderError(
        "THUMBNAIL_SIZE_MISMATCH",
        `Chromium produced ${actualWidth}x${actualHeight} for slide "${slideId}"; expected ${thumbnailSize.width}x${thumbnailSize.height}.`
      );
    }
    thumbnails.set(slideId, buffer);
  }
  return thumbnails;
};

export const renderWithChromium = async (options: BrowserRenderOptions): Promise<BrowserRenderResult> => {
  assertSize("viewport", options.viewport);
  assertSize("thumbnailSize", options.thumbnailSize);
  if (options.slideIds.length === 0) {
    throw new BrowserRenderError("MISSING_SLIDES", "slideIds must contain at least one slide id.");
  }

  const configurationError = process.env[BROWSER_RUNTIME_ERROR_ENV]?.trim();
  if (configurationError) {
    throw new BrowserRenderError(
      "CHROMIUM_UNAVAILABLE",
      `HTMLslide Chromium runtime configuration is invalid. ${configurationError}`
    );
  }

  const executablePath = resolveExecutablePath(options.executablePath);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let renderFailure: unknown;
  let result: BrowserRenderResult | undefined;
  const cleanupErrors: string[] = [];

  try {
    try {
      browser = await chromium.launch({ executablePath, headless: true });
    } catch (error) {
      throw new BrowserRenderError(
        "CHROMIUM_UNAVAILABLE",
        `Unable to launch Chromium at "${executablePath}". Install the Playwright Chromium build or set HTMLSLIDE_CHROMIUM_EXECUTABLE to a working Chromium executable. ${errorMessage(error)}`,
        { cause: error }
      );
    }

    context = await browser.newContext({
      acceptDownloads: false,
      colorScheme: "light",
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      timezoneId: "UTC",
      viewport: options.viewport
    });

    const diagnostics: RenderDiagnostics = {
      blockedRequests: new Map(),
      consoleErrors: [],
      failedRequests: new Map(),
      pageErrors: []
    };
    const absoluteHtmlPath = path.resolve(options.htmlPath);
    const renderRootPath = path.dirname(absoluteHtmlPath);
    const renderRoot = await realpath(renderRootPath).catch(() => renderRootPath);
    await installNetworkIsolation(context, diagnostics, renderRoot);
    page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        diagnostics.consoleErrors.push(consoleMessageText(message));
      }
    });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (!diagnostics.blockedRequests.has(request.url())) {
        diagnostics.failedRequests.set(request.url(), requestFailureText(request));
      }
    });

    await page.emulateMedia({ media: "print" });
    const renderUrl = pathToFileURL(absoluteHtmlPath).href;
    try {
      await page.goto(renderUrl, { timeout: RESOURCE_WAIT_TIMEOUT_MS, waitUntil: "load" });
    } catch (error) {
      throw new BrowserRenderError(
        "RENDER_DOCUMENT_LOAD_FAILED",
        `Unable to load render HTML at "${options.htmlPath}". Verify that the file and its parent directory are readable. ${errorMessage(error)}`,
        { cause: error }
      );
    }

    await injectStyle(
      page,
      "*, *::before, *::after { animation: none !important; caret-color: transparent !important; cursor: none !important; transition: none !important; } html { scroll-behavior: auto !important; }"
    );

    let imageFailures: string[] = [];
    try {
      await withTimeout(
        (async () => {
          imageFailures = await waitForAssets(page);
          await waitForStableLayout(page);
        })(),
        READINESS_TIMEOUT_MS,
        "Chromium render readiness"
      );
    } catch (error) {
      const resourceError = formatResourceError(diagnostics, imageFailures);
      if (resourceError) {
        throw resourceError;
      }
      throw new BrowserRenderError(
        "RENDER_NOT_READY",
        `Chromium render document did not become ready. ${errorMessage(error)} Check local fonts, images, and layout stability.`,
        { cause: error }
      );
    }

    const resourceError = formatResourceError(diagnostics, imageFailures);
    if (resourceError) {
      throw resourceError;
    }
    const pageError = formatPageError(diagnostics);
    if (pageError) {
      throw pageError;
    }

    await assertSlideIds(page, options.slideIds);
    const rawPdf = await withTimeout(
      page.pdf({ printBackground: true, preferCSSPageSize: true }),
      PDF_RENDER_TIMEOUT_MS,
      "Chromium PDF rendering"
    );
    // Complete PDF normalization before thumbnail viewport and stylesheet mutations.
    const pdf = await normalizePdf(rawPdf, options.title, options.slideIds.length);
    const thumbnails = await renderThumbnails(page, options.slideIds, options.viewport, options.thumbnailSize);
    result = { pdf, thumbnails };
  } catch (error) {
    renderFailure = error;
  } finally {
    if (page) {
      try {
        await withTimeout(page.close(), CLEANUP_TIMEOUT_MS, "Chromium page cleanup");
      } catch (error) {
        cleanupErrors.push(`page: ${errorMessage(error)}`);
      }
    }
    if (context) {
      try {
        await withTimeout(context.close(), CLEANUP_TIMEOUT_MS, "Chromium context cleanup");
      } catch (error) {
        cleanupErrors.push(`context: ${errorMessage(error)}`);
      }
    }
    if (browser) {
      try {
        await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS, "Chromium browser cleanup");
      } catch (error) {
        cleanupErrors.push(`browser: ${errorMessage(error)}`);
      }
    }
  }

  if (renderFailure) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [renderFailure, ...cleanupErrors.map((message) => new Error(message))],
        `Chromium rendering failed and cleanup was incomplete (${cleanupErrors.join("; ")}).`
      );
    }
    throw renderFailure;
  }
  if (cleanupErrors.length > 0) {
    throw new BrowserRenderError(
      "CHROMIUM_CLEANUP_FAILED",
      `Chromium rendered artifacts but cleanup failed (${cleanupErrors.join("; ")}). No browser resources were intentionally retained.`
    );
  }
  if (!result) {
    throw new BrowserRenderError("RENDER_FAILED", "Chromium rendering ended without artifacts.");
  }
  return result;
};
