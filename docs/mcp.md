# MCP

HTMLslide includes an MCP server package for alpha agent integrations.

The current alpha package exposes an in-process server harness for local clients and tests. It can start against a
deck project, list registered tools, read project metadata/slides, write scoped slide/notes/theme source files, run
`check_deck` through the linter, and create `export_pdf` artifacts through the shared compiler path.

The CLI exposes the alpha discovery and startup checks:

```bash
htmlslide mcp --list-tools --json
htmlslide mcp <project-path> --status --json
```

The first command returns registered tool descriptors, safety labels, and implementation status. The second validates
that a project-scoped MCP harness can start for the selected deck. These commands are intended for local agent
integration setup and CI coverage; they are not a claim that real Claude/Codex/Gemini MCP login has been manually
validated.

## Alpha boundary

MCP tools must respect the selected project boundary. They must reject path traversal, absolute paths outside the deck project, invalid project roots, and unsafe artifact writes.

The product plan reserves bare `htmlslide mcp` for a long-running stdio MCP server. The alpha CLI does not expose that
transport yet; stdout protocol mode must not include human-readable status text.

## Expected tool categories

- Read project metadata.
- List and read slides.
- Run Check.
- Export artifacts through the shared compiler path.
- Return schema-valid reports.

CI should use local fixtures and fake clients. Do not require provider credentials or external agent login for MCP tests.
