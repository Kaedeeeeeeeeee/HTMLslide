import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as nodeHttpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import path from "node:path";
import { getOfficialSkill } from "./registry.js";
import { planSkillInstall } from "./install-plan.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import {
  PROJECT_SKILL_INSTALL_LOCATIONS,
  type InstalledSkillInspection,
  type InstalledSkillSummary,
  type InvalidInstalledSkill,
  type ListInstalledSkillsResult,
  type ManagedSkillRecord,
  type ProjectSkillInstallLocation,
  type ResolvedSkillSource,
  type SkillInstallFile,
  type SkillInstallResult,
  type SkillInstallTarget,
  type SkillRemoveResult,
  type SkillSourceFile,
  type SkillSourceKind,
  type SkillSourceReference,
  type SkillStoreErrorCode,
  type SkillStoreInstallPlan,
  type SkillStoreIntegrity,
  type SkillStoreLocation
} from "./types.js";
import { isValidSkillName } from "./validation.js";

export const MANAGED_SKILL_RECORD_FILENAME = ".htmlslide-managed.json";
export const DEFAULT_MAX_SKILL_MARKDOWN_BYTES = 1024 * 1024;
export const DEFAULT_MAX_SKILL_SOURCE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_SKILL_SOURCE_FILES = 256;
export const DEFAULT_SKILL_FETCH_TIMEOUT_MS = 15_000;

const MAX_MANAGED_RECORD_BYTES = 256 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_IPV4_ADDRESSES = new BlockList();
const UNSAFE_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  UNSAFE_IPV4_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  UNSAFE_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}
const PROJECT_LOCATION_DIRS: Record<ProjectSkillInstallLocation, readonly string[]> = {
  project: ["skills", "project"],
  codex: [".agents", "skills", "htmlslide"],
  claude: [".claude", "skills", "htmlslide"]
};

interface FetchHeaders {
  get(name: string): string | null;
}

interface FetchResponse {
  status: number;
  headers: FetchHeaders;
  body: AsyncIterable<Uint8Array> | null;
  dispose?: () => void;
}

export type SkillFetch = (
  input: string,
  init: { redirect: "manual"; signal: AbortSignal }
) => Promise<FetchResponse>;

export type SkillHostResolver = (hostname: string) => Promise<readonly string[]>;

export interface SkillHttpsRequestInit {
  headers: Readonly<Record<string, string>>;
  lookup: LookupFunction;
  servername?: string;
  signal: AbortSignal;
}

export type SkillHttpsRequest = (url: URL, init: SkillHttpsRequestInit) => Promise<FetchResponse>;

export interface ResolveSkillSourceOptions {
  cwd?: string;
  fetch?: SkillFetch;
  httpsRequest?: SkillHttpsRequest;
  maxMarkdownBytes?: number;
  maxSourceBytes?: number;
  maxSourceFiles?: number;
  resolveHost?: SkillHostResolver;
  timeoutMs?: number;
}

export interface PrepareSkillInstallOptions extends ResolveSkillSourceOptions {
  source: SkillSourceReference;
  target: SkillInstallTarget;
}

export interface InstallSkillOptions extends PrepareSkillInstallOptions {
  adoptLegacyOfficial?: boolean;
  confirmWarnings?: boolean;
}

export interface InstalledSkillQueryOptions {
  target: SkillInstallTarget;
  name?: string;
}

export interface RemoveSkillOptions {
  target: SkillInstallTarget;
  name: string;
}

interface TargetRoot {
  basePath: string;
  rootPath: string;
  location: SkillStoreLocation;
}

interface InstalledSkillState {
  inspection: InstalledSkillInspection;
  recordText?: string;
}

interface PreparedDestination {
  root: TargetRoot;
  directoryPath: string;
  action: "installed" | "updated" | "adopted" | "unchanged";
  files: SkillInstallFile[];
  stagingPath?: string;
  backupPath?: string;
  committed?: boolean;
}

export class SkillStoreError extends Error {
  readonly code: SkillStoreErrorCode;
  readonly details?: unknown;

  constructor(code: SkillStoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SkillStoreError";
    this.code = code;
    this.details = details;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, sourceLabel: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillStoreError(
      "SKILL_SOURCE_INVALID_UTF8",
      `${sourceLabel} must contain valid UTF-8 Markdown.`
    );
  }
}

function safeRelativePath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    return false;
  }
  return relativePath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertSafeSourceRelativePath(relativePath: string): void {
  if (!safeRelativePath(relativePath) || relativePath === MANAGED_SKILL_RECORD_FILENAME) {
    throw new SkillStoreError(
      "SKILL_SOURCE_UNSAFE_FILE",
      `Skill source contains an unsafe or reserved path: ${relativePath}.`
    );
  }
}

function sourceFile(relativePath: string, bytes: Uint8Array, mode: number, forceUtf8 = false): SkillSourceFile {
  assertSafeSourceRelativePath(relativePath);
  const content = forceUtf8 ? decodeUtf8(bytes, relativePath) : Buffer.from(bytes).toString("base64");
  const normalizedMode: 0o644 | 0o755 = mode & 0o111 ? 0o755 : 0o644;
  return {
    relativePath,
    content,
    encoding: forceUtf8 ? "utf8" : "base64",
    mode: normalizedMode,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength
  };
}

async function readRegularFileNoFollow(filePath: string, maxBytes: number, sourceLabel: string): Promise<{
  bytes: Buffer;
  mode: number;
}> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new SkillStoreError("SKILL_SOURCE_SYMLINK", `${sourceLabel} must not be a symbolic link.`);
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new SkillStoreError("SKILL_SOURCE_UNSAFE_FILE", `${sourceLabel} must be a regular file.`);
    }
    if (info.size > maxBytes) {
      throw new SkillStoreError(
        "SKILL_SOURCE_TOO_LARGE",
        `${sourceLabel} exceeds the ${maxBytes}-byte size limit.`
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new SkillStoreError(
        "SKILL_SOURCE_TOO_LARGE",
        `${sourceLabel} exceeds the ${maxBytes}-byte size limit.`
      );
    }
    return { bytes, mode: info.mode };
  } finally {
    await handle.close();
  }
}

function parseResolvedMarkdown(
  markdown: string,
  sourceLabel: string,
  official: boolean
): ReturnType<typeof parseSkillMarkdown> & { ok: true } {
  const parsed = parseSkillMarkdown(markdown, { official });
  if (!parsed.ok) {
    throw new SkillStoreError(
      "SKILL_SOURCE_INVALID",
      `${sourceLabel} is not a valid HTMLslide skill.`,
      { issues: parsed.issues }
    );
  }
  return parsed;
}

async function readDirectorySource(
  directoryPath: string,
  options: Required<Pick<ResolveSkillSourceOptions, "maxMarkdownBytes" | "maxSourceBytes" | "maxSourceFiles">> & {
    ignoreManagedRecord?: boolean;
  }
): Promise<{ markdown: string; files: SkillSourceFile[] }> {
  const files: SkillSourceFile[] = [];
  let totalBytes = 0;

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(directoryPath, absolutePath).split(path.sep).join("/");
      if (options.ignoreManagedRecord && relativePath === MANAGED_SKILL_RECORD_FILENAME) {
        continue;
      }
      assertSafeSourceRelativePath(relativePath);
      if (entry.isSymbolicLink()) {
        throw new SkillStoreError(
          "SKILL_SOURCE_SYMLINK",
          `Skill source must not contain symbolic links: ${relativePath}.`
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillStoreError(
          "SKILL_SOURCE_UNSAFE_FILE",
          `Skill source must contain only regular files and directories: ${relativePath}.`
        );
      }
      if (files.length >= options.maxSourceFiles) {
        throw new SkillStoreError(
          "SKILL_SOURCE_TOO_MANY_FILES",
          `Skill source exceeds the ${options.maxSourceFiles}-file limit.`
        );
      }
      const remainingBytes = options.maxSourceBytes - totalBytes;
      const file = await readRegularFileNoFollow(absolutePath, remainingBytes, relativePath);
      totalBytes += file.bytes.byteLength;
      files.push(sourceFile(relativePath, file.bytes, file.mode, relativePath === "SKILL.md"));
    }
  }

  await visit(directoryPath);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const skillMarkdown = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillMarkdown) {
    throw new SkillStoreError("SKILL_SOURCE_INVALID", "A skill directory must contain SKILL.md at its root.");
  }
  if (skillMarkdown.sizeBytes > options.maxMarkdownBytes) {
    throw new SkillStoreError(
      "SKILL_SOURCE_TOO_LARGE",
      `SKILL.md exceeds the ${options.maxMarkdownBytes}-byte Markdown limit.`
    );
  }
  return { markdown: skillMarkdown.content, files };
}

function sanitizedUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.search = "";
  copy.hash = "";
  return copy.href;
}

function normalizedIpAddress(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? address;
}

function isUnsafeIpAddress(address: string): boolean {
  const normalized = normalizedIpAddress(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 0) {
    return true;
  }
  return ipVersion === 4
    ? UNSAFE_IPV4_ADDRESSES.check(normalized, "ipv4")
    : UNSAFE_IPV6_ADDRESSES.check(normalized, "ipv6");
}

function assertSafeHttpsUrl(rawUrl: string, insecureCode: SkillStoreErrorCode = "SKILL_SOURCE_URL_INSECURE"): URL {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new SkillStoreError("SKILL_SOURCE_URL_INVALID", `Skill URL exceeds ${MAX_URL_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SkillStoreError("SKILL_SOURCE_URL_INVALID", "Skill URL is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new SkillStoreError(insecureCode, "Skill URLs must use HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SkillStoreError("SKILL_SOURCE_URL_UNSAFE", "Skill URLs must not contain credentials.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (ipVersion > 0 && isUnsafeIpAddress(hostname))
  ) {
    throw new SkillStoreError("SKILL_SOURCE_URL_UNSAFE", "Skill URLs must not target local or private network addresses.");
  }
  return url;
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function resolvePublicUrlAddresses(url: URL, resolveHost: SkillHostResolver): Promise<readonly string[]> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(hostname) > 0) {
    return [hostname];
  }
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    throw new SkillStoreError("SKILL_SOURCE_DNS_FAILED", "Skill URL hostname could not be resolved.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (addresses.length === 0 || addresses.some((address) => isUnsafeIpAddress(address))) {
    throw new SkillStoreError(
      "SKILL_SOURCE_URL_UNSAFE",
      "Skill URL hostname resolved to a private, loopback, link-local, multicast, or invalid address."
    );
  }
  return [...new Set(addresses.map(normalizedIpAddress))];
}

function pinnedLookup(expectedHostname: string, addresses: readonly string[]): LookupFunction {
  const expected = expectedHostname.toLowerCase().replace(/^\[|\]$/g, "");
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));

  return (hostname, options, callback) => {
    const requested = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (requested !== expected) {
      const error = new Error("Pinned HTTPS lookup refused an unexpected hostname.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }

    const requestedFamily = options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
        ? 6
        : options.family ?? 0;
    const matching = requestedFamily === 0
      ? pinned
      : pinned.filter((entry) => entry.family === requestedFamily);
    const first = matching[0];
    if (!first) {
      const error = new Error("Pinned HTTPS lookup has no address for the requested family.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function fetchHeaders(headers: IncomingHttpHeaders): FetchHeaders {
  return {
    get(name) {
      const value = headers[name.toLowerCase()];
      if (value === undefined) {
        return null;
      }
      return Array.isArray(value) ? value.join(", ") : value;
    }
  };
}

async function defaultPinnedHttpsRequest(url: URL, init: SkillHttpsRequestInit): Promise<FetchResponse> {
  return await new Promise<FetchResponse>((resolve, reject) => {
    const requestOptions: HttpsRequestOptions = {
      agent: false,
      headers: init.headers,
      lookup: init.lookup,
      method: "GET",
      signal: init.signal
    };
    if (init.servername) {
      requestOptions.servername = init.servername;
    }
    const request = nodeHttpsRequest(url, requestOptions, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: fetchHeaders(response.headers),
        body: response,
        dispose: () => response.destroy()
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function responseBytes(response: FetchResponse, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new SkillStoreError(
        "SKILL_SOURCE_TOO_LARGE",
        `Remote skill response exceeds the ${maxBytes}-byte limit.`
      );
    }
  }
  if (response.body === null) {
    throw new SkillStoreError("SKILL_SOURCE_FETCH_FAILED", "Remote skill response did not include a body.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      throw new SkillStoreError(
        "SKILL_SOURCE_TOO_LARGE",
        `Remote skill response exceeds the ${maxBytes}-byte limit.`
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchMarkdownSource(
  rawUrl: string,
  options: Required<Pick<ResolveSkillSourceOptions, "maxMarkdownBytes" | "timeoutMs">> & {
    fetch?: SkillFetch;
    httpsRequest?: SkillHttpsRequest;
    resolveHost?: SkillHostResolver;
  }
): Promise<{ markdown: string; reference: string }> {
  let currentUrl = assertSafeHttpsUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetch;
  const httpsRequest = options.httpsRequest ?? defaultPinnedHttpsRequest;
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const addresses = await resolvePublicUrlAddresses(currentUrl, resolveHost);
      let response: FetchResponse;
      try {
        response = fetchImpl
          ? await fetchImpl(currentUrl.href, { redirect: "manual", signal: controller.signal })
          : await httpsRequest(currentUrl, {
              headers: {
                Accept: "text/markdown, text/plain;q=0.9, application/octet-stream;q=0.5",
                Host: currentUrl.host
              },
              lookup: pinnedLookup(currentUrl.hostname, addresses),
              servername: isIP(currentUrl.hostname.replace(/^\[|\]$/g, "")) === 0
                ? currentUrl.hostname
                : undefined,
              signal: controller.signal
            });
      } catch (error) {
        throw new SkillStoreError(
          "SKILL_SOURCE_FETCH_FAILED",
          controller.signal.aborted ? "Remote skill request timed out." : "Remote skill request failed.",
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === MAX_REDIRECTS) {
          throw new SkillStoreError(
            "SKILL_SOURCE_REDIRECT_LIMIT",
            `Remote skill request exceeded ${MAX_REDIRECTS} redirects.`
          );
        }
        const location = response.headers.get("location");
        response.dispose?.();
        if (!location) {
          throw new SkillStoreError("SKILL_SOURCE_REDIRECT_INVALID", "Remote skill redirect has no Location header.");
        }
        let redirected: URL;
        try {
          redirected = new URL(location, currentUrl);
        } catch {
          throw new SkillStoreError("SKILL_SOURCE_REDIRECT_INVALID", "Remote skill redirect URL is invalid.");
        }
        currentUrl = assertSafeHttpsUrl(redirected.href, "SKILL_SOURCE_REDIRECT_INVALID");
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        response.dispose?.();
        throw new SkillStoreError(
          "SKILL_SOURCE_HTTP_ERROR",
          `Remote skill request returned HTTP ${response.status}.`,
          { status: response.status }
        );
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!contentType || !["text/markdown", "text/plain", "application/octet-stream"].includes(contentType)) {
        response.dispose?.();
        throw new SkillStoreError(
          "SKILL_SOURCE_CONTENT_TYPE_UNSAFE",
          "Remote skill response must be Markdown or plain text."
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await responseBytes(response, options.maxMarkdownBytes);
      } finally {
        response.dispose?.();
      }
      return { markdown: decodeUtf8(bytes, "Remote SKILL.md"), reference: sanitizedUrl(currentUrl) };
    }
  } finally {
    clearTimeout(timeout);
  }

  throw new SkillStoreError("SKILL_SOURCE_REDIRECT_LIMIT", "Remote skill redirect limit was exceeded.");
}

function sourceDescriptor(source: SkillSourceReference): Exclude<SkillSourceReference, string> {
  if (typeof source !== "string") {
    return source;
  }
  const value = source.trim();
  if (value.length === 0) {
    throw new SkillStoreError("SKILL_SOURCE_UNSUPPORTED", "Skill source must not be empty.");
  }
  if (getOfficialSkill(value)) {
    return { kind: "official", name: value };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return { kind: "url", url: value };
  }
  return { kind: "local", path: value };
}

export async function resolveSkillSource(
  source: SkillSourceReference,
  options: ResolveSkillSourceOptions = {}
): Promise<ResolvedSkillSource> {
  const descriptor = sourceDescriptor(source);
  const limits = {
    maxMarkdownBytes: options.maxMarkdownBytes ?? DEFAULT_MAX_SKILL_MARKDOWN_BYTES,
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SKILL_SOURCE_BYTES,
    maxSourceFiles: options.maxSourceFiles ?? DEFAULT_MAX_SKILL_SOURCE_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SKILL_FETCH_TIMEOUT_MS
  };

  if (descriptor.kind === "official") {
    const official = getOfficialSkill(descriptor.name);
    if (!official) {
      throw new SkillStoreError("SKILL_SOURCE_NOT_FOUND", `Official skill not found: ${descriptor.name}.`);
    }
    const bytes = Buffer.from(official.markdown, "utf8");
    if (bytes.byteLength > limits.maxMarkdownBytes) {
      throw new SkillStoreError("SKILL_SOURCE_TOO_LARGE", "Official SKILL.md exceeds the Markdown size limit.");
    }
    const parsed = parseResolvedMarkdown(official.markdown, `Official skill ${descriptor.name}`, true);
    return {
      kind: "official",
      reference: descriptor.name,
      metadata: parsed.document.metadata,
      markdown: official.markdown,
      files: [sourceFile("SKILL.md", bytes, 0o644, true)]
    };
  }

  if (descriptor.kind === "url") {
    const fetched = await fetchMarkdownSource(descriptor.url, {
      fetch: options.fetch,
      httpsRequest: options.httpsRequest,
      maxMarkdownBytes: limits.maxMarkdownBytes,
      resolveHost: options.resolveHost,
      timeoutMs: limits.timeoutMs
    });
    const parsed = parseResolvedMarkdown(fetched.markdown, "Remote SKILL.md", false);
    if (parsed.document.metadata.entrypoint !== "SKILL.md") {
      throw new SkillStoreError(
        "SKILL_SOURCE_INVALID",
        "Direct Markdown sources must declare SKILL.md as their entrypoint."
      );
    }
    const bytes = Buffer.from(fetched.markdown, "utf8");
    return {
      kind: "url",
      reference: fetched.reference,
      metadata: parsed.document.metadata,
      markdown: fetched.markdown,
      files: [sourceFile("SKILL.md", bytes, 0o644, true)]
    };
  }

  const sourcePath = path.resolve(options.cwd ?? process.cwd(), descriptor.path);
  let info;
  try {
    info = await lstat(sourcePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new SkillStoreError("SKILL_SOURCE_NOT_FOUND", `Local skill source not found: ${sourcePath}.`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new SkillStoreError("SKILL_SOURCE_SYMLINK", "Local skill sources must not be symbolic links.");
  }

  if (info.isFile()) {
    const file = await readRegularFileNoFollow(sourcePath, limits.maxMarkdownBytes, sourcePath);
    const markdown = decodeUtf8(file.bytes, sourcePath);
    const parsed = parseResolvedMarkdown(markdown, sourcePath, false);
    if (parsed.document.metadata.entrypoint !== "SKILL.md") {
      throw new SkillStoreError(
        "SKILL_SOURCE_INVALID",
        "Single-file skill sources must declare SKILL.md as their entrypoint."
      );
    }
    return {
      kind: "local-file",
      reference: sourcePath,
      metadata: parsed.document.metadata,
      markdown,
      files: [sourceFile("SKILL.md", file.bytes, file.mode, true)]
    };
  }

  if (!info.isDirectory()) {
    throw new SkillStoreError("SKILL_SOURCE_UNSUPPORTED", "Local skill source must be a regular file or directory.");
  }
  const directory = await readDirectorySource(sourcePath, limits);
  const parsed = parseResolvedMarkdown(directory.markdown, path.join(sourcePath, "SKILL.md"), false);
  if (!directory.files.some((file) => file.relativePath === parsed.document.metadata.entrypoint)) {
    throw new SkillStoreError(
      "SKILL_SOURCE_INVALID",
      `Skill entrypoint is missing from the source directory: ${parsed.document.metadata.entrypoint}.`
    );
  }
  return {
    kind: "local-directory",
    reference: sourcePath,
    metadata: parsed.document.metadata,
    markdown: directory.markdown,
    files: directory.files
  };
}

function targetRoots(target: SkillInstallTarget): TargetRoot[] {
  if (target.kind === "global") {
    if (target.htmlslideHomeDir !== undefined) {
      const htmlslideHomeDir = path.resolve(target.htmlslideHomeDir);
      return [{
        basePath: path.dirname(htmlslideHomeDir),
        rootPath: path.join(htmlslideHomeDir, "skills"),
        location: "global"
      }];
    }
    const basePath = path.resolve(target.homeDir);
    return [{
      basePath,
      rootPath: path.join(basePath, ".htmlslide", "skills"),
      location: "global"
    }];
  }

  const basePath = path.resolve(target.projectRoot);
  const locations = [...new Set<ProjectSkillInstallLocation>(target.locations ?? ["project"])];
  return locations
    .filter((location): location is ProjectSkillInstallLocation => PROJECT_SKILL_INSTALL_LOCATIONS.includes(location))
    .map((location) => ({
      basePath,
      rootPath: path.join(basePath, ...PROJECT_LOCATION_DIRS[location]),
      location
    }));
}

function managedRecord(source: ResolvedSkillSource): ManagedSkillRecord {
  return {
    schemaVersion: 1,
    manager: "htmlslide",
    name: source.metadata.name,
    version: source.metadata.version,
    entrypoint: source.metadata.entrypoint,
    sourceKind: source.kind,
    files: source.files
      .map((file) => ({
        path: file.relativePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mode: file.mode
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"))
  };
}

function managedRecordText(record: ManagedSkillRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function planResolvedSkillInstall(
  source: ResolvedSkillSource,
  target: SkillInstallTarget
): SkillStoreInstallPlan {
  const basePlan = planSkillInstall({ metadata: source.metadata, markdown: source.markdown, target });
  const record = managedRecord(source);
  const recordContent = managedRecordText(record);
  const roots = targetRoots(target);
  const filesToWrite: SkillInstallFile[] = [];

  if (basePlan.installable) {
    for (const root of roots) {
      const skillDirectory = path.join(root.rootPath, source.metadata.name);
      for (const sourceEntry of source.files) {
        filesToWrite.push({
          path: path.join(skillDirectory, ...sourceEntry.relativePath.split("/")),
          content: sourceEntry.content,
          encoding: sourceEntry.encoding,
          mode: sourceEntry.mode,
          sha256: sourceEntry.sha256,
          sizeBytes: sourceEntry.sizeBytes,
          kind: sourceEntry.relativePath === source.metadata.entrypoint ? "entrypoint" : "support",
          overwrite: "replace"
        });
      }
      const recordBytes = Buffer.from(recordContent, "utf8");
      filesToWrite.push({
        path: path.join(skillDirectory, MANAGED_SKILL_RECORD_FILENAME),
        content: recordContent,
        encoding: "utf8",
        mode: 0o644,
        sha256: sha256(recordBytes),
        sizeBytes: recordBytes.byteLength,
        kind: "management",
        overwrite: "replace"
      });
    }
  }

  return {
    ...basePlan,
    managed: true,
    source: { kind: source.kind, reference: source.reference },
    filesToWrite,
    confirmationRequired: basePlan.warnings.some((warning) => warning.severity === "warning")
  };
}

export async function prepareSkillInstall(options: PrepareSkillInstallOptions): Promise<SkillStoreInstallPlan> {
  const source = await resolveSkillSource(options.source, options);
  return planResolvedSkillInstall(source, options.target);
}

async function ensureSafeRoot(root: TargetRoot, create: boolean): Promise<boolean> {
  const baseInfo = await lstat(root.basePath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Install base does not exist: ${root.basePath}.`);
    }
    throw error;
  });
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Install base must be a real directory: ${root.basePath}.`);
  }
  const relativeRoot = path.relative(root.basePath, root.rootPath);
  if (!safeRelativePath(relativeRoot.split(path.sep).join("/"))) {
    throw new SkillStoreError("SKILL_TARGET_UNSAFE", "Skill target root escapes its install base.");
  }
  let current = root.basePath;
  for (const segment of relativeRoot.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      if (!create) {
        return false;
      }
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") {
          throw mkdirError;
        }
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Skill target path must not contain links or files: ${current}.`);
    }
  }
  return true;
}

function parseManagedRecord(raw: string, expectedName: string): ManagedSkillRecord | undefined {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Partial<ManagedSkillRecord>;
  if (
    value.schemaVersion !== 1 ||
    value.manager !== "htmlslide" ||
    value.name !== expectedName ||
    typeof value.version !== "string" ||
    typeof value.entrypoint !== "string" ||
    !Array.isArray(value.files) ||
    !["official", "local-file", "local-directory", "url"].includes(value.sourceKind as SkillSourceKind)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      !safeRelativePath(file.path) ||
      file.path === MANAGED_SKILL_RECORD_FILENAME ||
      seen.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !SHA256_PATTERN.test(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      (file.mode !== 0o644 && file.mode !== 0o755)
    ) {
      return undefined;
    }
    seen.add(file.path);
  }
  return value as ManagedSkillRecord;
}

async function readInstalledDirectory(
  directoryPath: string,
  location: SkillStoreLocation,
  expectedName: string
): Promise<InstalledSkillState> {
  const directoryInfo = await lstat(directoryPath);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Installed skill path must be a real directory: ${directoryPath}.`);
  }
  let skillFile;
  try {
    skillFile = await readRegularFileNoFollow(
      path.join(directoryPath, "SKILL.md"),
      DEFAULT_MAX_SKILL_MARKDOWN_BYTES,
      path.join(expectedName, "SKILL.md")
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new SkillStoreError("SKILL_TARGET_INVALID", `Installed skill is missing SKILL.md: ${expectedName}.`);
    }
    if (error instanceof SkillStoreError && error.code === "SKILL_SOURCE_SYMLINK") {
      throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Installed SKILL.md must not be a symbolic link: ${expectedName}.`);
    }
    throw error;
  }
  const markdown = decodeUtf8(skillFile.bytes, path.join(expectedName, "SKILL.md"));
  const parsed = parseSkillMarkdown(markdown);
  if (!parsed.ok || parsed.document.metadata.name !== expectedName) {
    throw new SkillStoreError(
      "SKILL_TARGET_INVALID",
      `Installed skill metadata is invalid or has the wrong name: ${expectedName}.`,
      parsed.ok ? undefined : { issues: parsed.issues }
    );
  }

  let recordText: string | undefined;
  let record: ManagedSkillRecord | undefined;
  try {
    const recordFile = await readRegularFileNoFollow(
      path.join(directoryPath, MANAGED_SKILL_RECORD_FILENAME),
      MAX_MANAGED_RECORD_BYTES,
      path.join(expectedName, MANAGED_SKILL_RECORD_FILENAME)
    );
    recordText = decodeUtf8(recordFile.bytes, MANAGED_SKILL_RECORD_FILENAME);
    record = parseManagedRecord(recordText, expectedName);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  let integrity: SkillStoreIntegrity = recordText === undefined ? "unmanaged" : record ? "verified" : "invalid";
  if (record) {
    if (record.version !== parsed.document.metadata.version || record.entrypoint !== parsed.document.metadata.entrypoint) {
      integrity = "modified";
    } else {
      const actual = await readDirectorySource(directoryPath, {
        maxMarkdownBytes: DEFAULT_MAX_SKILL_MARKDOWN_BYTES,
        maxSourceBytes: DEFAULT_MAX_SKILL_SOURCE_BYTES,
        maxSourceFiles: DEFAULT_MAX_SKILL_SOURCE_FILES,
        ignoreManagedRecord: true
      });
      const actualFiles = actual.files;
      const expectedFiles = record.files;
      if (
        actualFiles.length !== expectedFiles.length ||
        expectedFiles.some((expected, index) => {
          const current = actualFiles[index];
          return !current ||
            current.relativePath !== expected.path ||
            current.sha256 !== expected.sha256 ||
            current.sizeBytes !== expected.sizeBytes ||
            current.mode !== expected.mode;
        })
      ) {
        integrity = "modified";
      }
    }
  }

  const inspection: InstalledSkillInspection = {
    name: parsed.document.metadata.name,
    version: parsed.document.metadata.version,
    description: parsed.document.metadata.description,
    license: parsed.document.metadata.license,
    riskLevel: parsed.document.metadata.riskLevel,
    location,
    directoryPath,
    entrypointPath: path.join(directoryPath, ...parsed.document.metadata.entrypoint.split("/")),
    managed: record !== undefined,
    integrity,
    metadata: parsed.document.metadata,
    markdown,
    record
  };
  return { inspection, recordText };
}

function summary(inspection: InstalledSkillInspection): InstalledSkillSummary {
  return {
    name: inspection.name,
    version: inspection.version,
    description: inspection.description,
    license: inspection.license,
    riskLevel: inspection.riskLevel,
    location: inspection.location,
    directoryPath: inspection.directoryPath,
    entrypointPath: inspection.entrypointPath,
    managed: inspection.managed,
    integrity: inspection.integrity
  };
}

function invalidInstalledSkill(
  name: string,
  root: TargetRoot,
  error: unknown
): InvalidInstalledSkill {
  const storeError = error instanceof SkillStoreError
    ? error
    : new SkillStoreError("SKILL_TARGET_INVALID", error instanceof Error ? error.message : String(error));
  return {
    name,
    location: root.location,
    directoryPath: path.join(root.rootPath, name),
    code: storeError.code,
    message: storeError.message
  };
}

export async function listInstalledSkills(options: InstalledSkillQueryOptions): Promise<ListInstalledSkillsResult> {
  const skills: InstalledSkillSummary[] = [];
  const invalid: InvalidInstalledSkill[] = [];
  for (const root of targetRoots(options.target)) {
    if (!(await ensureSafeRoot(root, false))) {
      continue;
    }
    const entries = await readdir(root.rootPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (options.name !== undefined && entry.name !== options.name) {
        continue;
      }
      if (!isValidSkillName(entry.name)) {
        invalid.push(invalidInstalledSkill(
          entry.name,
          root,
          new SkillStoreError("SKILL_NAME_INVALID", `Installed skill directory has an invalid name: ${entry.name}.`)
        ));
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        invalid.push(invalidInstalledSkill(
          entry.name,
          root,
          new SkillStoreError("SKILL_TARGET_UNSAFE", `Installed skill path must be a real directory: ${entry.name}.`)
        ));
        continue;
      }
      try {
        const installed = await readInstalledDirectory(path.join(root.rootPath, entry.name), root.location, entry.name);
        skills.push(summary(installed.inspection));
      } catch (error) {
        invalid.push(invalidInstalledSkill(entry.name, root, error));
      }
    }
  }
  const compare = (left: { name: string; location: SkillStoreLocation }, right: { name: string; location: SkillStoreLocation }) =>
    left.name.localeCompare(right.name, "en") || left.location.localeCompare(right.location, "en");
  skills.sort(compare);
  invalid.sort(compare);
  return { target: options.target.kind, skills, invalid };
}

export async function inspectInstalledSkill(options: InstalledSkillQueryOptions & { name: string }): Promise<InstalledSkillInspection[]> {
  if (!isValidSkillName(options.name)) {
    throw new SkillStoreError("SKILL_NAME_INVALID", "Skill names must use lowercase letters, numbers, and hyphens.");
  }
  const inspections: InstalledSkillInspection[] = [];
  for (const root of targetRoots(options.target)) {
    if (!(await ensureSafeRoot(root, false))) {
      continue;
    }
    const directoryPath = path.join(root.rootPath, options.name);
    try {
      const info = await lstat(directoryPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Installed skill path must be a real directory: ${directoryPath}.`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    inspections.push((await readInstalledDirectory(directoryPath, root.location, options.name)).inspection);
  }
  if (inspections.length === 0) {
    throw new SkillStoreError("SKILL_NOT_FOUND", `Installed skill not found: ${options.name}.`);
  }
  return inspections;
}

function filesForDestination(plan: SkillStoreInstallPlan, directoryPath: string): SkillInstallFile[] {
  const prefix = `${directoryPath}${path.sep}`;
  return plan.filesToWrite.filter((file) => file.path.startsWith(prefix));
}

async function writeStagingDirectory(destination: PreparedDestination): Promise<void> {
  const stagingPath = path.join(
    destination.root.rootPath,
    `.${path.basename(destination.directoryPath)}.install-${randomUUID()}`
  );
  await mkdir(stagingPath, { mode: 0o700 });
  destination.stagingPath = stagingPath;
  for (const file of destination.files) {
    const relativePath = path.relative(destination.directoryPath, file.path).split(path.sep).join("/");
    if (!safeRelativePath(relativePath)) {
      throw new SkillStoreError("SKILL_TARGET_UNSAFE", "Install plan contains a path outside the skill directory.");
    }
    const targetPath = path.join(stagingPath, ...relativePath.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
    if ((file.sizeBytes !== undefined && bytes.byteLength !== file.sizeBytes) || (file.sha256 && sha256(bytes) !== file.sha256)) {
      throw new SkillStoreError("SKILL_INSTALL_FAILED", `Install plan content changed for ${relativePath}.`);
    }
    await writeFile(targetPath, bytes, { flag: "wx", mode: file.mode ?? 0o644 });
  }
}

async function inspectLegacyOfficialDirectory(
  directoryPath: string,
  source: ResolvedSkillSource
): Promise<boolean> {
  if (source.kind !== "official") {
    throw new SkillStoreError(
      "SKILL_LEGACY_ADOPTION_NOT_ALLOWED",
      "Legacy skill adoption is allowed only for official registry sources."
    );
  }
  const expectedFiles = new Map(source.files.map((file) => [file.relativePath, file]));
  const actualFiles = new Map<string, { sha256: string; sizeBytes: number }>();
  let totalBytes = 0;

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(directoryPath, absolutePath).split(path.sep).join("/");
      if (!safeRelativePath(relativePath)) {
        throw new SkillStoreError(
          "SKILL_LEGACY_ADOPTION_UNSAFE",
          `Legacy official skill contains an unsafe path: ${relativePath}.`
        );
      }
      if (entry.isSymbolicLink()) {
        throw new SkillStoreError(
          "SKILL_LEGACY_ADOPTION_UNSAFE",
          `Legacy official skill contains a symbolic link: ${relativePath}.`
        );
      }
      if (entry.isDirectory()) {
        const expectedPrefix = `${relativePath}/`;
        if (![...expectedFiles.keys()].some((expectedPath) => expectedPath.startsWith(expectedPrefix))) {
          throw new SkillStoreError(
            "SKILL_LEGACY_ADOPTION_UNSAFE",
            `Legacy official skill contains an unexpected directory: ${relativePath}.`
          );
        }
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !expectedFiles.has(relativePath)) {
        throw new SkillStoreError(
          "SKILL_LEGACY_ADOPTION_UNSAFE",
          `Legacy official skill contains an unexpected file: ${relativePath}.`
        );
      }
      let file;
      try {
        file = await readRegularFileNoFollow(
          absolutePath,
          DEFAULT_MAX_SKILL_SOURCE_BYTES - totalBytes,
          relativePath
        );
      } catch (error) {
        throw new SkillStoreError(
          "SKILL_LEGACY_ADOPTION_UNSAFE",
          `Legacy official skill file is unsafe: ${relativePath}.`,
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
      totalBytes += file.bytes.byteLength;
      actualFiles.set(relativePath, { sha256: sha256(file.bytes), sizeBytes: file.bytes.byteLength });
    }
  }

  await visit(directoryPath);
  if (!actualFiles.has("SKILL.md")) {
    throw new SkillStoreError(
      "SKILL_LEGACY_ADOPTION_UNSAFE",
      "Legacy official skill must contain a regular SKILL.md file."
    );
  }
  return actualFiles.size === expectedFiles.size && [...expectedFiles].every(([relativePath, expected]) => {
    const actual = actualFiles.get(relativePath);
    return actual?.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes;
  });
}

async function existingDestinationAction(
  root: TargetRoot,
  directoryPath: string,
  expectedRecordText: string,
  legacyOfficialSource?: ResolvedSkillSource
): Promise<"installed" | "updated" | "adopted" | "unchanged"> {
  let info;
  try {
    info = await lstat(directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "installed";
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SkillStoreError("SKILL_TARGET_CONFLICT", `Skill install target is not a real directory: ${directoryPath}.`);
  }

  const recordPath = path.join(directoryPath, MANAGED_SKILL_RECORD_FILENAME);
  let recordInfo;
  try {
    recordInfo = await lstat(recordPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  if (recordInfo?.isSymbolicLink() || (recordInfo && !recordInfo.isFile())) {
    throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Managed skill record path is unsafe: ${recordPath}.`);
  }
  if (!recordInfo && legacyOfficialSource) {
    const current = await inspectLegacyOfficialDirectory(directoryPath, legacyOfficialSource);
    return current ? "adopted" : "updated";
  }

  const installed = await readInstalledDirectory(directoryPath, root.location, path.basename(directoryPath));
  if (installed.inspection.integrity === "invalid") {
    throw new SkillStoreError("SKILL_TARGET_INVALID", `Managed skill record is invalid: ${installed.inspection.name}.`);
  }
  if (!installed.inspection.managed) {
    throw new SkillStoreError("SKILL_TARGET_UNMANAGED", `Refusing to replace unmanaged skill: ${installed.inspection.name}.`);
  }
  if (installed.inspection.integrity !== "verified") {
    throw new SkillStoreError("SKILL_TARGET_MODIFIED", `Managed skill files were modified: ${installed.inspection.name}.`);
  }
  return installed.recordText === expectedRecordText ? "unchanged" : "updated";
}

function overallInstallAction(destinations: PreparedDestination[]): SkillInstallResult["action"] {
  if (destinations.some((destination) => destination.action === "updated")) {
    return "updated";
  }
  if (destinations.some((destination) => destination.action === "adopted")) {
    return "adopted";
  }
  if (destinations.some((destination) => destination.action === "installed")) {
    return "installed";
  }
  return "unchanged";
}

export async function installSkill(options: InstallSkillOptions): Promise<SkillInstallResult> {
  const source = await resolveSkillSource(options.source, options);
  if (options.adoptLegacyOfficial === true && source.kind !== "official") {
    throw new SkillStoreError(
      "SKILL_LEGACY_ADOPTION_NOT_ALLOWED",
      "Legacy skill adoption is allowed only for official registry sources."
    );
  }
  const plan = planResolvedSkillInstall(source, options.target);
  if (!plan.installable) {
    throw new SkillStoreError("SKILL_PLAN_NOT_INSTALLABLE", `Skill install plan is not installable: ${source.metadata.name}.`, {
      warnings: plan.warnings
    });
  }
  if (plan.confirmationRequired && options.confirmWarnings !== true) {
    throw new SkillStoreError(
      "SKILL_CONFIRMATION_REQUIRED",
      `Skill installation requires explicit confirmation: ${source.metadata.name}.`,
      { warnings: plan.warnings }
    );
  }

  const expectedRecordText = managedRecordText(managedRecord(source));
  const legacyOfficialSource = options.adoptLegacyOfficial === true ? source : undefined;
  const destinations: PreparedDestination[] = [];
  for (const root of targetRoots(options.target)) {
    await ensureSafeRoot(root, true);
    const directoryPath = path.join(root.rootPath, source.metadata.name);
    const action = await existingDestinationAction(root, directoryPath, expectedRecordText, legacyOfficialSource);
    destinations.push({
      root,
      directoryPath,
      action,
      files: filesForDestination(plan, directoryPath)
    });
  }

  const changed = destinations.filter((destination) => destination.action !== "unchanged");
  try {
    for (const destination of changed) {
      await writeStagingDirectory(destination);
    }
    for (const destination of changed) {
      const current = await lstat(destination.directoryPath).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (destination.action === "installed" && current) {
        throw new SkillStoreError("SKILL_TARGET_CONFLICT", `Skill install target appeared during installation: ${destination.directoryPath}.`);
      }
      if (destination.action === "updated" || destination.action === "adopted") {
        if (!current || current.isSymbolicLink() || !current.isDirectory()) {
          throw new SkillStoreError("SKILL_TARGET_CONFLICT", `Skill install target changed during installation: ${destination.directoryPath}.`);
        }
        const currentAction = await existingDestinationAction(
          destination.root,
          destination.directoryPath,
          expectedRecordText,
          legacyOfficialSource
        );
        if (currentAction !== destination.action) {
          throw new SkillStoreError(
            "SKILL_TARGET_CONFLICT",
            `Skill install target changed during installation: ${destination.directoryPath}.`
          );
        }
        destination.backupPath = path.join(destination.root.rootPath, `.${source.metadata.name}.backup-${randomUUID()}`);
        await rename(destination.directoryPath, destination.backupPath);
      }
      if (!destination.stagingPath) {
        throw new SkillStoreError("SKILL_INSTALL_FAILED", "Skill staging directory was not created.");
      }
      await rename(destination.stagingPath, destination.directoryPath);
      destination.stagingPath = undefined;
      destination.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const destination of [...changed].reverse()) {
      try {
        if (destination.committed) {
          await rm(destination.directoryPath, { recursive: true, force: true });
        }
        if (destination.backupPath) {
          await rename(destination.backupPath, destination.directoryPath);
          destination.backupPath = undefined;
        }
        if (destination.stagingPath) {
          await rm(destination.stagingPath, { recursive: true, force: true });
          destination.stagingPath = undefined;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new SkillStoreError(
        "SKILL_INSTALL_FAILED",
        `Skill installation failed and rollback was incomplete: ${source.metadata.name}.`,
        {
          cause: error instanceof Error ? error.message : String(error),
          rollbackErrors: rollbackErrors.map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          )
        }
      );
    }
    if (error instanceof SkillStoreError) {
      throw error;
    }
    throw new SkillStoreError("SKILL_INSTALL_FAILED", `Failed to install skill: ${source.metadata.name}.`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    for (const destination of changed) {
      if (destination.backupPath) {
        await rm(destination.backupPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    throw new SkillStoreError("SKILL_INSTALL_FAILED", `Installed skill but could not remove its backup: ${source.metadata.name}.`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    action: overallInstallAction(destinations),
    skillName: source.metadata.name,
    version: source.metadata.version,
    source: plan.source,
    locations: destinations.map((destination) => ({
      location: destination.root.location,
      directoryPath: destination.directoryPath,
      action: destination.action
    })),
    warnings: plan.warnings
  };
}

export async function removeSkill(options: RemoveSkillOptions): Promise<SkillRemoveResult> {
  if (!isValidSkillName(options.name)) {
    throw new SkillStoreError("SKILL_NAME_INVALID", "Skill names must use lowercase letters, numbers, and hyphens.");
  }
  const candidates: Array<{ root: TargetRoot; directoryPath: string; tombstonePath?: string }> = [];
  const missing: SkillStoreLocation[] = [];
  for (const root of targetRoots(options.target)) {
    if (!(await ensureSafeRoot(root, false))) {
      missing.push(root.location);
      continue;
    }
    const directoryPath = path.join(root.rootPath, options.name);
    let info;
    try {
      info = await lstat(directoryPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        missing.push(root.location);
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SkillStoreError("SKILL_TARGET_UNSAFE", `Refusing to remove unsafe skill path: ${directoryPath}.`);
    }
    const installed = await readInstalledDirectory(directoryPath, root.location, options.name);
    if (installed.inspection.integrity === "invalid") {
      throw new SkillStoreError("SKILL_TARGET_INVALID", `Managed skill record is invalid: ${options.name}.`);
    }
    if (!installed.inspection.managed) {
      throw new SkillStoreError("SKILL_TARGET_UNMANAGED", `Refusing to remove unmanaged skill: ${options.name}.`);
    }
    if (installed.inspection.integrity !== "verified") {
      throw new SkillStoreError(
        "SKILL_TARGET_MODIFIED",
        `Refusing to remove a managed skill that does not pass integrity validation: ${options.name}.`
      );
    }
    candidates.push({ root, directoryPath });
  }
  if (candidates.length === 0) {
    throw new SkillStoreError("SKILL_NOT_FOUND", `Installed skill not found: ${options.name}.`);
  }

  try {
    for (const candidate of candidates) {
      const current = await readInstalledDirectory(candidate.directoryPath, candidate.root.location, options.name);
      if (!current.inspection.managed || current.inspection.integrity !== "verified") {
        throw new SkillStoreError(
          "SKILL_TARGET_MODIFIED",
          `Skill changed before removal: ${options.name}.`
        );
      }
      candidate.tombstonePath = path.join(candidate.root.rootPath, `.${options.name}.remove-${randomUUID()}`);
      await rename(candidate.directoryPath, candidate.tombstonePath);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const candidate of [...candidates].reverse()) {
      if (!candidate.tombstonePath) {
        continue;
      }
      try {
        await rename(candidate.tombstonePath, candidate.directoryPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new SkillStoreError(
        "SKILL_REMOVE_FAILED",
        `Skill removal failed and rollback was incomplete: ${options.name}.`,
        {
          cause: error instanceof Error ? error.message : String(error),
          rollbackErrors: rollbackErrors.map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          )
        }
      );
    }
    throw new SkillStoreError("SKILL_REMOVE_FAILED", `Failed to remove skill: ${options.name}.`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    for (const candidate of candidates) {
      if (candidate.tombstonePath) {
        await rm(candidate.tombstonePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    throw new SkillStoreError("SKILL_REMOVE_FAILED", `Removed skill but could not delete its tombstone: ${options.name}.`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  return {
    action: "removed",
    skillName: options.name,
    removed: candidates.map((candidate) => ({
      location: candidate.root.location,
      directoryPath: candidate.directoryPath
    })),
    missing
  };
}
