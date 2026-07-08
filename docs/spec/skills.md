# HTMLslide Skills Spec

Official skills guide AI agents that edit deck source files. They must be inspectable, installable into a project, and license-aware.

Skill metadata fields:

- `name`
- `version`
- `description`
- `license`
- `entrypoint`
- `supportedDeckSchema`
- `riskLevel`

Rules:

- Official bundled skills must use permissive licenses.
- Third-party skills are installed only after explicit user action.
- Skills must not write secrets or generated exports.
- Skills that run scripts must disclose that capability before installation.

