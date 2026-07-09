# BYOK

BYOK means "bring your own key." HTMLslide uses your provider account; HTMLslide does not sell a model subscription.

## Cost Boundary

You pay your provider directly. Model usage, quota, billing, and rate limits are owned by your OpenAI, Anthropic, or compatible provider account.

## API key storage

The desktop app stores API key material through the platform credential store when available, such as Keychain on macOS. The project files and `.htmlslide/reports/` output must not contain the API key.

## Provider Flow

1. Open AI Engines.
2. Choose HTMLslide Agent.
3. Select provider and model.
4. Save the API key.
5. Create or open a deck.
6. Generate.
7. Review diff, Check, Export, and Presenter output.

Automated tests use fake fetch implementations and mock providers. Real provider validation is a manual release step.
