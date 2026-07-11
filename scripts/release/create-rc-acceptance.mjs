import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (isDirectRun()) {
  await main(process.argv.slice(2));
}

export async function main(args) {
  const options = parseArgs(args);
  const version = options.version ?? packageJson.version ?? "0.0.0";
  const channel = options.channel ?? "alpha";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outputPath = path.resolve(
    root,
    options.output ?? path.join("dist", "acceptance", `htmlslide-${version}-${channel}-rc-acceptance-${stamp}.md`)
  );

  if (channel !== "alpha" && channel !== "release") {
    throw new Error(`Unsupported channel: ${channel}. Expected alpha or release.`);
  }

  const checklist = renderChecklist({
    artifactUrl: options.artifactUrl,
    channel,
    ciRunUrl: options.ciRunUrl,
    packageRunUrl: options.packageRunUrl,
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
| DMG / artifact URL | ${metadata.artifactUrl ?? "TODO"} |
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
- [ ] pnpm perf:smoke
- [ ] pnpm security:check
- [ ] pnpm build
- [ ] pnpm e2e:desktop
- [ ] pnpm e2e:desktop:a11y
- [ ] Package workflow completed for this commit/tag.
- [ ] Package smoke completed against the exact artifact under test.${automatedReleaseGate}

## Manual Acceptance Script

For every item, record Pass, Fail, or N/A with an evidence link or note. N/A is only acceptable for BYOK when no test key is available, or for real Claude/Codex compatibility when the candidate makes no validated real-account claim; record that explicitly. Gemini headless editing is not supported and must remain detection-only.

### 1. Clean macOS User Account

- [ ] Start from a clean macOS user account or equivalent isolated profile.
- Evidence:
- Notes:

### 2. Install DMG

- [ ] Install the exact DMG listed in Metadata.
- [ ] Confirm expected unsigned alpha Gatekeeper behavior or signed/notarized release behavior for the channel.
- Evidence:
- Notes:

### 3. First Launch Setup

- [ ] Launch HTMLslide.
- [ ] Complete first-run setup.
- [ ] Confirm official skills and CLI integration setup finish without unexpected prompts.
- Evidence:
- Notes:

### 4. Create Deck With Mock Or Local Provider

- [ ] Create a new deck with the mock/local provider.
- [ ] Confirm the project opens in the workspace with slide previews and notes.
- Evidence:
- Notes:

### 5. Create Deck With BYOK Provider If Key Available

- [ ] Run \`htmlslide agent validate-provider --provider <provider> --model <model> --api-key-env <ENV_NAME> --json\` from an environment where the key is set.
- [ ] Attach or paste the sanitized provider validation JSON and confirm it does not include the API key value.
- [ ] Save a test provider key through Settings.
- [ ] Create a deck with the BYOK provider.
- [ ] Confirm no API key appears in project files, reports, logs, or screenshots.
- [ ] If no key is available, mark N/A and record why.
- Evidence:
- Notes:

### 6. Connect Fake External Agents

- [ ] Run a fake built-in Claude or Codex executable through the fixed adapter path.
- [ ] Configure and run a fake Generic external agent command.
- [ ] Confirm isolated built-in source application, Generic source-write manifest validation, sanitized logs, check/export gate, and checkpoint diff.
- Evidence:
- Notes:

### 7. Validate Real Claude/Codex Compatibility And Gemini Boundary

- [ ] Review docs and release notes for any validated real-account Claude Code or Codex compatibility claim.
- [ ] If compatibility is claimed, record the real tool, version, authentication evidence, sanitized task/command, completed edit, cancellation behavior, checkpoint diff, check/export result, and revert evidence against this exact packaged artifact.
- [ ] If compatibility is not claimed, mark N/A and confirm docs/release notes describe only the built-in adapter contract and fake automation.
- [ ] Confirm Gemini CLI remains detection-only and no headless deck-editing claim is present.
- Evidence:
- Notes:

### 8. Export PDF And Deckpkg

- [ ] Export PDF and deckpkg from the created deck.
- [ ] Confirm PDF page count, deckpkg openability, notes, and thumbnails.
- Evidence:
- Notes:

### 9. Present On External Monitor

- [ ] Present on HDMI, USB-C, or AirPlay external display.
- [ ] Confirm speaker screen, audience window, next/previous navigation, overlays, timer, and screen sync.
- Evidence:
- Notes:

### 10. Reopen Project

- [ ] Quit and relaunch HTMLslide.
- [ ] Reopen the project from Recent or Open Folder.
- [ ] Confirm project library status and workspace preview are correct.
- Evidence:
- Notes:

### 11. Revert An Agent Run

- [ ] Revert the latest mock, BYOK, or fake external-agent run.
- [ ] Confirm changed source files return to the checkpoint state.
- Evidence:
- Notes:

### 12. Uninstall CLI

- [ ] Uninstall the HTMLslide-managed CLI shim from Settings.
- [ ] Confirm htmlslide doctor no longer resolves through the removed shim path.
- Evidence:
- Notes:

### 13. Delete App And Check System Files

- [ ] Delete the app.
- [ ] Confirm no unexpected files remain outside the expected user data, chosen workspace, and intentionally installed artifacts.
- Evidence:
- Notes:

## Result

- [ ] Accepted for release candidate publication.
- [ ] Rejected; blocking issues are filed and linked below.

Blocking issues:

- TODO
`;
}

function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
