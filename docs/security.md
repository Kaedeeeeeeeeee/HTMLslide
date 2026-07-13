# Security

HTMLslide is local-first and handles user projects, provider credentials, external agent commands, MCP tools, and deckpkg artifacts.

## API keys

API keys must not be written to project files, fixtures, reports, logs, crash output, or workflow artifacts.

## project boundary

Agents, MCP tools, and source-write paths must stay inside the selected deck project unless the user explicitly chooses another folder. Path traversal must be rejected.

External-agent output is bounded and sanitized at the adapter boundary, including inherited environment values, command failures, and streamed chunks. Generic runs must report every changed source file before Check or Export proceeds. Provider validation rejects malformed environment-variable names and compatible URLs containing embedded credentials, query parameters, or fragments.

## vulnerability reports

Report exploitable vulnerabilities privately through GitHub security advisories. Do not open a public issue for leaked secrets, path traversal, sandbox bypasses, or supply-chain concerns.

See [../SECURITY.md](../SECURITY.md) for the repository security policy.
