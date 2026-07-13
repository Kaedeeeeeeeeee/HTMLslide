import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DPI = 96;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PdfRasterErrorCode =
  | "PDF_RASTER_INPUT_NOT_FOUND"
  | "PDF_RASTER_INPUT_INVALID"
  | "PDF_RASTER_EXECUTABLE_NOT_FOUND"
  | "PDF_RASTER_EXECUTABLE_INVALID"
  | "PDF_RASTER_TIMEOUT"
  | "PDF_RASTER_COMMAND_FAILED"
  | "PDF_RASTER_OUTPUT_INVALID"
  | "PDF_RASTER_PNG_INVALID";

export class PdfRasterError extends Error {
  readonly code: PdfRasterErrorCode;
  readonly details?: string;

  constructor(code: PdfRasterErrorCode, message: string, details?: string) {
    super(message);
    this.name = "PdfRasterError";
    this.code = code;
    this.details = details;
  }
}

export type PdfRasterCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type PdfRasterCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<PdfRasterCommandResult>;

export type PdfRasterPage = {
  pageNumber: number;
  path: string;
  width: number;
  height: number;
};

export type PdfRasterResult = {
  executable: string;
  version: string;
  dpi: number;
  pages: PdfRasterPage[];
};

export type PdfRasterOptions = {
  pdfPath: string;
  outputDirectory: string;
  dpi?: number;
  timeoutMs?: number;
  expectedPageCount?: number;
  expectedPageDimensions?: { width: number; height: number };
  executablePath?: string;
  runner?: PdfRasterCommandRunner;
};

const isPathLikeExecutable = (executable: string): boolean =>
  path.isAbsolute(executable) || executable.includes(path.sep);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const formatCommandOutput = (result: PdfRasterCommandResult): string => {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return output.length > 4_000 ? `${output.slice(0, 4_000)}...` : output;
};

export const runPdfRasterCommand: PdfRasterCommandRunner = async (
  executable,
  args,
  options
): Promise<PdfRasterCommandResult> => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let finished = false;
  let killTimer: NodeJS.Timeout | undefined;

  const finish = (result: PdfRasterCommandResult): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (killTimer) {
      clearTimeout(killTimer);
    }
    resolve(result);
  };

  let child;
  try {
    child = spawn(executable, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    resolve({
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      timedOut,
      errorCode: errorCode(error),
      errorMessage: errorMessage(error)
    });
    return;
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error: unknown) => {
    finish({
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      timedOut,
      errorCode: errorCode(error),
      errorMessage: errorMessage(error)
    });
  });
  child.on("close", (exitCode, signal) => {
    finish({ exitCode, signal, stdout, stderr, timedOut });
  });
  const timeoutTimer = setTimeout(() => {
    if (finished) {
      return;
    }
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, options.timeoutMs);
});

const validateInputPdf = async (pdfPath: string): Promise<void> => {
  try {
    const info = await stat(pdfPath);
    if (!info.isFile()) {
      throw new PdfRasterError("PDF_RASTER_INPUT_INVALID", `PDF input is not a regular file: ${pdfPath}`);
    }
  } catch (error) {
    if (error instanceof PdfRasterError) {
      throw error;
    }
    throw new PdfRasterError(
      errorCode(error) === "ENOENT" ? "PDF_RASTER_INPUT_NOT_FOUND" : "PDF_RASTER_INPUT_INVALID",
      `Unable to access PDF input: ${pdfPath}`,
      errorMessage(error)
    );
  }
};

const validateExplicitExecutable = async (executable: string): Promise<void> => {
  try {
    const info = await stat(executable);
    if (!info.isFile()) {
      throw new PdfRasterError("PDF_RASTER_EXECUTABLE_INVALID", `Poppler executable is not a regular file: ${executable}`);
    }
    await access(executable, constants.X_OK);
  } catch (error) {
    if (error instanceof PdfRasterError) {
      throw error;
    }
    throw new PdfRasterError(
      errorCode(error) === "ENOENT" ? "PDF_RASTER_EXECUTABLE_NOT_FOUND" : "PDF_RASTER_EXECUTABLE_INVALID",
      `Poppler executable is not available: ${executable}`,
      errorMessage(error)
    );
  }
};

const detectExecutable = async (
  executable: string,
  runner: PdfRasterCommandRunner,
  timeoutMs: number,
  cwd: string
): Promise<string> => {
  if (isPathLikeExecutable(executable)) {
    await validateExplicitExecutable(executable);
  }

  const probe = await runner(executable, ["-v"], { cwd, timeoutMs });
  if (probe.timedOut) {
    throw new PdfRasterError(
      "PDF_RASTER_TIMEOUT",
      `Timed out while probing Poppler executable after ${timeoutMs} ms: ${executable}`,
      formatCommandOutput(probe)
    );
  }
  if (probe.errorCode === "ENOENT") {
    throw new PdfRasterError(
      "PDF_RASTER_EXECUTABLE_NOT_FOUND",
      `Poppler executable was not found on PATH: ${executable}`,
      probe.errorMessage
    );
  }
  if (probe.errorCode || probe.exitCode !== 0) {
    throw new PdfRasterError(
      "PDF_RASTER_EXECUTABLE_INVALID",
      `Poppler executable could not run: ${executable}`,
      [probe.errorMessage, formatCommandOutput(probe)].filter(Boolean).join("\n")
    );
  }

  const version = `${probe.stdout}\n${probe.stderr}`.match(/pdftoppm\s+version\s+([^\s]+)/iu)?.[1];
  if (!version) {
    throw new PdfRasterError(
      "PDF_RASTER_EXECUTABLE_INVALID",
      `Poppler executable did not report a pdftoppm version: ${executable}`,
      formatCommandOutput(probe)
    );
  }
  return version;
};

const parsePngDimensions = (bytes: Buffer, pngPath: string): { width: number; height: number } => {
  if (bytes.length < PNG_SIGNATURE.length + 8 + 13 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new PdfRasterError("PDF_RASTER_PNG_INVALID", `Rasterized page is not a PNG: ${pngPath}`);
  }

  const chunkLength = bytes.readUInt32BE(PNG_SIGNATURE.length);
  const chunkType = bytes.toString("ascii", PNG_SIGNATURE.length + 4, PNG_SIGNATURE.length + 8);
  if (chunkType !== "IHDR" || chunkLength !== 13) {
    throw new PdfRasterError("PDF_RASTER_PNG_INVALID", `Rasterized page has no valid PNG IHDR: ${pngPath}`);
  }

  const width = bytes.readUInt32BE(PNG_SIGNATURE.length + 8);
  const height = bytes.readUInt32BE(PNG_SIGNATURE.length + 12);
  if (width <= 0 || height <= 0) {
    throw new PdfRasterError("PDF_RASTER_PNG_INVALID", `Rasterized page has invalid PNG dimensions: ${pngPath}`);
  }
  return { width, height };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const readPdfRasterPngDimensions = async (pngPath: string): Promise<{ width: number; height: number }> => {
  try {
    return parsePngDimensions(await readFile(pngPath), pngPath);
  } catch (error) {
    if (error instanceof PdfRasterError) {
      throw error;
    }
    throw new PdfRasterError("PDF_RASTER_PNG_INVALID", `Unable to read rasterized page: ${pngPath}`, errorMessage(error));
  }
};

export const rasterizePdfPages = async (options: PdfRasterOptions): Promise<PdfRasterResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const expectedPageCount = options.expectedPageCount;
  const runner = options.runner ?? runPdfRasterCommand;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PdfRasterError("PDF_RASTER_INPUT_INVALID", `PDF raster timeout must be a positive integer: ${timeoutMs}`);
  }
  if (!Number.isInteger(dpi) || dpi <= 0) {
    throw new PdfRasterError("PDF_RASTER_INPUT_INVALID", `PDF raster DPI must be a positive integer: ${dpi}`);
  }
  if (expectedPageCount !== undefined && (!Number.isInteger(expectedPageCount) || expectedPageCount <= 0)) {
    throw new PdfRasterError(
      "PDF_RASTER_INPUT_INVALID",
      `Expected PDF page count must be a positive integer: ${expectedPageCount}`
    );
  }

  await validateInputPdf(options.pdfPath);
  await mkdir(options.outputDirectory, { recursive: true });
  const executable = options.executablePath ?? "pdftoppm";
  const version = await detectExecutable(executable, runner, timeoutMs, options.outputDirectory);
  const prefix = path.join(options.outputDirectory, `.htmlslide-pdf-${randomUUID()}`);
  const args = ["-png", "-r", String(dpi), "-f", "1"];
  if (expectedPageCount !== undefined) {
    args.push("-l", String(expectedPageCount));
  }
  args.push(options.pdfPath, prefix);

  const command = await runner(executable, args, { cwd: options.outputDirectory, timeoutMs });
  if (command.timedOut) {
    throw new PdfRasterError(
      "PDF_RASTER_TIMEOUT",
      `Timed out while rasterizing PDF after ${timeoutMs} ms: ${options.pdfPath}`,
      formatCommandOutput(command)
    );
  }
  if (command.errorCode) {
    throw new PdfRasterError(
      command.errorCode === "ENOENT" ? "PDF_RASTER_EXECUTABLE_NOT_FOUND" : "PDF_RASTER_COMMAND_FAILED",
      `Unable to execute Poppler raster command: ${executable}`,
      [command.errorMessage, formatCommandOutput(command)].filter(Boolean).join("\n")
    );
  }
  if (command.exitCode !== 0) {
    throw new PdfRasterError(
      "PDF_RASTER_COMMAND_FAILED",
      `Poppler raster command failed with exit code ${String(command.exitCode)}: ${options.pdfPath}`,
      formatCommandOutput(command)
    );
  }

  const prefixPattern = new RegExp(`^${escapeRegExp(path.basename(prefix))}-(\\d+)\\.png$`, "u");
  let outputEntries;
  try {
    outputEntries = await readdir(options.outputDirectory, { withFileTypes: true });
  } catch (error) {
    throw new PdfRasterError(
      "PDF_RASTER_OUTPUT_INVALID",
      `Unable to inspect Poppler output directory: ${options.outputDirectory}`,
      errorMessage(error)
    );
  }
  const generatedPages = outputEntries
    .map((entry) => {
      const match = entry.isFile() ? prefixPattern.exec(entry.name) : undefined;
      return match ? { pageNumber: Number(match[1]), path: path.join(options.outputDirectory, entry.name) } : undefined;
    })
    .filter((page): page is { pageNumber: number; path: string } => page !== undefined)
    .sort((left, right) => left.pageNumber - right.pageNumber);

  if (generatedPages.length === 0 || generatedPages.some((page, index) => page.pageNumber !== index + 1)) {
    throw new PdfRasterError(
      "PDF_RASTER_OUTPUT_INVALID",
      `Poppler did not produce a contiguous PNG page sequence for ${options.pdfPath}.`,
      formatCommandOutput(command)
    );
  }
  if (expectedPageCount !== undefined && generatedPages.length !== expectedPageCount) {
    throw new PdfRasterError(
      "PDF_RASTER_OUTPUT_INVALID",
      `Poppler produced ${generatedPages.length} pages; expected ${expectedPageCount}.`,
      formatCommandOutput(command)
    );
  }

  const pages: PdfRasterPage[] = [];
  try {
    for (const generatedPage of generatedPages) {
      const dimensions = await readPdfRasterPngDimensions(generatedPage.path);
      if (
        options.expectedPageDimensions &&
        (dimensions.width !== options.expectedPageDimensions.width || dimensions.height !== options.expectedPageDimensions.height)
      ) {
        throw new PdfRasterError(
          "PDF_RASTER_OUTPUT_INVALID",
          `Rasterized page ${generatedPage.pageNumber} has ${dimensions.width}x${dimensions.height}; expected ${options.expectedPageDimensions.width}x${options.expectedPageDimensions.height}.`
        );
      }
      pages.push({ ...generatedPage, ...dimensions });
    }
  } catch (error) {
    await Promise.all(generatedPages.map((page) => rm(page.path, { force: true })));
    throw error;
  }

  return { executable, version, dpi, pages };
};
