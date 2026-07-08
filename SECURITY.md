# Security Policy

HTMLslide is local-first and handles user projects, provider keys, external agent integrations, MCP tools, and packaged deck artifacts. Treat project boundaries and secrets as product-critical behavior.

## Supported Versions

During alpha, security fixes target the `main` branch and the latest published alpha artifacts. Stable version support will be defined before a `1.0` release.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting or contact the repository maintainers through the private channel listed in the GitHub repository. Do not open a public issue for exploitable vulnerabilities, leaked secrets, path traversal, sandbox bypasses, or supply-chain concerns.

Please include:

- Affected version, commit, or artifact.
- Operating system and architecture.
- Reproduction steps.
- Whether real secrets, private decks, or external agent credentials were exposed.
- Any logs with secrets removed.

## Security Requirements

- Never write API keys or provider tokens to project files, fixtures, logs, crash reports, or workflow artifacts.
- External agents must not write outside the selected project in protected mode.
- MCP tools must reject path traversal and invalid project paths.
- Third-party skills with scripts must require an explicit warning before use.
- Remote assets and remote fonts must be detected by checks.
- Malformed deckpkg files must be rejected safely.
- CI must use mock providers and fake external agents, not real user credentials.

## Dependency and Release Hygiene

Use pnpm lockfiles, review dependency changes, and keep signing/notarization credentials in GitHub secrets or organization-owned secret stores only. Unsigned alpha artifacts must be clearly labeled as unsigned and should not imply notarized distribution.
