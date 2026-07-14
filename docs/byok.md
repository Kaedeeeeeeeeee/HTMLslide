# BYOK

BYOK means "bring your own key." HTMLslide uses your provider account; HTMLslide does not sell a model subscription.

## Cost Boundary

You pay your provider directly. Model usage, quota, billing, and rate limits are owned by your OpenAI, Anthropic, or compatible provider account.

## API key storage

The desktop app stores API key material through the platform credential store when available, such as Keychain on macOS. The project files and `.htmlslide/reports/` output must not contain the API key.

## Provider validation

Before a real BYOK alpha run, validate that the provider key can reach the selected model:

```bash
export OPENAI_API_KEY="..."
umask 077
htmlslide agent validate-provider --provider openai --model <openai-model-id> --api-key-env OPENAI_API_KEY --json > /path/to/provider-validation.json
```

For Anthropic:

```bash
export ANTHROPIC_API_KEY="..."
htmlslide agent validate-provider --provider anthropic --model <anthropic-model-id> --api-key-env ANTHROPIC_API_KEY --json > /path/to/provider-validation.json
```

For OpenAI-compatible providers:

```bash
export COMPATIBLE_API_KEY="..."
htmlslide agent validate-provider --provider compatible --model <compatible-model-id> --api-key-env COMPATIBLE_API_KEY --base-url https://provider.example.com/v1 --json > /path/to/provider-validation.json
```

The command accepts an environment variable name, not a raw API key value. Save its sanitized JSON output to a local file. Do not paste API keys into terminal history, issue reports, screenshots, project files, or `.htmlslide/reports/`.

## Shared RC BYOK Acceptance Path

The shared CLI acceptance path is `htmlslide rc byok`:

```bash
htmlslide rc byok --project <deck-path> --provider openai|anthropic|compatible --model <model-id> --api-key-env <ENV_NAME> --task <brief> --target-slide-count <8-12> --json
```

The optional flags are `--base-url <url>` for a compatible provider, `--commit <commit>`, `--artifact-url <url>`, and `--artifact-sha256 <sha256>` for candidate binding, and `--speaker-notes <mode>` for the requested notes mode. The provider value must be one of `openai`, `anthropic`, or `compatible`, and the target slide count must be an integer from 8 through 12.

The command is part of the current candidate CLI. Manual evidence must still use the exact packaged candidate under test.

The planned run order is fixed:

1. Validate the provider and selected model first.
2. Run a real provider-backed deck generation for the requested task.
3. Run the authoritative Check.
4. Export PDF, deckpkg, and thumbnails.
5. Write sanitized, run-bound evidence under `.htmlslide/reports/rc-evidence-<run-id>/`.

The API key remains outside the project: the CLI receives an environment variable name, and the desktop credential path remains environment/Keychain-backed. Keys and raw provider responses are never written to the evidence directory. The JSON result and evidence may contain sanitized provider/model metadata, run identifiers, artifact fingerprints, and caller-declared candidate labels, but not key values.

Desktop BYOK run reports also include optional numeric token usage from the provider response (`inputTokens`, `outputTokens`, and `totalTokens`). The run console displays the same counts when available. These values provide usage transparency only; they are not a local billing or cost estimate.

This command is required evidence for the manual real-provider Alpha/RC row. It is not a fake-provider test, and a successful run does not by itself prove Claude Code or Codex compatibility, physical dual-screen presenter support, visual quality, or release signing/notarization.

## Provider Flow

1. Open AI Engines.
2. Choose HTMLslide Agent.
3. Select provider and model.
4. Save the API key.
5. Optionally run `htmlslide agent validate-provider` from a shell that has the provider key in the named environment variable.
6. Create or open a deck.
7. Generate.
8. Review diff, Check, Export, and Presenter output.

Each agent run has a hard ten-minute deadline by default. A provider that ignores cancellation is reported as a failed `timeout` run rather than being allowed to continue into later stages. A run is successful only when the authoritative Check is passed with zero errors, Export returns at least one artifact, and the review stage completes; Check or Export failures are never reported as successful BYOK runs.

For release-candidate evidence, request an explicit 8-12 slide count in New Deck, complete the desktop run, then bind the provider validation to the exact run and exports:

```bash
pnpm rc:byok-evidence -- \
  --project /path/to/generated-deck \
  --provider-validation /path/to/provider-validation.json \
  --run-id <desktop-run-id> \
  --commit <candidate-commit> \
  --artifact-url <candidate-artifact-url>
```

The verifier reads only sanitized run/project artifacts. It does not read Keychain, environment values, or raw API keys. A successful evidence file proves that the named run requested and produced an 8-12 slide deck with matching outline/manifest IDs, current export source/artifact fingerprints, an existing reversible checkpoint, passing authoritative check/export, and no common secret patterns in exported text sources. Compatible providers are bound by a sanitized endpoint hash. It does not prove visual quality, provider billing behavior, or the identity of an arbitrary-format provider key.

`--commit` and `--artifact-url` are recorded as candidate labels. `--artifact-sha256` records the candidate DMG fingerprint. The completed RC checklist and promotion verifier bind all supplied values to the exact packaged artifact actually tested; the verifier does not download the app artifact itself, while the signed-release promotion workflow downloads and verifies the candidate bundle before publication. Promotion rejects missing or mismatched DMG SHA-256 evidence.

Automated tests use fake fetch implementations and mock providers. They can validate the `rc byok` command contract and its sanitization, but they do not satisfy the real-provider Alpha/RC gate. A real provider run against the exact candidate remains a manual release step.
