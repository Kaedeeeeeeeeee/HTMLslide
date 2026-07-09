# Connect Claude Code

Claude Code integration is planned as an external agent path.

## Current alpha behavior

HTMLslide can run detection for Claude Code installation/auth status through configured command checks. Full Claude Code headless deck editing is not yet a release claim.

For alpha testing, use Generic external agent mode with a command template that writes a reviewed source-write manifest, or use Local Mock/BYOK.

## manual validation

Before claiming Claude Code support for a release:

1. Detect Claude Code.
2. Confirm authentication without exposing credentials.
3. Install project HTMLslide skills.
4. Run a read-only test.
5. Run a source-editing deck task.
6. Verify Check, Export, and diff review.

CI must use fake commands rather than real Claude Code login.
