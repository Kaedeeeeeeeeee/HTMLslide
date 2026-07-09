# MCP

HTMLslide includes an MCP server package for alpha agent integrations.

## Alpha boundary

MCP tools must respect the selected project boundary. They must reject path traversal, absolute paths outside the deck project, invalid project roots, and unsafe artifact writes.

## Expected tool categories

- Read project metadata.
- List and read slides.
- Run Check.
- Export artifacts through the shared compiler path.
- Return schema-valid reports.

CI should use local fixtures and fake clients. Do not require provider credentials or external agent login for MCP tests.
