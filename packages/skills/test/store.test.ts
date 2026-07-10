import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOfficialSkill,
  installSkill,
  inspectInstalledSkill,
  listInstalledSkills,
  MANAGED_SKILL_RECORD_FILENAME,
  prepareSkillInstall,
  removeSkill,
  resolveSkillSource,
  SkillStoreError,
  type SkillFetch,
  type SkillHttpsRequest
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "htmlslide-skills-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function skillMarkdown(options: {
  name?: string;
  version?: string;
  license?: string;
  riskLevel?: "low" | "medium" | "high";
  scripts?: boolean;
  network?: boolean;
  remoteAssets?: boolean;
  body?: string;
} = {}): string {
  const scripts = options.scripts ?? false;
  const network = options.network ?? false;
  const remoteAssets = options.remoteAssets ?? false;
  return `---
name: ${options.name ?? "store-test"}
version: ${options.version ?? "1.0.0"}
description: Deterministic shared skill store fixture.
license: ${options.license ?? "MIT"}
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: ${options.riskLevel ?? "low"}
installTargets:
  - global
  - project
author: Test
deck:
  type: quality
  output: html-slide
  viewport: 1920x1080
  supports:
    - fixed-viewport
    - deck-check
  risk:
    scripts: ${String(scripts)}
    network: ${String(network)}
    remoteAssets: ${String(remoteAssets)}
    writesExports: false
    writesSecrets: false
    modifiesSource: true
---

# Store Test

${options.body ?? "Version one."}
`;
}

async function writeSkillDirectory(root: string, markdown: string): Promise<string> {
  const source = path.join(root, "source-skill");
  await mkdir(path.join(source, "references"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), markdown, "utf8");
  await writeFile(path.join(source, "references", "guide.md"), "# Guide\n", "utf8");
  return source;
}

function expectStoreError(error: unknown, code: SkillStoreError["code"]): void {
  expect(error).toBeInstanceOf(SkillStoreError);
  expect((error as SkillStoreError).code).toBe(code);
}

async function resolvePinnedLookup(lookup: LookupFunction, hostname: string): Promise<readonly LookupAddress[]> {
  return await new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Array.isArray(address) ? address : [{ address, family: family ?? 0 }]);
    });
  });
}

describe("shared skill install and store service", () => {
  it("pins the production HTTPS request lookup to the public preflight addresses", async () => {
    const markdown = skillMarkdown({ name: "pinned-test" });
    const resolveHost = vi.fn(async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real fetch in test."));
    const httpsRequest = vi.fn<SkillHttpsRequest>(async (url, init) => {
      expect(url.href).toBe("https://skills.example/remote/SKILL.md");
      expect(init.headers).toMatchObject({ Host: "skills.example" });
      expect(init.servername).toBe("skills.example");
      await expect(resolvePinnedLookup(init.lookup, "skills.example")).resolves.toEqual([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
      ]);
      await expect(resolvePinnedLookup(init.lookup, "rebind.example")).rejects.toMatchObject({ code: "ENOTFOUND" });
      return new Response(markdown, {
        status: 200,
        headers: { "content-type": "text/markdown" }
      }) as unknown as Awaited<ReturnType<SkillHttpsRequest>>;
    });

    const resolved = await resolveSkillSource("https://skills.example/remote/SKILL.md", {
      httpsRequest,
      resolveHost
    });

    expect(resolved.metadata.name).toBe("pinned-test");
    expect(resolveHost).toHaveBeenCalledOnce();
    expect(resolveHost).toHaveBeenCalledWith("skills.example");
    expect(httpsRequest).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it("repins production HTTPS request addresses after a redirect", async () => {
    const markdown = skillMarkdown({ name: "redirect-pinned-test" });
    const resolveHost = vi.fn(async (hostname: string) => hostname === "skills.example"
      ? ["93.184.216.34"]
      : ["142.250.191.142"]);
    const requests: Array<{ addresses: readonly LookupAddress[]; host: string; servername?: string }> = [];
    const httpsRequest = vi.fn<SkillHttpsRequest>(async (url, init) => {
      requests.push({
        addresses: await resolvePinnedLookup(init.lookup, url.hostname),
        host: init.headers.Host ?? "",
        servername: init.servername
      });
      if (url.hostname === "skills.example") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/releases/SKILL.md?token=redirect-secret" }
        }) as unknown as Awaited<ReturnType<SkillHttpsRequest>>;
      }
      return new Response(markdown, {
        status: 200,
        headers: { "content-type": "text/plain" }
      }) as unknown as Awaited<ReturnType<SkillHttpsRequest>>;
    });

    const resolved = await resolveSkillSource("https://skills.example/redirect.md", {
      httpsRequest,
      resolveHost
    });

    expect(resolved.reference).toBe("https://cdn.example/releases/SKILL.md");
    expect(resolveHost.mock.calls).toEqual([["skills.example"], ["cdn.example"]]);
    expect(requests).toEqual([
      {
        addresses: [{ address: "93.184.216.34", family: 4 }],
        host: "skills.example",
        servername: "skills.example"
      },
      {
        addresses: [{ address: "142.250.191.142", family: 4 }],
        host: "cdn.example",
        servername: "cdn.example"
      }
    ]);
  });

  it("rejects private preflight addresses before the production HTTPS request", async () => {
    const resolveHost = vi.fn(async () => ["127.0.0.1"]);
    const httpsRequest = vi.fn<SkillHttpsRequest>();

    await expect(resolveSkillSource("https://private.example/SKILL.md", {
      httpsRequest,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_URL_UNSAFE");
      return true;
    });
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it("resolves HTTPS Markdown with bounded mocked fetch and rejects unsafe responses", async () => {
    const markdown = skillMarkdown({ name: "remote-test" });
    const resolveHost = vi.fn(async (hostname: string) => {
      if (hostname === "private.example") {
        return ["127.0.0.1"];
      }
      if (hostname === "mapped-private.example") {
        return ["::ffff:7f00:1"];
      }
      return ["93.184.216.34"];
    });
    const fetchMock = vi.fn(async () => new Response(markdown, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" }
    }) as unknown as Awaited<ReturnType<SkillFetch>>);

    const resolved = await resolveSkillSource(
      { kind: "url", url: "https://skills.example/remote/SKILL.md?token=secret#fragment" },
      { fetch: fetchMock, resolveHost }
    );

    expect(resolved).toMatchObject({
      kind: "url",
      reference: "https://skills.example/remote/SKILL.md",
      metadata: { name: "remote-test", version: "1.0.0" }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://skills.example/remote/SKILL.md?token=secret#fragment",
      expect.objectContaining({ redirect: "manual" })
    );

    await expect(resolveSkillSource("http://skills.example/SKILL.md", { fetch: fetchMock, resolveHost })).rejects.toSatisfy(
      (error: unknown) => {
        expectStoreError(error, "SKILL_SOURCE_URL_INSECURE");
        return true;
      }
    );

    const oversizedFetch = vi.fn(async () => new Response("12345", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "5" }
    }) as unknown as Awaited<ReturnType<SkillFetch>>);
    await expect(resolveSkillSource("https://skills.example/large.md", {
      fetch: oversizedFetch,
      maxMarkdownBytes: 4,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_TOO_LARGE");
      return true;
    });

    const blockedFetch = vi.fn(async () => new Response(markdown, {
      status: 200,
      headers: { "content-type": "text/markdown" }
    }) as unknown as Awaited<ReturnType<SkillFetch>>);
    await expect(resolveSkillSource("https://private.example/SKILL.md", {
      fetch: blockedFetch,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_URL_UNSAFE");
      return true;
    });
    expect(blockedFetch).not.toHaveBeenCalled();

    await expect(resolveSkillSource("https://mapped-private.example/SKILL.md", {
      fetch: blockedFetch,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_URL_UNSAFE");
      return true;
    });
    await expect(resolveSkillSource("https://[::ffff:127.0.0.1]/SKILL.md", {
      fetch: blockedFetch,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_URL_UNSAFE");
      return true;
    });
    expect(blockedFetch).not.toHaveBeenCalled();

    const redirectFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://private.example/SKILL.md" }
    }) as unknown as Awaited<ReturnType<SkillFetch>>);
    await expect(resolveSkillSource("https://skills.example/redirect.md", {
      fetch: redirectFetch,
      resolveHost
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_SOURCE_URL_UNSAFE");
      return true;
    });
    expect(redirectFetch).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith("private.example");
  });

  it("requires explicit confirmation for warning-level risk and license findings", async () => {
    const root = await temporaryDirectory();
    const sourcePath = path.join(root, "warning-skill.md");
    await writeFile(sourcePath, skillMarkdown({
      name: "warning-skill",
      license: "GPL-3.0",
      riskLevel: "high",
      scripts: true,
      network: true
    }), "utf8");
    const target = { kind: "global" as const, homeDir: root };

    const plan = await prepareSkillInstall({ source: sourcePath, target });
    expect(plan.installable).toBe(true);
    expect(plan.confirmationRequired).toBe(true);
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      "contains-scripts",
      "uses-network",
      "high-risk",
      "license-review-required"
    ]);

    await expect(installSkill({ source: sourcePath, target })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_CONFIRMATION_REQUIRED");
      return true;
    });
    const installed = await installSkill({ source: sourcePath, target, confirmWarnings: true });
    expect(installed).toMatchObject({ action: "installed", skillName: "warning-skill" });
  });

  it("installs, lists, inspects, updates, leaves unchanged, and removes a managed directory skill", async () => {
    const root = await temporaryDirectory();
    const sourcePath = await writeSkillDirectory(root, skillMarkdown());
    const target = { kind: "global" as const, homeDir: root };
    const installDirectory = path.join(root, ".htmlslide", "skills", "store-test");

    const installed = await installSkill({ source: sourcePath, target });
    expect(installed).toMatchObject({
      action: "installed",
      skillName: "store-test",
      version: "1.0.0",
      locations: [{ location: "global", directoryPath: installDirectory, action: "installed" }]
    });
    expect(await readFile(path.join(installDirectory, "references", "guide.md"), "utf8")).toBe("# Guide\n");
    expect(JSON.parse(await readFile(path.join(installDirectory, MANAGED_SKILL_RECORD_FILENAME), "utf8"))).toMatchObject({
      schemaVersion: 1,
      manager: "htmlslide",
      name: "store-test",
      version: "1.0.0",
      sourceKind: "local-directory"
    });

    const unchanged = await installSkill({ source: sourcePath, target });
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.locations[0]?.action).toBe("unchanged");

    const listed = await listInstalledSkills({ target });
    expect(listed.invalid).toEqual([]);
    expect(listed.skills).toEqual([
      expect.objectContaining({
        name: "store-test",
        version: "1.0.0",
        managed: true,
        integrity: "verified",
        location: "global"
      })
    ]);
    const inspected = await inspectInstalledSkill({ target, name: "store-test" });
    expect(inspected).toHaveLength(1);
    expect(inspected[0]).toMatchObject({
      name: "store-test",
      managed: true,
      integrity: "verified",
      metadata: { version: "1.0.0" },
      record: { sourceKind: "local-directory" }
    });
    expect(inspected[0]?.markdown).toContain("Version one.");

    const supportPath = path.join(installDirectory, "references", "guide.md");
    await chmod(supportPath, 0o755);
    await expect(inspectInstalledSkill({ target, name: "store-test" })).resolves.toEqual([
      expect.objectContaining({ integrity: "modified" })
    ]);
    await chmod(supportPath, 0o644);

    await writeFile(path.join(sourcePath, "SKILL.md"), skillMarkdown({
      version: "1.1.0",
      body: "Version two."
    }), "utf8");
    const updated = await installSkill({ source: sourcePath, target });
    expect(updated).toMatchObject({ action: "updated", version: "1.1.0" });
    expect(await readFile(path.join(installDirectory, "SKILL.md"), "utf8")).toContain("Version two.");

    const removed = await removeSkill({ target, name: "store-test" });
    expect(removed).toEqual({
      action: "removed",
      skillName: "store-test",
      removed: [{ location: "global", directoryPath: installDirectory }],
      missing: []
    });
    await expect(readFile(path.join(installDirectory, "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const invalidDirectory = path.join(path.dirname(installDirectory), "Invalid Name");
    await mkdir(invalidDirectory);
    const afterRemoval = await listInstalledSkills({ target });
    expect(afterRemoval.skills).toEqual([]);
    expect(afterRemoval.invalid).toEqual([
      expect.objectContaining({ name: "Invalid Name", code: "SKILL_NAME_INVALID" })
    ]);
  });

  it("allows different skills to create the same target root concurrently", async () => {
    const root = await temporaryDirectory();
    const target = { kind: "global" as const, homeDir: root };

    const results = await Promise.all([
      installSkill({ source: { kind: "official", name: "deck-architect" }, target }),
      installSkill({ source: { kind: "official", name: "visual-direction" }, target })
    ]);

    expect(results.map((result) => result.skillName).sort()).toEqual(["deck-architect", "visual-direction"]);
    const listed = await listInstalledSkills({ target });
    expect(listed.skills.map((skill) => skill.name)).toEqual(["deck-architect", "visual-direction"]);
    expect(listed.skills.every((skill) => skill.integrity === "verified")).toBe(true);
  });

  it("refuses unmanaged deletion and never follows a named skill symlink", async () => {
    const root = await temporaryDirectory();
    const target = { kind: "global" as const, homeDir: root };
    const skillRoot = path.join(root, ".htmlslide", "skills");
    const unmanagedPath = path.join(skillRoot, "unmanaged-skill");
    await mkdir(unmanagedPath, { recursive: true });
    await writeFile(path.join(unmanagedPath, "SKILL.md"), skillMarkdown({ name: "unmanaged-skill" }), "utf8");

    await expect(removeSkill({ target, name: "unmanaged-skill" })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_TARGET_UNMANAGED");
      return true;
    });
    expect(await readFile(path.join(unmanagedPath, "SKILL.md"), "utf8")).toContain("unmanaged-skill");

    const outside = path.join(root, "outside-skill");
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), skillMarkdown({ name: "linked-skill" }), "utf8");
    await symlink(outside, path.join(skillRoot, "linked-skill"));

    await expect(removeSkill({ target, name: "linked-skill" })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_TARGET_UNSAFE");
      return true;
    });
    expect(await readFile(path.join(outside, "SKILL.md"), "utf8")).toContain("linked-skill");
  });

  it("safely adopts exact and stale single-file legacy official installs only", async () => {
    const root = await temporaryDirectory();
    const target = { kind: "global" as const, homeDir: root };
    const skillsRoot = path.join(root, ".htmlslide", "skills");
    const exactOfficial = getOfficialSkill("deck-architect");
    const staleOfficial = getOfficialSkill("visual-direction");
    if (!exactOfficial || !staleOfficial) {
      throw new Error("Expected official skill fixtures are missing.");
    }

    const exactPath = path.join(skillsRoot, "deck-architect");
    await mkdir(exactPath, { recursive: true });
    await writeFile(path.join(exactPath, "SKILL.md"), exactOfficial.markdown, "utf8");
    await expect(installSkill({
      source: { kind: "official", name: "deck-architect" },
      target
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_TARGET_UNMANAGED");
      return true;
    });

    const adopted = await installSkill({
      source: { kind: "official", name: "deck-architect" },
      target,
      adoptLegacyOfficial: true
    });
    expect(adopted).toMatchObject({
      action: "adopted",
      locations: [{ location: "global", action: "adopted" }]
    });
    expect(JSON.parse(await readFile(path.join(exactPath, MANAGED_SKILL_RECORD_FILENAME), "utf8"))).toMatchObject({
      name: "deck-architect",
      sourceKind: "official"
    });

    const stalePath = path.join(skillsRoot, "visual-direction");
    await mkdir(stalePath, { recursive: true });
    await writeFile(path.join(stalePath, "SKILL.md"), "# stale legacy official\n", "utf8");
    const updated = await installSkill({
      source: { kind: "official", name: "visual-direction" },
      target,
      adoptLegacyOfficial: true
    });
    expect(updated).toMatchObject({
      action: "updated",
      locations: [{ location: "global", action: "updated" }]
    });
    expect(await readFile(path.join(stalePath, "SKILL.md"), "utf8")).toBe(staleOfficial.markdown);

    const unsafePath = path.join(skillsRoot, "brand-kit");
    await mkdir(unsafePath, { recursive: true });
    await writeFile(path.join(unsafePath, "SKILL.md"), getOfficialSkill("brand-kit")?.markdown ?? "", "utf8");
    await writeFile(path.join(unsafePath, "user-note.md"), "do not delete\n", "utf8");
    await expect(installSkill({
      source: { kind: "official", name: "brand-kit" },
      target,
      adoptLegacyOfficial: true
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_LEGACY_ADOPTION_UNSAFE");
      return true;
    });
    expect(await readFile(path.join(unsafePath, "user-note.md"), "utf8")).toBe("do not delete\n");

    const localSource = path.join(root, "third-party.md");
    await writeFile(localSource, skillMarkdown({ name: "third-party" }), "utf8");
    await expect(installSkill({
      source: localSource,
      target,
      adoptLegacyOfficial: true
    })).rejects.toSatisfy((error: unknown) => {
      expectStoreError(error, "SKILL_LEGACY_ADOPTION_NOT_ALLOWED");
      return true;
    });
  });
});
