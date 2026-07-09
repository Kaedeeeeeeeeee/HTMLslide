# Connect Gemini CLI

Gemini CLI integration is planned as an external agent path.

## Current alpha behavior

HTMLslide can run detection for Gemini CLI command availability through configured command checks. Full Gemini CLI headless deck editing is not yet a release claim.

Gemini CLI authentication can use interactive Google sign-in, `GEMINI_API_KEY`, or Vertex AI environment configuration. HTMLslide does not treat a successful `gemini --version` check as proof that Gemini can edit a deck.

For alpha testing, use Generic external agent mode with a command template that writes a reviewed source-write manifest, or use Local Mock/BYOK.

## Manual validation

Before claiming Gemini CLI support for a release, complete manual validation:

1. Detect Gemini CLI.
2. Confirm the user's selected authentication mode without exposing credentials.
3. Install project HTMLslide skills or equivalent project guidance.
4. Run a read-only test.
5. Run a source-editing deck task through an explicit project-scoped command template.
6. Verify Check, Export, and diff review.

CI must use fake commands rather than a real Gemini login or provider account.
