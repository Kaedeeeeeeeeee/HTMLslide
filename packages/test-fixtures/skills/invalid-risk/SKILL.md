---
name: invalid-risk-test
version: 0.1.0
description: Test skill with an unsupported risk level.
license: MIT
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: severe
installTargets:
  - project
deck:
  type: quality
  output: html-slide
  viewport: 1920x1080
  supports:
    - deck-check
  risk:
    scripts: true
    network: false
    remoteAssets: false
    writesExports: false
    writesSecrets: false
    modifiesSource: true
---

# Invalid Risk Test
