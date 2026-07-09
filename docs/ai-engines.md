# AI Engines

HTMLslide alpha has three visible engine modes.

## No AI

No AI can open projects, preview slides, run Check, export artifacts, and present existing decks. It does not generate new deck content.

## HTMLslide Agent

HTMLslide Agent is the BYOK path. It uses a provider API key stored outside project files and writes project source through the controlled source-write path.

See [BYOK](byok.md).

## External agent mode

External agent mode connects a coding agent such as Claude Code, Codex, or a compatible command. The current automated path supports Generic command execution with fake-command coverage in CI.

Claude Code and Codex alpha support is currently detection/status-first plus manual validation. Do not claim full real Claude/Codex headless support until that adapter path is implemented and tested.

See [Connect Claude Code](connect-claude-code.md) and [Connect Codex](connect-codex.md).
