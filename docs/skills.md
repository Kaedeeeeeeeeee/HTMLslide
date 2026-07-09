# Skills

Skills are inspectable instructions for AI agents editing HTMLslide source.

## Official skills

The desktop app installs official skills during setup into the HTMLslide home directory. Official skills use `SKILL.md` files with metadata, license, risk declarations, supported deck schema, and fixed output expectations.

The first official pack includes planning, visual direction, design-system, content, data, quality, and brand-system skills.

## Safety

Official skills must not write generated exports or secrets. Third-party skills with scripts, network access, remote assets, or incompatible licenses require explicit user review before installation.

See [spec/skills.md](spec/skills.md) for the metadata contract.
