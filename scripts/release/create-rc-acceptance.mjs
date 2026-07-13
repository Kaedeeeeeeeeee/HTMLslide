import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPackageManifestProvenance, validateCommit } from "./rc-provenance.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (isDirectRun()) {
  await main(process.argv.slice(2));
}

export async function main(args) {
  const options = parseArgs(args);
  if (Boolean(options.packageManifest) !== Boolean(options.commit)) {
    throw new Error("--package-manifest and --commit must be provided together for RC provenance binding.");
  }

  const packageProvenance = options.packageManifest
    ? await readPackageManifestProvenance(options.packageManifest, { requireSourceCommit: true })
    : undefined;
  const version = options.version ?? packageProvenance?.version ?? packageJson.version ?? "0.0.0";
  const channel = options.channel ?? "alpha";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outputPath = path.resolve(
    root,
    options.output ?? path.join("dist", "acceptance", `htmlslide-${version}-${channel}-rc-acceptance-${stamp}.md`)
  );

  if (channel !== "alpha" && channel !== "release") {
    throw new Error(`Unsupported channel: ${channel}. Expected alpha or release.`);
  }
  if (packageProvenance && packageProvenance.channel !== channel) {
    throw new Error(`RC checklist channel ${channel} does not match package manifest channel ${packageProvenance.channel}.`);
  }
  if (packageProvenance && packageProvenance.version !== version) {
    throw new Error(`RC checklist version ${version} does not match package manifest version ${packageProvenance.version}.`);
  }

  const commit = options.commit ? validateCommit(options.commit, "Candidate commit") : undefined;
  if (packageProvenance && packageProvenance.sourceCommit !== commit) {
    throw new Error("Candidate commit does not match package manifest sourceCommit.");
  }

  const checklist = renderChecklist({
    artifactUrl: options.artifactUrl,
    channel,
    ciRunUrl: options.ciRunUrl,
    commit,
    packageManifestSha256: packageProvenance?.manifestSha256,
    primaryArtifactSha256: packageProvenance?.primaryArtifactSha256,
    packageRunUrl: options.packageRunUrl,
    candidateRunId: options.candidateRunId,
    releaseTag: options.releaseTag,
    version
  });

  if (options.stdout) {
    process.stdout.write(checklist);
  } else {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, checklist, "utf8");
    process.stdout.write(`Release candidate acceptance checklist written to ${outputPath}\n`);
  }
}

export function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--stdout") {
      parsed.stdout = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = toCamelCase(rawKey);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

export function renderChecklist(metadata) {
  const automatedReleaseGate = metadata.channel === "release"
    ? "\n- [ ] Release macOS completed with signed, notarized, stapled manifest."
    : "";

  return `# HTMLslide Release Candidate Acceptance

## Metadata

| Field | Value |
| --- | --- |
| Version | ${metadata.version} |
| Channel | ${metadata.channel} |
| Release tag | ${metadata.releaseTag ?? "TODO"} |
| CI run | ${metadata.ciRunUrl ?? "TODO"} |
| Package workflow run | ${metadata.packageRunUrl ?? "TODO"} |
| Candidate run ID | ${metadata.candidateRunId ?? "TODO"} |
| DMG / artifact URL | ${metadata.artifactUrl ?? "TODO"} |
| Commit | ${metadata.commit ?? "TODO"} |
| Package manifest SHA256 | ${metadata.packageManifestSha256 ?? "TODO"} |
| Primary DMG SHA256 | ${metadata.primaryArtifactSha256 ?? "TODO"} |
| Tester | TODO |
| Clean macOS account / machine | TODO |
| Date | TODO |

## Automated Gates

- [ ] pnpm docs:check
- [ ] pnpm docs:build
- [ ] pnpm version:check
- [ ] pnpm lint
- [ ] pnpm typecheck
- [ ] pnpm test
- [ ] pnpm test:coverage
- [ ] pnpm test:visual:browser
- [ ] pnpm perf:smoke
- [ ] pnpm security:check
- [ ] pnpm build
- [ ] pnpm e2e:desktop
- [ ] pnpm e2e:desktop:a11y
- [ ] Package workflow completed for this commit/tag.
- [ ] Package smoke completed against the exact artifact under test.${automatedReleaseGate}

## Manual Acceptance Script

For every item, record Pass, Fail, or N/A with an evidence link or note. A public alpha or release promotion requires Accepted as the final result and Pass for every manual item. N/A can document an incomplete, non-promotable attempt only; it cannot be used to bypass the real-provider or real-Claude/Codex requirements. Gemini headless editing is not supported and must remain detection-only.

### 1. Clean macOS User Account

- [ ] Start from a clean macOS user account or equivalent isolated profile.
- Status: TODO
- Evidence:
- Notes:

### 2. Install DMG

- [ ] Install the exact DMG listed in Metadata.
- [ ] Confirm expected unsigned alpha Gatekeeper behavior or signed/notarized release behavior for the channel.
- Status: TODO
- Evidence:
- Notes:

### 3. First Launch Setup

- [ ] Launch HTMLslide.
- [ ] Complete first-run setup.
- [ ] Confirm official skills and CLI integration setup finish without unexpected prompts.
- Status: TODO
- Evidence:
- Notes:

### 4. Create Deck With Mock Or Local Provider

- [ ] Create a new deck with the mock/local provider.
- [ ] Confirm the project opens in the workspace with slide previews and notes.
- Status: TODO
- Evidence:
- Notes:

### 5. Create Deck With BYOK Provider If Key Available

- [ ] Run \`htmlslide agent validate-provider --provider <provider> --model <model> --api-key-env <ENV_NAME> --json\` from an environment where the key is set.
- [ ] Attach or paste the sanitized provider validation JSON and confirm it does not include the API key value.
- [ ] Save a test provider key through Settings.
- [ ] Create a deck with the BYOK provider.
- [ ] Request an explicit 8-12 slide count and confirm the generated manifest matches the accepted outline.
- [ ] Run \`pnpm rc:byok-evidence -- --project <deck> --provider-validation <validation.json> --run-id <run-id> --commit <commit> --artifact-url <artifact-url>\`.
- [ ] Attach the passing sanitized evidence JSON for this exact run and candidate artifact.
- [ ] Confirm no API key appears in project files, reports, logs, or screenshots.
- [ ] A real provider run is required for an accepted alpha or release candidate; missing credentials are a release blocker, not a promotion exception.
- Status: TODO
- Evidence:
- Notes:

### 6. Connect Fake External Agents

- [ ] Run a fake built-in Claude or Codex executable through the fixed adapter path.
- [ ] Configure and run a fake Generic external agent command.
- [ ] Confirm isolated built-in source application, Generic source-write manifest validation, sanitized logs, check/export gate, and checkpoint diff.
- Status: TODO
- Evidence:
- Notes:

### 7. Validate Real Claude/Codex Compatibility And Gemini Boundary

- [ ] Review docs and release notes for any validated real-account Claude Code or Codex compatibility claim.
- [ ] If compatibility is claimed, record the real tool, version, authentication evidence, sanitized task/command, completed edit, cancellation behavior, checkpoint diff, check/export result, and revert evidence against this exact packaged artifact.
- [ ] A real Claude or Codex compatibility run is required for an accepted alpha or release candidate; a no-claim result is a release blocker. Confirm Gemini remains detection-only.
- [ ] Confirm Gemini CLI remains detection-only and no headless deck-editing claim is present.
- Status: TODO
- Evidence:
- Notes:

### 8. Export PDF And Deckpkg

- [ ] Export PDF and deckpkg from the created deck.
- [ ] Confirm PDF page count, deckpkg openability, notes, and thumbnails.
- Status: TODO
- Evidence:
- Notes:

### 9. Present On External Monitor

- [ ] Present on HDMI, USB-C, or AirPlay external display.
- [ ] Confirm speaker screen, audience window, next/previous navigation, overlays, timer, and screen sync.
- Status: TODO
- Evidence:
- Notes:

### 10. Reopen Project

- [ ] Quit and relaunch HTMLslide.
- [ ] Reopen the project from Recent or Open Folder.
- [ ] Confirm project library status and workspace preview are correct.
- Status: TODO
- Evidence:
- Notes:

### 11. Revert An Agent Run

- [ ] Revert the latest mock, BYOK, or fake external-agent run.
- [ ] Confirm changed source files return to the checkpoint state.
- Status: TODO
- Evidence:
- Notes:

### 12. Uninstall CLI

- [ ] Uninstall the HTMLslide-managed CLI shim from Settings.
- [ ] Confirm htmlslide doctor no longer resolves through the removed shim path.
- Status: TODO
- Evidence:
- Notes:

### 13. Delete App And Check System Files

- [ ] Delete the app.
- [ ] Confirm no unexpected files remain outside the expected user data, chosen workspace, and intentionally installed artifacts.
- Status: TODO
- Evidence:
- Notes:

## Result

- Status: TODO
- [ ] Accepted for release candidate publication.
- [ ] Rejected; blocking issues are filed and linked below.

Blocking issues:

- TODO
`;
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
