# HTMLslide Templates Spec

Deck templates are built-in starters for new local projects. They are distinct from Agent Skill `templates/` folders, which belong to skill packages.

## Metadata

Every built-in deck template exposes:

- `id`: stable lowercase id used by CLI and desktop UI.
- `name`: short display name.
- `summary`: compact label for template cards and CLI output.
- `description`: one-paragraph user-facing description.
- `tags`: short labels for filtering or future browsing.
- `slideCount`: number of slides created before any agent generation.

## Rendering

Rendering a template returns a validated `deck.json` manifest plus project-relative file writes. Template file paths must be relative, must not contain traversal segments, and must not point into `exports/`.

The public alpha registry includes:

| id | purpose |
| --- | --- |
| `default` | General local-first deck starter. |
| `swiss-editorial` | Large type, strict grid, high whitespace, and restrained color. |
| `consulting-clean` | Conclusion-led business reporting, matrices, comparisons, and frameworks. |
| `technical-dark` | Dark technical architecture, code, and developer workflow storytelling. |
| `product-launch` | Product announcement flow, feature proof, and rollout narrative. |
| `data-report` | Metric hierarchy, trend framing, dashboards, and insight-led reporting. |

Every built-in deck template writes:

- `deck.json`
- `README.md`
- `AGENTS.md`
- `slides/*.html`
- `notes/*.md`
- `theme/theme.css`
- `theme/tokens.json`

## Safety

Templates must not include API keys, provider tokens, local machine paths, generated exports, or remote-only assets. Generated projects remain ordinary HTMLslide folders, so agents can inspect and edit the same source files used by the app and CLI.
