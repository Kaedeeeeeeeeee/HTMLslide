# Security

HTMLslide is local-first and handles user projects, provider credentials, external agent commands, MCP tools, and deckpkg artifacts.

## API keys

API keys must not be written to project files, fixtures, reports, logs, crash output, or workflow artifacts.

## project boundary

Agents, MCP tools, and source-write paths must stay inside the selected deck project unless the user explicitly chooses another folder. Path traversal must be rejected.

External-agent child processes receive only a small runtime environment by default; full parent-environment inheritance is opt-in at the low-level runner and is not used by the built-in or Generic adapters. Explicit child environment values, command failures, and streamed chunks are bounded and sanitized at the adapter boundary. Generic runs must report every changed source file before Check or Export proceeds. Provider validation rejects malformed environment-variable names and compatible URLs containing embedded credentials, query parameters, or fragments.

## vulnerability reports

Report exploitable vulnerabilities privately through GitHub security advisories. Do not open a public issue for leaked secrets, path traversal, sandbox bypasses, or supply-chain concerns.

See [../SECURITY.md](../SECURITY.md) for the repository security policy.
