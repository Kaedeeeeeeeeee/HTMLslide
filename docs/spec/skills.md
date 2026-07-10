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

## Shared Install And Store Service

`@htmlslide/skills` owns the filesystem and network behavior used by CLI and desktop skill management. Callers resolve a source, inspect the pure install plan, obtain any required user confirmation, and then execute the plan through the shared service. CLI and desktop integrations must not maintain separate copy, update, or delete implementations.

### Source Resolution

The service accepts explicit source descriptors and a convenience string form:

- `{ kind: "official", name }` resolves an exact official registry name.
- `{ kind: "local", path }` resolves a local regular file or directory. Relative paths resolve against the caller-provided `cwd` or the process working directory.
- `{ kind: "url", url }` resolves direct Markdown content over HTTPS.
- A string matching an official registry name resolves as official first. A string with a URL scheme resolves as a URL; all other strings resolve as local paths. Prefix a same-named local path with `./` to select the local source.

Official, URL, and single-file sources install one UTF-8 `SKILL.md`. Direct Markdown sources must declare `entrypoint: SKILL.md`. A local directory must contain root-level `SKILL.md`; its declared entrypoint must exist in the directory. All regular files in that directory are included, preserving executable versus non-executable mode. Symbolic links, special files, unsafe relative paths, and the reserved `.htmlslide-managed.json` path are rejected.

Default source limits are deterministic:

- `SKILL.md`: 1 MiB.
- Local directory: 256 files and 16 MiB total.
- URL: 1 MiB after response decoding, 15 second timeout, and at most 5 redirects.

Every URL and redirect must use HTTPS and must not contain credentials or target localhost, a private literal IP address, or a link-local literal IP address. Before each fetch, hostname sources are resolved through the injectable host resolver (system DNS by default). Resolution failure, an empty address set, an invalid address, or any resolved private, loopback, link-local, or multicast IPv4/IPv6 address rejects the request. Tests and controlled callers may inject a deterministic fetch; the production `node:https` transport disables connection reuse and supplies a custom lookup that can return only the public addresses accepted by that request's preflight. The original URL hostname remains the TLS verification/SNI name and `Host` header. This preflight and address pinning are repeated after every redirect before the redirected URL is fetched.

Accepted response media types are `text/markdown`, `text/plain`, and `application/octet-stream`. Missing bodies, invalid UTF-8, unsafe media types, non-success HTTP responses, malformed redirects, and responses exceeding either declared or streamed byte limits fail before parsing. Returned URL references omit query strings and fragments so result and log objects do not retain URL tokens.

### Planning And Confirmation

Resolved metadata is parsed and validated by the existing skill parser. `planResolvedSkillInstall` remains pure: it performs no filesystem reads, network calls, or writes. It expands the validated source files into deterministic destination files and adds the management record described below.

The plan is not installable when it contains any error-level warning, including an unsupported install target or invalid/empty project location selection. `installSkill` always rejects non-installable plans. If any warning-level item exists, including scripts, network access, remote assets, high risk, or a review-required/unknown license, callers must pass explicit `confirmWarnings: true` after presenting those warnings to the user. Third-party origin alone does not bypass the metadata risk and license checks.

The global target accepts either:

```text
{ kind: "global", homeDir }             -> <homeDir>/.htmlslide/skills/
{ kind: "global", htmlslideHomeDir }    -> <htmlslideHomeDir>/skills/
```

The second form lets desktop callers reuse an already resolved `HTMLSLIDE_HOME`. Project targets use the project, Codex, and Claude locations defined above. Duplicate project locations are removed while preserving request order.

### Managed Installs

Every shared-service install writes this record inside each installed skill directory:

```text
<skill-name>/.htmlslide-managed.json
```

The record has `schemaVersion: 1`, `manager: "htmlslide"`, skill name, version, entrypoint, source kind, and a sorted list of installed relative file paths with SHA-256, byte size, and normalized `0644` or `0755` mode. It does not store local source paths, remote URL query strings, or secrets. The install plan and public result objects have stable fields and deterministic ordering; private staging and backup names are never returned.

Installation stages the complete skill directory beside its destination, verifies planned hashes, then commits with directory renames. Multi-location installs stage every destination before commit and roll back already committed locations if a later commit fails. An existing destination is updated only when it has valid skill metadata, a valid HTMLslide management record, and file inventory matching that record. Unmanaged, invalid, symlinked, or locally modified destinations are never overwritten.

Desktop migration may opt into `adoptLegacyOfficial: true` for an official registry source. This is the only unmanaged overwrite exception. The destination must have no management record, and its recursive inventory may contain only regular files and directories required by the current official source file paths. `SKILL.md` is required; symbolic links, special files, unexpected files, and unexpected directories reject adoption. A legacy file does not need parseable metadata because an older desktop install may be stale, but the replacement source is always the validated bundled official definition. Exact-current content is reported as `adopted`; stale allowed content is replaced and reported as `updated`. Passing the option for local or URL sources fails with `SKILL_LEGACY_ADOPTION_NOT_ALLOWED`. Without the option, official and third-party unmanaged targets continue to be refused.

Install result actions are:

- `installed`: at least one requested location was missing and no location required an update.
- `updated`: at least one verified managed location was replaced with a different managed record.
- `adopted`: at least one exact-current legacy official location received a management record and no location required an update.
- `unchanged`: every requested location already matched the planned record and verified file inventory.

Each location also reports its own `installed`, `updated`, `adopted`, or `unchanged` action. If a multi-location operation contains both stale and exact-current legacy official locations, the overall action is `updated` and each location retains its own action.

### List, Inspect, And Remove

Listing reads direct entries beneath the expected target roots. It returns valid parsed skills sorted by name and location, with `managed` and `integrity` (`verified`, `modified`, `unmanaged`, or `invalid`). Valid unmanaged skills remain inspectable. Invalid directory names, unsafe entries, and invalid skill contents are returned separately in the deterministic `invalid` list. Inspection returns full parsed metadata, Markdown, resolved paths, and the management record when valid.

Removal accepts only a validated skill name, derives the directory from the selected target roots, and never accepts an arbitrary delete path. Before any rename it requires valid `SKILL.md`, matching skill name, a valid HTMLslide management record, verified recorded hashes, and no symbolic links or unexpected files. Multi-location removal preflights every existing location, renames verified directories to private tombstones, and only then recursively deletes those tombstones. Missing selected locations are reported; if every selected location is missing, removal fails with `SKILL_NOT_FOUND`.

Public failures use `SkillStoreError` with a stable `code`. Source failures use `SKILL_SOURCE_*`, including `SKILL_SOURCE_DNS_FAILED` for resolver failures; confirmation and plan failures use `SKILL_CONFIRMATION_REQUIRED` and `SKILL_PLAN_NOT_INSTALLABLE`; target safety and ownership failures use `SKILL_TARGET_*`; legacy migration policy uses `SKILL_LEGACY_ADOPTION_NOT_ALLOWED` and `SKILL_LEGACY_ADOPTION_UNSAFE`; lookup/name failures use `SKILL_NOT_FOUND` and `SKILL_NAME_INVALID`; execution failures use `SKILL_INSTALL_FAILED` or `SKILL_REMOVE_FAILED`. Callers may present the message, but automation must branch on the code.
