# Connect Codex

Codex integration is planned as an external agent path.

## Current alpha behavior

HTMLslide can run detection for Codex command availability/status through configured command checks. Full Codex headless deck editing is not yet a release claim.

For alpha testing, use Generic external agent mode with a command template that writes a reviewed source-write manifest, or use Local Mock/BYOK.

## manual validation

Before claiming Codex support for a release:

1. Detect Codex.
2. Confirm auth/login status without exposing credentials.
3. Install project HTMLslide skills.
4. Run a read-only test.
5. Run a source-editing deck task.
6. Verify Check, Export, and diff review.

CI must use fake commands rather than a real Codex login.
