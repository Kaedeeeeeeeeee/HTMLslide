import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createByokEvidenceFixture } from "./byok-evidence-fixture.mjs";
import { main as verifyByokEvidence } from "./verify-byok-acceptance.mjs";

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function main(args = []) {
  const options = parseArgs(args);
  const fixture = await createByokEvidenceFixture();
  const internalOutputPath = path.join(fixture.projectPath, ".htmlslide", "reports", "byok-fixture-only-evidence.json");

  try {
    await verifyByokEvidence([
      "--project", fixture.projectPath,
      "--provider-validation", fixture.validationPath,
      "--run-id", "run-fixture-provider",
      "--report", fixture.reportPath,
      "--output", internalOutputPath,
      "--commit", options.commit ?? "fixture-only",
      "--artifact-url", options.artifactUrl ?? "https://github.test/fixture-only",
      ...(options.artifactSha256 ? ["--artifact-sha256", options.artifactSha256] : [])
    ]);

    const evidence = JSON.parse(await readFile(internalOutputPath, "utf8"));
    const fixtureEvidence = {
      ...evidence,
      fixtureOnly: true,
      providerBoundary: "fixture-only",
      verificationNote: "Deterministic contract smoke; this is not real provider acceptance evidence."
    };
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(fixtureEvidence, null, 2)}\n`, "utf8");
    const result = { status: "passed", fixtureOnly: true, outputPath: options.outputPath };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  const outputIndex = normalizedArgs.indexOf("--output");
  const outputPath = outputIndex === -1
    ? path.join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp", "htmlslide-byok-fixture-evidence.json")
    : normalizedArgs[outputIndex + 1];
  if (typeof outputPath !== "string" || outputPath.startsWith("--")) {
    throw new Error("Missing required --output path.");
  }
  const artifactShaIndex = normalizedArgs.indexOf("--artifact-sha256");
  const artifactSha256 = artifactShaIndex === -1 ? undefined : normalizedArgs[artifactShaIndex + 1];
  if (artifactShaIndex !== -1 && (typeof artifactSha256 !== "string" || artifactSha256.startsWith("--"))) {
    throw new Error("Missing required --artifact-sha256 value.");
  }
  const artifactUrlIndex = normalizedArgs.indexOf("--artifact-url");
  const artifactUrl = artifactUrlIndex === -1 ? undefined : normalizedArgs[artifactUrlIndex + 1];
  if (artifactUrlIndex !== -1 && (typeof artifactUrl !== "string" || artifactUrl.startsWith("--"))) {
    throw new Error("Missing required --artifact-url value.");
  }
  const commitIndex = normalizedArgs.indexOf("--commit");
  const commit = commitIndex === -1 ? undefined : normalizedArgs[commitIndex + 1];
  if (commitIndex !== -1 && (typeof commit !== "string" || commit.startsWith("--"))) {
    throw new Error("Missing required --commit value.");
  }
  const optionIndexes = new Set([outputIndex, artifactShaIndex, artifactUrlIndex, commitIndex]);
  if (normalizedArgs.some((arg, index) => arg.startsWith("--") && !optionIndexes.has(index))) {
    throw new Error("Unknown option. Supported options are --output, --commit, --artifact-url, and --artifact-sha256.");
  }
  return {
    artifactSha256,
    artifactUrl,
    commit,
    outputPath: path.resolve(outputPath)
  };
}
