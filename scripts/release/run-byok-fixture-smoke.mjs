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
  const outputPath = parseOutputPath(args);
  const fixture = await createByokEvidenceFixture();
  const internalOutputPath = path.join(fixture.projectPath, ".htmlslide", "reports", "byok-fixture-only-evidence.json");

  try {
    await verifyByokEvidence([
      "--project", fixture.projectPath,
      "--provider-validation", fixture.validationPath,
      "--run-id", "run-fixture-provider",
      "--report", fixture.reportPath,
      "--output", internalOutputPath,
      "--commit", "fixture-only",
      "--artifact-url", "https://github.test/fixture-only"
    ]);

    const evidence = JSON.parse(await readFile(internalOutputPath, "utf8"));
    const fixtureEvidence = {
      ...evidence,
      fixtureOnly: true,
      providerBoundary: "fixture-only",
      verificationNote: "Deterministic contract smoke; this is not real provider acceptance evidence."
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(fixtureEvidence, null, 2)}\n`, "utf8");
    const result = { status: "passed", fixtureOnly: true, outputPath };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function parseOutputPath(args) {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  if (normalizedArgs.length === 0) {
    return path.join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp", "htmlslide-byok-fixture-evidence.json");
  }
  const outputIndex = normalizedArgs.indexOf("--output");
  if (outputIndex === -1 || typeof normalizedArgs[outputIndex + 1] !== "string" || normalizedArgs[outputIndex + 1].startsWith("--")) {
    throw new Error("Missing required --output path.");
  }
  if (normalizedArgs.some((arg, index) => index !== outputIndex && arg.startsWith("--") && arg !== "--output")) {
    throw new Error("Unknown option. Only --output is supported.");
  }
  return path.resolve(normalizedArgs[outputIndex + 1]);
}
