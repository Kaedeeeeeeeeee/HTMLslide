import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, startDevServer, type DevServer } from "../src/index";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cliBin = path.join(repoRoot, "packages", "cli", "src", "bin", "htmlslide.ts");
const temporaryRoots: string[] = [];
const runningServers: DevServer[] = [];

type RawResponse = {
  statusCode: number;
  body: string;
};

const requestRaw = (port: number, requestPath: string, method = "GET"): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        method,
        path: requestPath,
        port
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body: chunks.join("") });
        });
      }
    );
    request.setTimeout(5_000, () => request.destroy(new Error("Timed out waiting for dev server response.")));
    request.on("error", reject);
    request.end();
  });

const createTestProject = async (): Promise<{ projectPath: string; slidePath: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "htmlslide-cli-dev-"));
  temporaryRoots.push(root);
  const project = await createProject(path.join(root, "demo"), "demo");
  const slidePath = project.manifest.slides[0]?.source;
  if (!slidePath) {
    throw new Error("The default deck fixture must contain a slide source.");
  }
  return { projectPath: project.projectPath, slidePath };
};

const snapshotProject = async (projectPath: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath = path.join(projectPath, relativePath);
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const nextRelativePath = path.posix.join(relativePath, entry.name);
      const nextAbsolutePath = path.join(projectPath, nextRelativePath);
      if (entry.isDirectory()) {
        snapshot[`dir:${nextRelativePath}`] = "";
        await visit(nextRelativePath);
        continue;
      }
      snapshot[`file:${nextRelativePath}`] = (await readFile(nextAbsolutePath)).toString("base64");
    }
  };
  await visit("");
  return snapshot;
};

const waitForJsonOutput = (child: ReturnType<typeof spawn>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for CLI startup metadata. Output: ${output}`));
    }, 10_000);
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      try {
        const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
        cleanup();
        resolve(parsed);
      } catch {
        // JSON output is intentionally pretty-printed and arrives over multiple chunks.
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`CLI exited before startup metadata was complete: ${String(code)}. Output: ${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onExit);
  });

const waitForClose = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("htmlslide dev", { timeout: 20_000 }, () => {
  it("binds to loopback and supports an ephemeral port", async () => {
    const project = await createTestProject();
    const server = await startDevServer({ projectPath: project.projectPath, port: 0 });
    runningServers.push(server);

    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    await expect(requestRaw(server.port, "/")).resolves.toMatchObject({ statusCode: 200 });
  });

  it("serves a small index and the compiler's canonical slide document", async () => {
    const project = await createTestProject();
    const server = await startDevServer({ projectPath: project.projectPath, port: 0 });
    runningServers.push(server);

    const index = await requestRaw(server.port, "/");
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("<h1>Demo</h1>");
    expect(index.body).toContain(`href="/${project.slidePath}"`);
    expect(index.body).not.toContain(project.projectPath);

    const slide = await requestRaw(server.port, `/${project.slidePath}`);
    expect(slide.statusCode).toBe(200);
    expect(slide.body).toContain('data-htmlslide-preview="canonical"');
    expect(slide.body).toContain('data-slide-id="001-title"');
  });

  it("rejects unknown, traversal, and direct project-file routes", async () => {
    const project = await createTestProject();
    const server = await startDevServer({ projectPath: project.projectPath, port: 0 });
    runningServers.push(server);

    await expect(requestRaw(server.port, "/unknown-slide")).resolves.toMatchObject({ statusCode: 404 });
    await expect(requestRaw(server.port, "/%2e%2e/deck.json")).resolves.toMatchObject({ statusCode: 404 });
    await expect(requestRaw(server.port, "/deck.json")).resolves.toMatchObject({ statusCode: 404 });
    await expect(requestRaw(server.port, "/%5Cetc%5Cpasswd")).resolves.toMatchObject({ statusCode: 404 });
  });

  it("does not write the project while starting or serving previews", async () => {
    const project = await createTestProject();
    const before = await snapshotProject(project.projectPath);
    const server = await startDevServer({ projectPath: project.projectPath, port: 0 });
    runningServers.push(server);

    await requestRaw(server.port, "/");
    await requestRaw(server.port, `/${project.slidePath}`);
    await server.close();

    expect(await snapshotProject(project.projectPath)).toEqual(before);
  });

  it("prints relative JSON startup metadata without keeping the test process alive", async () => {
    const project = await createTestProject();
    const child = spawn(tsxBin, [cliBin, "dev", project.projectPath, "--port", "0", "--json"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      const startup = await waitForJsonOutput(child);
      expect(startup).toMatchObject({
        command: "dev",
        host: "127.0.0.1",
        status: "passed"
      });
      expect(startup.port).toEqual(expect.any(Number));
      expect(JSON.stringify(startup)).not.toContain(project.projectPath);
    } finally {
      child.kill("SIGTERM");
      await waitForClose(child);
    }
  });
});
