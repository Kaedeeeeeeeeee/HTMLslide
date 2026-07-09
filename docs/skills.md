# Skills

Skills are inspectable instructions for AI agents editing HTMLslide source.

## Official skills

The desktop app installs official skills during setup into the HTMLslide home directory. Official skills use `SKILL.md` files with metadata, license, risk declarations, supported deck schema, and fixed output expectations.

The first official pack includes planning, visual direction, design-system, content, data, quality, and brand-system skills.

Settings and the Skills library show the official pack as an inspectable skill library. Each row includes the skill description, deck type, risk level, license, version, and install state so stale or missing skills can be reviewed before installing. The library can be filtered by install state and deck type to inspect planning, visual-direction, design-system, content, data, quality, and brand-system skills separately.

Use Inspect on a skill row to review the official metadata before writing files: author, entrypoint, supported deck schema, output type, viewport, supported capabilities, install targets, resolved install path, risk flags, and the beginning of the generated `SKILL.md`.

## Safety

Official skills must not write generated exports or secrets. Third-party skills with scripts, network access, remote assets, or incompatible licenses require explicit user review before installation.

See [spec/skills.md](spec/skills.md) for the metadata contract.
