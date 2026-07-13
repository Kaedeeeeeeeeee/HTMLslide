import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rasterizePdfPages, type PdfRasterCommandResult } from "../src/index";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const createInput = async (): Promise<{ root: string; pdfPath: string; outputDirectory: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-pdf-raster-test-"));
  temporaryRoots.push(root);
  const pdfPath = path.join(root, "input.pdf");
  const outputDirectory = path.join(root, "raster");
  await writeFile(pdfPath, "%PDF-1.7\n");
  return { root, pdfPath, outputDirectory };
};

const probeResult = (): PdfRasterCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "pdftoppm version 26.05.0",
  timedOut: false
});

describe("PDF raster helper", () => {
  it("fails explicitly when the Poppler executable is missing", async () => {
    const input = await createInput();
    const runner = async (): Promise<PdfRasterCommandResult> => ({
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      errorCode: "ENOENT",
      errorMessage: "spawn pdftoppm ENOENT"
    });

    await expect(rasterizePdfPages({ ...input, runner })).rejects.toMatchObject({
      code: "PDF_RASTER_EXECUTABLE_NOT_FOUND"
    });
  });

  it("reports a non-zero Poppler exit code instead of skipping the gate", async () => {
    const input = await createInput();
    const runner = async (
      _executable: string,
      args: readonly string[]
    ): Promise<PdfRasterCommandResult> => args[0] === "-v"
      ? probeResult()
      : {
          exitCode: 7,
          signal: null,
          stdout: "",
          stderr: "Syntax Error: damaged PDF",
          timedOut: false
        };

    await expect(rasterizePdfPages({ ...input, runner })).rejects.toMatchObject({
      code: "PDF_RASTER_COMMAND_FAILED",
      details: "Syntax Error: damaged PDF"
    });
  });

  it("rejects malformed PNG output from a successful command", async () => {
    const input = await createInput();
    const runner = async (
      _executable: string,
      args: readonly string[]
    ): Promise<PdfRasterCommandResult> => {
      if (args[0] === "-v") {
        return probeResult();
      }
      await writeFile(`${args.at(-1)}-1.png`, "not a png");
      return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false
      };
    };

    await expect(rasterizePdfPages({ ...input, expectedPageCount: 1, runner })).rejects.toMatchObject({
      code: "PDF_RASTER_PNG_INVALID"
    });
    await expect(readFile(path.join(input.outputDirectory, "missing.png"))).rejects.toBeTruthy();
  });
});
