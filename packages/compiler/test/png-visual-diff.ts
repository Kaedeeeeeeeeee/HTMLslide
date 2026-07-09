import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export type PngVisualDiffResult = {
  width: number;
  height: number;
  pixelCount: number;
  diffPixels: number;
  diffRatio: number;
  artifactsWritten: boolean;
  message: string;
};

type DecodedPng = {
  width: number;
  height: number;
  pixels: Buffer;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The compiler fallback emits non-interlaced 8-bit RGBA PNGs with filter 0.
// Browser screenshots commonly use PNG row filters, so the decoder supports the
// standard non-interlaced 8-bit RGB/RGBA forms used by Playwright screenshots.

const safeArtifactName = (value: string): string => value.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-|-$/gu, "") || "png-diff";

const assertPngSignature = (bytes: Buffer): void => {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature.");
  }
};

const decodeRgbaPng = (bytes: Buffer): DecodedPng => {
  assertPngSignature(bytes);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compressionMethod = 0;
  let filterMethod = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error("Truncated PNG chunk header.");
    }

    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (nextOffset > bytes.length) {
      throw new Error(`Truncated PNG chunk: ${type}.`);
    }

    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      compressionMethod = data[10] ?? 0;
      filterMethod = data[11] ?? 0;
      interlaceMethod = data[12] ?? 0;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = nextOffset;
  }

  if (width <= 0 || height <= 0) {
    throw new Error("PNG is missing a valid IHDR chunk.");
  }

  if (bitDepth !== 8 || ![2, 6].includes(colorType) || compressionMethod !== 0 || filterMethod !== 0 || interlaceMethod !== 0) {
    throw new Error("Only non-interlaced 8-bit RGB/RGBA PNGs are supported for visual regression.");
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const inputPixelStride = width * bytesPerPixel;
  const rowStride = inputPixelStride + 1;
  if (raw.byteLength !== rowStride * height) {
    throw new Error("PNG decompressed byte length does not match IHDR dimensions.");
  }

  const decoded = Buffer.alloc(inputPixelStride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    const filterType = raw[rowStart] ?? -1;
    if (filterType < 0 || filterType > 4) {
      throw new Error(`Unsupported PNG row filter ${filterType}.`);
    }

    const inputStart = rowStart + 1;
    const outputStart = y * inputPixelStride;
    for (let index = 0; index < inputPixelStride; index += 1) {
      const rawValue = raw[inputStart + index] ?? 0;
      const left = index >= bytesPerPixel ? decoded[outputStart + index - bytesPerPixel] ?? 0 : 0;
      const up = y > 0 ? decoded[outputStart - inputPixelStride + index] ?? 0 : 0;
      const upLeft =
        y > 0 && index >= bytesPerPixel
          ? decoded[outputStart - inputPixelStride + index - bytesPerPixel] ?? 0
          : 0;
      let predictor = 0;

      if (filterType === 1) {
        predictor = left;
      } else if (filterType === 2) {
        predictor = up;
      } else if (filterType === 3) {
        predictor = Math.floor((left + up) / 2);
      } else if (filterType === 4) {
        const estimate = left + up - upLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upLeftDistance = Math.abs(estimate - upLeft);
        predictor = leftDistance <= upDistance && leftDistance <= upLeftDistance
          ? left
          : upDistance <= upLeftDistance
            ? up
            : upLeft;
      }

      decoded[outputStart + index] = (rawValue + predictor) & 0xff;
    }
  }

  const pixels = Buffer.alloc(width * height * 4);
  if (bytesPerPixel === 4) {
    decoded.copy(pixels);
  } else {
    for (let index = 0; index < width * height; index += 1) {
      const inputOffset = index * 3;
      const outputOffset = index * 4;
      pixels[outputOffset] = decoded[inputOffset] ?? 0;
      pixels[outputOffset + 1] = decoded[inputOffset + 1] ?? 0;
      pixels[outputOffset + 2] = decoded[inputOffset + 2] ?? 0;
      pixels[outputOffset + 3] = 255;
    }
  }

  return {
    width,
    height,
    pixels
  };
};

let crcTable: Uint32Array | undefined;

const getCrcTable = (): Uint32Array => {
  if (crcTable) {
    return crcTable;
  }

  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
};

const crc32 = (buffers: Buffer[]): number => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32([typeBuffer, data]), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
};

const encodeRgbaPng = (image: DecodedPng): Buffer => {
  const pixelStride = image.width * 4;
  const rowStride = pixelStride + 1;
  const raw = Buffer.alloc(rowStride * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0;
    image.pixels.copy(raw, rowStart + 1, y * pixelStride, (y + 1) * pixelStride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
};

const buildDiffImage = (expected: DecodedPng, actual: DecodedPng): { image: DecodedPng; diffPixels: number } => {
  const width = Math.max(expected.width, actual.width);
  const height = Math.max(expected.height, actual.height);
  const pixels = Buffer.alloc(width * height * 4);
  let diffPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const outputOffset = (y * width + x) * 4;
      const expectedInBounds = x < expected.width && y < expected.height;
      const actualInBounds = x < actual.width && y < actual.height;
      const expectedOffset = (y * expected.width + x) * 4;
      const actualOffset = (y * actual.width + x) * 4;
      const changed = !expectedInBounds || !actualInBounds ||
        expected.pixels[expectedOffset] !== actual.pixels[actualOffset] ||
        expected.pixels[expectedOffset + 1] !== actual.pixels[actualOffset + 1] ||
        expected.pixels[expectedOffset + 2] !== actual.pixels[actualOffset + 2] ||
        expected.pixels[expectedOffset + 3] !== actual.pixels[actualOffset + 3];

      if (changed) {
        diffPixels += 1;
        pixels[outputOffset] = 239;
        pixels[outputOffset + 1] = 68;
        pixels[outputOffset + 2] = 68;
        pixels[outputOffset + 3] = 255;
      } else {
        const source = expected.pixels[expectedOffset] ?? 0;
        const gray = Math.round(source * 0.25 + 192);
        pixels[outputOffset] = gray;
        pixels[outputOffset + 1] = gray;
        pixels[outputOffset + 2] = gray;
        pixels[outputOffset + 3] = 255;
      }
    }
  }

  return {
    image: { width, height, pixels },
    diffPixels
  };
};

export const comparePngWithGolden = async (options: {
  actualPath: string;
  goldenPath: string;
  artifactDir: string;
  artifactName: string;
  maxDiffRatio: number;
}): Promise<PngVisualDiffResult> => {
  const [actualBytes, goldenBytes] = await Promise.all([
    readFile(options.actualPath),
    readFile(options.goldenPath)
  ]);
  const actual = decodeRgbaPng(actualBytes);
  const expected = decodeRgbaPng(goldenBytes);
  const diff = buildDiffImage(expected, actual);
  const pixelCount = diff.image.width * diff.image.height;
  const diffRatio = pixelCount === 0 ? 1 : diff.diffPixels / pixelCount;
  const shouldWriteArtifacts =
    expected.width !== actual.width ||
    expected.height !== actual.height ||
    diffRatio > options.maxDiffRatio;

  if (shouldWriteArtifacts) {
    const artifactBase = safeArtifactName(options.artifactName);
    await mkdir(options.artifactDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(options.artifactDir, `${artifactBase}-before.png`), goldenBytes),
      writeFile(path.join(options.artifactDir, `${artifactBase}-after.png`), actualBytes),
      writeFile(path.join(options.artifactDir, `${artifactBase}-diff.png`), encodeRgbaPng(diff.image))
    ]);
  }

  const percent = (diffRatio * 100).toFixed(4);
  return {
    width: actual.width,
    height: actual.height,
    pixelCount,
    diffPixels: diff.diffPixels,
    diffRatio,
    artifactsWritten: shouldWriteArtifacts,
    message: `${options.artifactName} visual diff: ${diff.diffPixels}/${pixelCount} pixels (${percent}%).`
  };
};
