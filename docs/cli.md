# CLI

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same project format used by the app.

## Common commands

```bash
htmlslide new demo
htmlslide new report --template data-report
htmlslide templates list --json
htmlslide check demo --json
htmlslide export demo --pdf --deckpkg --thumbnails --json
htmlslide mcp --list-tools --json
htmlslide mcp demo --status --json
htmlslide doctor --json
```

## MCP commands

The alpha CLI exposes the MCP in-process harness for local agent setup checks:

```bash
htmlslide mcp --list-tools --json
htmlslide mcp <project-path> --status --json
```

`--list-tools` returns registered tool descriptors, safety labels, and whether each tool is currently implemented by the alpha harness. `htmlslide mcp <project-path> --status` verifies that the harness can start against a deck project and returns the project root plus registered and implemented tool counts. This is the local discovery/check path for alpha integrations; it does not require provider credentials or real Claude/Codex/Gemini login.

The future bare `htmlslide mcp` command is reserved for the long-running stdio MCP server described in the product plan. Until that server transport is implemented, the CLI fails clearly instead of printing human status text on stdout as if it were an MCP protocol stream.

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
