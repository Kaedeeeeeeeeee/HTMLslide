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
htmlslide agent validate-provider --provider openai --model <openai-model-id> --api-key-env OPENAI_API_KEY --json
```

For Anthropic:

```bash
export ANTHROPIC_API_KEY="..."
htmlslide agent validate-provider --provider anthropic --model <anthropic-model-id> --api-key-env ANTHROPIC_API_KEY --json
```

For OpenAI-compatible providers:

```bash
export COMPATIBLE_API_KEY="..."
htmlslide agent validate-provider --provider compatible --model <compatible-model-id> --api-key-env COMPATIBLE_API_KEY --base-url https://provider.example.com/v1 --json
```

The command accepts an environment variable name, not a raw API key value. Save the sanitized JSON output as release-candidate evidence if the validation passes or fails. Do not paste API keys into terminal history, issue reports, screenshots, project files, or `.htmlslide/reports/`.

## Provider Flow

1. Open AI Engines.
2. Choose HTMLslide Agent.
3. Select provider and model.
4. Save the API key.
5. Optionally run `htmlslide agent validate-provider` from a shell that has the provider key in the named environment variable.
6. Create or open a deck.
7. Generate.
8. Review diff, Check, Export, and Presenter output.

Automated tests use fake fetch implementations and mock providers. Real provider validation is a manual release step.
