import { createInflateRaw } from "node:zlib";

export type ZipResourceLimits = {
  maxEntryCount: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
};

export type ZipPreflightIssue = {
  type: string;
  message: string;
  path: string;
};

type ZipEntry = {
  name: string;
  nameBytes: Uint8Array;
  isDirectory: boolean;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataStart: number;
  dataEnd: number;
};

type EndOfCentralDirectory = {
  offset: number;
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
};

class ZipPreflightValidationError extends Error {
  readonly issue: ZipPreflightIssue;

  constructor(issue: ZipPreflightIssue) {
    super(issue.message);
    this.name = "ZipPreflightValidationError";
    this.issue = issue;
  }
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const CENTRAL_DIRECTORY_ENTRY_BYTES = 46;
const LOCAL_FILE_HEADER_BYTES = 30;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const GENERAL_PURPOSE_ENCRYPTED = 0x0001;
const GENERAL_PURPOSE_DATA_DESCRIPTOR = 0x0008;
const GENERAL_PURPOSE_STRONG_ENCRYPTION = 0x0040;
const ZIP_COMPRESSION_STORE = 0;
const ZIP_COMPRESSION_DEFLATE = 8;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

export async function preflightZipArchive(
  bytes: Uint8Array,
  limits: ZipResourceLimits,
  packagePath: string
): Promise<ZipPreflightIssue | undefined> {
  try {
    const entries = parseZipArchive(bytes, limits, packagePath);
    let actualTotalUncompressedBytes = 0;

    for (const entry of entries) {
      if (entry.isDirectory) {
        continue;
      }

      const measurement = await measureEntryExpansion(
        bytes,
        entry,
        limits,
        actualTotalUncompressedBytes,
        packagePath
      );
      actualTotalUncompressedBytes += measurement.uncompressedBytes;

      if (measurement.uncompressedBytes !== entry.uncompressedSize) {
        throw entryMetadataError(
          entry.name,
          `Archive entry ${entry.name} expands to ${measurement.uncompressedBytes} bytes but declares ${entry.uncompressedSize}. Re-export the deck as a standard ZIP package.`
        );
      }
      if (measurement.crc32 !== entry.crc32) {
        throw new ZipPreflightValidationError({
          type: "deckpkg-entry-crc-mismatch",
          message: `Archive entry ${entry.name} failed its CRC32 integrity check. Re-export the deck package from a trusted source.`,
          path: entry.name
        });
      }
    }

    return undefined;
  } catch (error) {
    if (error instanceof ZipPreflightValidationError) {
      return error.issue;
    }
    return {
      type: "invalid-deckpkg-archive",
      message: "Unable to safely inspect the deck package ZIP archive. Re-export the deck as a standard ZIP package.",
      path: packagePath
    };
  }
}

function parseZipArchive(bytes: Uint8Array, limits: ZipResourceLimits, packagePath: string): ZipEntry[] {
  const endRecord = findEndOfCentralDirectory(bytes, packagePath);
  if (endRecord.entryCount > limits.maxEntryCount) {
    throw new ZipPreflightValidationError({
      type: "deckpkg-entry-count-exceeded",
      message: `Deck package contains ${endRecord.entryCount} archive entries; the alpha limit is ${limits.maxEntryCount}. Remove unused package assets and re-export the deck.`,
      path: packagePath
    });
  }

  const centralDirectoryEnd = endRecord.centralDirectoryOffset + endRecord.centralDirectorySize;
  if (
    endRecord.centralDirectoryOffset > endRecord.offset ||
    centralDirectoryEnd !== endRecord.offset ||
    centralDirectoryEnd > bytes.byteLength
  ) {
    throw archiveError(
      packagePath,
      "Deck package central-directory bounds are invalid. Re-export the deck as a standard ZIP package."
    );
  }

  const entries: ZipEntry[] = [];
  let cursor = endRecord.centralDirectoryOffset;
  let declaredTotalUncompressedBytes = 0;
  for (let index = 0; index < endRecord.entryCount; index += 1) {
    const entry = parseCentralDirectoryEntry(bytes, cursor, centralDirectoryEnd, packagePath);
    entries.push(entry);
    cursor = entryCentralDirectoryEnd(bytes, cursor, centralDirectoryEnd, packagePath);

    if (!entry.isDirectory && entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipPreflightValidationError({
        type: "deckpkg-entry-too-large",
        message: `Archive entry ${entry.name} declares ${entry.uncompressedSize} uncompressed bytes; the per-entry alpha limit is ${limits.maxEntryUncompressedBytes} bytes. Reduce or split this asset and re-export the deck.`,
        path: entry.name
      });
    }
    declaredTotalUncompressedBytes += entry.isDirectory ? 0 : entry.uncompressedSize;
  }

  if (cursor !== centralDirectoryEnd) {
    throw archiveError(
      packagePath,
      "Deck package central directory contains unsupported trailing records. Re-export the deck as a standard ZIP package."
    );
  }
  if (declaredTotalUncompressedBytes > limits.maxTotalUncompressedBytes) {
    throw new ZipPreflightValidationError({
      type: "deckpkg-total-uncompressed-size-exceeded",
      message: `Deck package declares ${declaredTotalUncompressedBytes} total uncompressed bytes; the alpha limit is ${limits.maxTotalUncompressedBytes} bytes. Reduce embedded or unused assets and re-export the deck.`,
      path: packagePath
    });
  }

  validateEntryPaths(entries);
  validateLocalFileHeaders(bytes, entries, endRecord.centralDirectoryOffset, packagePath);
  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array, packagePath: string): EndOfCentralDirectory {
  const firstCandidate = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES;
  const lastCandidate = Math.max(0, firstCandidate - MAX_ZIP_COMMENT_BYTES);

  for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
    if (readUint32LittleEndian(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentLength = readUint16LittleEndian(bytes, offset + 20);
    if (commentLength === undefined || offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength !== bytes.byteLength) {
      continue;
    }

    const diskNumber = readRequiredUint16(bytes, offset + 4, packagePath);
    const centralDirectoryDisk = readRequiredUint16(bytes, offset + 6, packagePath);
    const diskEntryCount = readRequiredUint16(bytes, offset + 8, packagePath);
    const entryCount = readRequiredUint16(bytes, offset + 10, packagePath);
    const centralDirectorySize = readRequiredUint32(bytes, offset + 12, packagePath);
    const centralDirectoryOffset = readRequiredUint32(bytes, offset + 16, packagePath);

    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
      throw archiveError(
        packagePath,
        "Multi-disk deck package archives are not supported. Re-export the deck as a single ZIP package."
      );
    }
    if (
      entryCount === 0xffff ||
      diskEntryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw archiveError(
        packagePath,
        "ZIP64 deck package archives are not supported. Reduce the package size and re-export the deck."
      );
    }

    return {
      offset,
      entryCount,
      centralDirectoryOffset,
      centralDirectorySize
    };
  }

  throw archiveError(
    packagePath,
    "Deck package end-of-central-directory record is missing or malformed. Re-export the deck as a standard ZIP package."
  );
}

function parseCentralDirectoryEntry(
  bytes: Uint8Array,
  offset: number,
  centralDirectoryEnd: number,
  packagePath: string
): ZipEntry {
  if (
    offset + CENTRAL_DIRECTORY_ENTRY_BYTES > centralDirectoryEnd ||
    readUint32LittleEndian(bytes, offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE
  ) {
    throw archiveError(
      packagePath,
      "Deck package central directory is malformed. Re-export the deck as a standard ZIP package."
    );
  }

  const flags = readRequiredUint16(bytes, offset + 8, packagePath);
  const compressionMethod = readRequiredUint16(bytes, offset + 10, packagePath);
  const crc32 = readRequiredUint32(bytes, offset + 16, packagePath);
  const compressedSize = readRequiredUint32(bytes, offset + 20, packagePath);
  const uncompressedSize = readRequiredUint32(bytes, offset + 24, packagePath);
  const nameLength = readRequiredUint16(bytes, offset + 28, packagePath);
  const extraLength = readRequiredUint16(bytes, offset + 30, packagePath);
  const commentLength = readRequiredUint16(bytes, offset + 32, packagePath);
  const diskStart = readRequiredUint16(bytes, offset + 34, packagePath);
  const localHeaderOffset = readRequiredUint32(bytes, offset + 42, packagePath);
  const entryEnd = offset + CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength + extraLength + commentLength;

  if (entryEnd > centralDirectoryEnd || nameLength === 0) {
    throw archiveError(
      packagePath,
      "Deck package central-directory entry bounds are invalid. Re-export the deck as a standard ZIP package."
    );
  }
  if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
    throw archiveError(
      packagePath,
      "ZIP64 or multi-disk deck package entries are not supported. Re-export the deck as a standard ZIP package."
    );
  }

  const nameBytes = bytes.subarray(offset + CENTRAL_DIRECTORY_ENTRY_BYTES, offset + CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength);
  const name = decodeEntryName(nameBytes, packagePath);
  validateEntryFlags(flags, name, packagePath);
  validateCompressionMethod(compressionMethod, name);
  validateExtraFields(
    bytes.subarray(
      offset + CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength,
      offset + CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength + extraLength
    ),
    name,
    packagePath
  );

  const isDirectory = name.endsWith("/");
  if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
    throw entryMetadataError(
      name,
      `Directory entry ${name} contains file data. Re-export the deck as a standard ZIP package.`
    );
  }

  return {
    name,
    nameBytes,
    isDirectory,
    flags,
    compressionMethod,
    crc32,
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
    dataStart: 0,
    dataEnd: 0
  };
}

function entryCentralDirectoryEnd(
  bytes: Uint8Array,
  offset: number,
  centralDirectoryEnd: number,
  packagePath: string
): number {
  const nameLength = readRequiredUint16(bytes, offset + 28, packagePath);
  const extraLength = readRequiredUint16(bytes, offset + 30, packagePath);
  const commentLength = readRequiredUint16(bytes, offset + 32, packagePath);
  const entryEnd = offset + CENTRAL_DIRECTORY_ENTRY_BYTES + nameLength + extraLength + commentLength;
  if (entryEnd > centralDirectoryEnd) {
    throw archiveError(packagePath, "Deck package central-directory entry exceeds its declared bounds.");
  }
  return entryEnd;
}

function validateEntryPaths(entries: readonly ZipEntry[]): void {
  const paths = entries.map((entry) => ({
    entry,
    path: entry.isDirectory ? entry.name.slice(0, -1) : entry.name,
    canonicalPath: (entry.isDirectory ? entry.name.slice(0, -1) : entry.name).normalize("NFC").toLowerCase()
  }));
  const pathByCanonicalName = new Map<string, (typeof paths)[number]>();

  for (const record of paths) {
    if (
      record.path.length === 0 ||
      record.path.includes("\0") ||
      record.path.includes("\\") ||
      record.path.startsWith("/") ||
      record.path.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(record.path) ||
      record.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw unsafePathError(record.entry.name);
    }
    if (pathByCanonicalName.has(record.canonicalPath)) {
      throw new ZipPreflightValidationError({
        type: "unsafe-deckpkg-entry-path",
        message: `Archive entry ${record.entry.name} overlaps another package path. Re-export the deck with unique project-relative package paths.`,
        path: record.entry.name
      });
    }
    pathByCanonicalName.set(record.canonicalPath, record);
  }

  for (const record of paths) {
    const segments = record.canonicalPath.split("/");
    for (let segmentCount = 1; segmentCount < segments.length; segmentCount += 1) {
      const parent = pathByCanonicalName.get(segments.slice(0, segmentCount).join("/"));
      if (parent && !parent.entry.isDirectory) {
        throw new ZipPreflightValidationError({
          type: "unsafe-deckpkg-entry-path",
          message: `Archive entry ${record.entry.name} overlaps file path ${parent.entry.name}. Re-export the deck with unique project-relative package paths.`,
          path: record.entry.name
        });
      }
    }
  }
}

function validateLocalFileHeaders(
  bytes: Uint8Array,
  entries: ZipEntry[],
  centralDirectoryOffset: number,
  packagePath: string
): void {
  for (const entry of entries) {
    const offset = entry.localHeaderOffset;
    if (
      offset + LOCAL_FILE_HEADER_BYTES > centralDirectoryOffset ||
      readUint32LittleEndian(bytes, offset) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw entryMetadataError(
        entry.name,
        `Archive entry ${entry.name} has an invalid local file header. Re-export the deck as a standard ZIP package.`
      );
    }

    const localFlags = readRequiredUint16(bytes, offset + 6, packagePath);
    const localCompressionMethod = readRequiredUint16(bytes, offset + 8, packagePath);
    const localCrc32 = readRequiredUint32(bytes, offset + 14, packagePath);
    const localCompressedSize = readRequiredUint32(bytes, offset + 18, packagePath);
    const localUncompressedSize = readRequiredUint32(bytes, offset + 22, packagePath);
    const localNameLength = readRequiredUint16(bytes, offset + 26, packagePath);
    const localExtraLength = readRequiredUint16(bytes, offset + 28, packagePath);
    const localNameStart = offset + LOCAL_FILE_HEADER_BYTES;
    const localNameEnd = localNameStart + localNameLength;
    const localExtraEnd = localNameEnd + localExtraLength;

    if (localExtraEnd > centralDirectoryOffset) {
      throw entryMetadataError(
        entry.name,
        `Archive entry ${entry.name} has invalid local-header bounds. Re-export the deck as a standard ZIP package.`
      );
    }
    if ((localFlags & (GENERAL_PURPOSE_ENCRYPTED | GENERAL_PURPOSE_STRONG_ENCRYPTION)) !== 0) {
      throw encryptedArchiveError(packagePath);
    }
    if ((localFlags & GENERAL_PURPOSE_DATA_DESCRIPTOR) !== 0) {
      throw entryMetadataError(
        entry.name,
        `Archive entry ${entry.name} uses an unsupported data descriptor. Re-export the deck with fixed entry sizes.`
      );
    }

    const localNameBytes = bytes.subarray(localNameStart, localNameEnd);
    if (
      localFlags !== entry.flags ||
      localCompressionMethod !== entry.compressionMethod ||
      localCrc32 !== entry.crc32 ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize ||
      !bytesEqual(localNameBytes, entry.nameBytes)
    ) {
      throw entryMetadataError(
        entry.name,
        `Archive entry ${entry.name} has inconsistent central and local metadata. Re-export the deck as a standard ZIP package.`
      );
    }

    validateExtraFields(bytes.subarray(localNameEnd, localExtraEnd), entry.name, packagePath);
    entry.dataStart = localExtraEnd;
    entry.dataEnd = entry.dataStart + entry.compressedSize;
    if (entry.dataEnd > centralDirectoryOffset || entry.dataEnd < entry.dataStart) {
      throw entryMetadataError(
        entry.name,
        `Archive entry ${entry.name} compressed data exceeds archive bounds. Re-export the deck as a standard ZIP package.`
      );
    }
  }

  const spans = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataEnd, name: entry.name }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (previous && current && current.start < previous.end) {
      throw entryMetadataError(
        current.name,
        `Archive entry ${current.name} overlaps another local entry region. Re-export the deck as a standard ZIP package.`
      );
    }
  }
}

async function measureEntryExpansion(
  bytes: Uint8Array,
  entry: ZipEntry,
  limits: ZipResourceLimits,
  totalBeforeEntry: number,
  packagePath: string
): Promise<{ uncompressedBytes: number; crc32: number }> {
  if (entry.compressionMethod === ZIP_COMPRESSION_STORE) {
    assertExpansionWithinLimits(entry, entry.compressedSize, totalBeforeEntry, limits, packagePath);
    return {
      uncompressedBytes: entry.compressedSize,
      crc32: finalizeCrc32(updateCrc32(0xffffffff, bytes.subarray(entry.dataStart, entry.dataEnd)))
    };
  }

  return new Promise<{ uncompressedBytes: number; crc32: number }>((resolve, reject) => {
    const inflater = createInflateRaw({ chunkSize: 16 * 1024 });
    let expandedBytes = 0;
    let crc32 = 0xffffffff;
    let settled = false;

    const fail = (error: ZipPreflightValidationError): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
      inflater.destroy();
    };

    inflater.on("data", (chunk: Uint8Array) => {
      if (settled) {
        return;
      }
      expandedBytes += chunk.byteLength;
      crc32 = updateCrc32(crc32, chunk);
      try {
        assertExpansionWithinLimits(entry, expandedBytes, totalBeforeEntry, limits, packagePath);
      } catch (error) {
        if (error instanceof ZipPreflightValidationError) {
          fail(error);
          return;
        }
        fail(entryMetadataError(entry.name, `Archive entry ${entry.name} could not be safely expanded.`));
      }
    });
    inflater.once("error", () => {
      fail(
        entryMetadataError(
          entry.name,
          `Archive entry ${entry.name} contains malformed DEFLATE data. Re-export the deck as a standard ZIP package.`
        )
      );
    });
    inflater.once("end", () => {
      if (!settled) {
        settled = true;
        resolve({ uncompressedBytes: expandedBytes, crc32: finalizeCrc32(crc32) });
      }
    });
    inflater.end(bytes.subarray(entry.dataStart, entry.dataEnd));
  });
}

function updateCrc32(current: number, bytes: Uint8Array): number {
  let crc = current >>> 0;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function finalizeCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function assertExpansionWithinLimits(
  entry: ZipEntry,
  expandedBytes: number,
  totalBeforeEntry: number,
  limits: ZipResourceLimits,
  packagePath: string
): void {
  if (expandedBytes > limits.maxEntryUncompressedBytes) {
    throw new ZipPreflightValidationError({
      type: "deckpkg-entry-too-large",
      message: `Archive entry ${entry.name} expands beyond the per-entry alpha limit of ${limits.maxEntryUncompressedBytes} bytes. Reduce or split this asset and re-export the deck.`,
      path: entry.name
    });
  }
  if (totalBeforeEntry + expandedBytes > limits.maxTotalUncompressedBytes) {
    throw new ZipPreflightValidationError({
      type: "deckpkg-total-uncompressed-size-exceeded",
      message: `Deck package expands beyond the total alpha limit of ${limits.maxTotalUncompressedBytes} bytes. Reduce embedded or unused assets and re-export the deck.`,
      path: packagePath
    });
  }
}

function validateEntryFlags(flags: number, entryName: string, packagePath: string): void {
  if ((flags & (GENERAL_PURPOSE_ENCRYPTED | GENERAL_PURPOSE_STRONG_ENCRYPTION)) !== 0) {
    throw encryptedArchiveError(packagePath);
  }
  if ((flags & GENERAL_PURPOSE_DATA_DESCRIPTOR) !== 0) {
    throw entryMetadataError(
      entryName,
      `Archive entry ${entryName} uses an unsupported data descriptor. Re-export the deck with fixed entry sizes.`
    );
  }
}

function validateCompressionMethod(compressionMethod: number, entryName: string): void {
  if (compressionMethod === ZIP_COMPRESSION_STORE || compressionMethod === ZIP_COMPRESSION_DEFLATE) {
    return;
  }
  throw new ZipPreflightValidationError({
    type: "unsupported-deckpkg-compression",
    message: `Archive entry ${entryName} uses unsupported ZIP compression method ${compressionMethod}. Re-export the deck with STORE or DEFLATE compression.`,
    path: entryName
  });
}

function validateExtraFields(extraBytes: Uint8Array, entryName: string, packagePath: string): void {
  let cursor = 0;
  while (cursor < extraBytes.byteLength) {
    const fieldId = readUint16LittleEndian(extraBytes, cursor);
    const fieldSize = readUint16LittleEndian(extraBytes, cursor + 2);
    if (fieldId === undefined || fieldSize === undefined || cursor + 4 + fieldSize > extraBytes.byteLength) {
      throw entryMetadataError(
        entryName,
        `Archive entry ${entryName} has malformed ZIP extra fields. Re-export the deck as a standard ZIP package.`
      );
    }
    if (fieldId === ZIP64_EXTRA_FIELD_ID) {
      throw archiveError(
        packagePath,
        "ZIP64 deck package entries are not supported. Reduce the package size and re-export the deck."
      );
    }
    cursor += 4 + fieldSize;
  }
}

function decodeEntryName(nameBytes: Uint8Array, packagePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    throw archiveError(
      packagePath,
      "Deck package contains a non-UTF-8 entry name. Re-export the deck with UTF-8 package paths."
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function readRequiredUint16(bytes: Uint8Array, offset: number, packagePath: string): number {
  const value = readUint16LittleEndian(bytes, offset);
  if (value === undefined) {
    throw archiveError(packagePath, "Deck package ZIP metadata is truncated.");
  }
  return value;
}

function readRequiredUint32(bytes: Uint8Array, offset: number, packagePath: string): number {
  const value = readUint32LittleEndian(bytes, offset);
  if (value === undefined) {
    throw archiveError(packagePath, "Deck package ZIP metadata is truncated.");
  }
  return value;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number | undefined {
  const byte0 = bytes[offset];
  const byte1 = bytes[offset + 1];
  return byte0 === undefined || byte1 === undefined ? undefined : byte0 | (byte1 << 8);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number | undefined {
  const byte0 = bytes[offset];
  const byte1 = bytes[offset + 1];
  const byte2 = bytes[offset + 2];
  const byte3 = bytes[offset + 3];
  if (byte0 === undefined || byte1 === undefined || byte2 === undefined || byte3 === undefined) {
    return undefined;
  }
  return (byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24)) >>> 0;
}

function archiveError(packagePath: string, message: string): ZipPreflightValidationError {
  return new ZipPreflightValidationError({
    type: "invalid-deckpkg-archive",
    message,
    path: packagePath
  });
}

function encryptedArchiveError(packagePath: string): ZipPreflightValidationError {
  return new ZipPreflightValidationError({
    type: "encrypted-deckpkg-archive",
    message: "Encrypted deck package archives are not supported. Re-export the deck without ZIP encryption.",
    path: packagePath
  });
}

function entryMetadataError(entryName: string, message: string): ZipPreflightValidationError {
  return new ZipPreflightValidationError({
    type: "invalid-deckpkg-entry-metadata",
    message,
    path: entryName
  });
}

function unsafePathError(entryName: string): ZipPreflightValidationError {
  return new ZipPreflightValidationError({
    type: "unsafe-deckpkg-entry-path",
    message: `Archive entry ${entryName} uses an unsafe path. Re-export the deck with project-relative package paths that contain no traversal, absolute paths, or backslashes.`,
    path: entryName
  });
}
