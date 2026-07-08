---
name: scripted-third-party
version: 1.2.3
description: Third-party fixture that declares scripts, network, and remote assets.
license: GPL-3.0
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: high
installTargets:
  - project
deck:
  type: data
  output: html-slide
  viewport: 1920x1080
  supports:
    - fixed-viewport
    - deck-check
  risk:
    scripts: true
    network: true
    remoteAssets: true
    writesExports: false
    writesSecrets: false
    modifiesSource: true
---

# Scripted Third Party

Fixture skill used to verify install warnings.
