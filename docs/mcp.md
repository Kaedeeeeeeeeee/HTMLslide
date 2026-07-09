# MCP

HTMLslide includes an MCP server package for alpha agent integrations.

The current alpha package exposes an in-process server harness and a stdio transport for local clients and tests. It can
start against a deck project, list implemented tools, read project metadata/slides, write scoped slide/notes/theme
source files, render fixed-viewport slide/deck HTML, run `check_deck` and read the latest check report, export PDF/deckpkg artifacts through the shared
compiler path, create/diff/revert file-copy checkpoints, and return bundled official skill instructions.

The CLI exposes the stdio server plus alpha discovery and startup checks:

```bash
htmlslide mcp <project-path>
htmlslide mcp --list-tools --json
htmlslide mcp <project-path> --status --json
```

The stdio command reserves stdout for MCP protocol messages and exposes implemented tools to clients. The first
diagnostic command returns registered tool descriptors, safety labels, and implementation status. The second diagnostic
command validates that a project-scoped MCP harness can start for the selected deck. These commands are intended for
local agent integration setup and CI coverage; they are not a claim that real Claude/Codex/Gemini MCP login has been
manually validated.

## Alpha boundary

MCP tools must respect the selected project boundary. They must reject path traversal, absolute paths outside the deck project, invalid project roots, and unsafe artifact writes. Write, export, checkpoint, and dangerous revert tools append audit entries to `.htmlslide/logs/mcp-audit.jsonl`.

Protocol mode must not include human-readable status text on stdout.

## Expected tool categories

- Read project metadata.
- List and read slides.
- Render a single slide or the full deck as fixed-viewport HTML without writing artifacts.
- Run Check.
- Read latest Check report.
- Export artifacts through the shared compiler path.
- Create, diff, and revert file-copy checkpoints.
- List bundled official skills and read skill instructions.
- Return schema-valid reports.

CI should use local fixtures and fake clients. Do not require provider credentials or external agent login for MCP tests.
