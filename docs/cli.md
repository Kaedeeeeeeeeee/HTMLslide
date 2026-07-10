# CLI

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same project format used by the app.

## Common commands

```bash
htmlslide new demo
htmlslide new report --template data-report
htmlslide templates list --json
htmlslide open demo --json
htmlslide check demo --json
htmlslide export demo --pdf --deckpkg --thumbnails --json
htmlslide package demo --json
htmlslide present demo --json
htmlslide skill list --json
htmlslide skill inspect deck-architect --json
htmlslide mcp demo
htmlslide mcp --list-tools --json
htmlslide mcp demo --status --json
htmlslide agent validate-provider --provider openai --model <openai-model-id> --api-key-env OPENAI_API_KEY --json
htmlslide doctor --json
```

## Open, package, and present

`htmlslide package <project>` runs the same check and transactional compiler used by the App, then creates a portable `.deckpkg`. It does not package or sign `HTMLslide.app`.

`htmlslide open <project>` opens a source project in the configured macOS App. `htmlslide present <project-or-deckpkg>` packages source projects when needed, validates the deckpkg, and opens presenter mode. These commands require the App path installed during first-run CLI setup; missing or moved App installs return exit code `4` with a repair instruction.

## Skill commands

Official and user-installed skills share one managed store:

```bash
htmlslide skill list --json
htmlslide skill add deck-architect --json
htmlslide skill add /path/to/my-skill --project demo --location project codex --yes --json
htmlslide skill inspect deck-architect --json
htmlslide skill remove deck-architect --yes --json
```

Local directories and direct HTTPS `SKILL.md` URLs are supported. HTMLslide validates metadata, declared risks, licenses, source limits, and target ownership before writing. Installs with warning-level risks require `--yes`; removal refuses unmanaged or locally modified skill directories.

## MCP commands

The alpha CLI exposes a project-scoped stdio MCP server plus one-shot local setup checks:

```bash
htmlslide mcp <project-path>
htmlslide mcp --list-tools --json
htmlslide mcp <project-path> --status --json
```

`htmlslide mcp <project-path>` starts the long-running stdio MCP server and reserves stdout for MCP protocol messages. `--list-tools` returns registered tool descriptors, safety labels, and whether each tool is currently implemented by the alpha harness. `htmlslide mcp <project-path> --status` verifies that the harness can start against a deck project and returns the project root plus registered and implemented tool counts. The diagnostics are local discovery/check paths for alpha integrations; they do not require provider credentials or real Claude/Codex/Gemini login.

## Provider validation

Use `agent validate-provider` before a real BYOK alpha run:

```bash
export OPENAI_API_KEY="..."
htmlslide agent validate-provider --provider openai --model <openai-model-id> --api-key-env OPENAI_API_KEY --json
```

For OpenAI-compatible providers, pass the API root explicitly:

```bash
htmlslide agent validate-provider --provider compatible --model <compatible-model-id> --api-key-env COMPATIBLE_API_KEY --base-url https://provider.example.com/v1 --json
```

The command reads the provider key only from the named environment variable. It prints the variable name, provider, model, and sanitized credential status; it does not print the key value.

## Setup commands

The app normally manages the CLI shim. Advanced users can inspect it with:

```bash
htmlslide setup status --json
htmlslide setup install-cli --json
htmlslide setup uninstall-cli --json
```

## Contract

Important commands return machine-readable JSON for agents and CI. Exit codes distinguish validation failures, export failures, missing dependencies, permission errors, agent failures, project-not-found, and incompatible schema.

See [spec/cli.md](spec/cli.md) for the full CLI contract.
