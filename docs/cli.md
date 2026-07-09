# CLI

The `htmlslide` CLI is the agent-facing and CI-facing surface for the same project format used by the app.

## Common commands

```bash
htmlslide new demo
htmlslide check demo --json
htmlslide export demo --pdf --deckpkg --thumbnails --json
htmlslide doctor --json
```

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
