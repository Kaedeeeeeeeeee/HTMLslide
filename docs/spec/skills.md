# HTMLslide Skills Spec

Official skills guide AI agents that edit deck source files. They must be inspectable, installable into a project, and license-aware.

HTMLslide uses the common Agent Skills folder shape:

```text
skill-name/
  SKILL.md
  assets/
  references/
  scripts/
  templates/
```

`SKILL.md` is the required entrypoint. HTMLslide metadata lives in YAML-style frontmatter at the top of that file. The parser intentionally supports a small deterministic subset: string values, booleans, nested maps, and string arrays.

## Metadata

Required frontmatter fields:

- `name`: lowercase letters, numbers, and hyphens.
- `version`: semantic version.
- `description`: short human-readable summary.
- `license`: one of the known skill licenses.
- `entrypoint`: safe project-relative Markdown path, normally `SKILL.md`.
- `supportedDeckSchema`: supported deck schema versions, currently `0.1.0`.
- `riskLevel`: `low`, `medium`, or `high`.
- `installTargets`: `global`, `project`, or both.
- `deck`: HTMLslide-specific metadata.

The `deck` object contains:

- `type`: `planning`, `visual-direction`, `design-system`, `content`, `data`, `quality`, or `brand-system`.
- `output`: `html-slide`.
- `viewport`: `1920x1080`.
- `preview`: optional HTML preview metadata.
- `supports`: capability labels such as `fixed-viewport`, `speaker-notes`, and `deck-check`.
- `risk`: declared behavior flags.

Risk flags:

- `scripts`
- `network`
- `remoteAssets`
- `writesExports`
- `writesSecrets`
- `modifiesSource`

Skills must not write secrets or generated `exports/`. Skills that run scripts, request network access, or use remote assets must be `medium` or `high` risk.

Example:

```yaml
---
name: swiss-editorial
version: 0.1.0
description: Apply restrained editorial typography and grid logic to HTMLslide decks.
license: Apache-2.0
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: low
installTargets:
  - global
  - project
author: HTMLslide
deck:
  type: design-system
  output: html-slide
  viewport: 1920x1080
  preview:
    type: html
    entry: assets/preview.html
  supports:
    - fixed-viewport
    - speaker-notes
    - deck-check
  risk:
    scripts: false
    network: false
    remoteAssets: false
    writesExports: false
    writesSecrets: false
    modifiesSource: true
---
```

## Official Registry

`@htmlslide/skills` owns the official registry foundation. The first bundled registry contains:

- `deck-architect`
- `visual-direction`
- `swiss-editorial`
- `consulting-clean`
- `technical-dark`
- `product-launch`
- `data-report`
- `chart-redesign`
- `speaker-notes`
- `anti-ai-slop`
- `deck-repair`
- `brand-kit`

Official bundled skills must use `MIT` or `Apache-2.0`, support deck schema `0.1.0`, install to both global and project targets, and declare no scripts, network access, remote assets, secret writes, or export writes.

The desktop official skills panel must expose the registry as an inspectable library, not only as an install button. Each skill row shows the name, description, deck type, risk level, license, version, and current install state (`missing`, `stale`, or `installed`) so users can review what will be installed or updated before running an agent.

Each skill row must support inspection before installation. The inspection view exposes the author, entrypoint, supported deck schema, output, viewport, supports list, install targets, resolved install path, declared risk flags, and a read-only preview of the generated `SKILL.md` entrypoint.

## Official Skill Body Contract

Official skill bodies are product guidance shown in the desktop Inspect view. High-value official skills must include more than metadata and shared operating boundaries. At minimum, detailed official bodies include when to use the skill, inputs or required context, a workflow or rule set, a concrete output contract, and checklist-style guidance with enough project-specific terms to guide an agent without another prompt.

The first detailed official bodies cover:

- `deck-architect`: brief, outline, narrative structure, slide intent, and source-safe planning output.
- `visual-direction`: 3 to 6 direction cards, typography, color, fixed-canvas layout rules, and selection notes.
- `deck-repair`: `htmlslide check --json` triage, overflow, contrast, assets, and remaining issue reporting.
- `brand-kit`: semantic tokens, layout rules, logo usage, contrast, license safety, and fallback choices.

## Licenses

Known licenses:

- Compatible for normal installation: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `CC0-1.0`, `Unlicense`.
- Review required before user installation: `MPL-2.0`, `LGPL-3.0`, `GPL-2.0`, `GPL-3.0`, `AGPL-3.0`, `Proprietary`, `Unknown`.

Official bundled skills are stricter than user-installed third-party skills: only `MIT` and `Apache-2.0` are accepted without legal review.

## Install Planning

The skills package creates dry-run install plans. Planning must not write files and must not inspect the real home directory. Callers pass the global home directory or project root explicitly.

Global target:

```text
<homeDir>/.htmlslide/skills/<skill-name>/SKILL.md
```

Project target:

```text
<projectRoot>/skills/project/<skill-name>/SKILL.md
```

Adapter-specific project locations may also be requested:

```text
<projectRoot>/.agents/skills/htmlslide/<skill-name>/SKILL.md
<projectRoot>/.claude/skills/htmlslide/<skill-name>/SKILL.md
```

Each install plan reports:

- `filesToWrite`: deterministic paths and file contents.
- `license`: compatibility classification and message.
- `warnings`: script, network, remote asset, high-risk, and license-review warnings.
- `installable`: false only when an error-level warning is present.

Third-party skills are installed only after explicit user action. Skills that run scripts must disclose that capability before installation.
