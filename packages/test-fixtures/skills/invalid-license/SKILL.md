---
name: invalid-license-test
version: 0.1.0
description: Test skill with an unsupported license.
license: CC-BY-NC-4.0
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: low
installTargets:
  - project
deck:
  type: quality
  output: html-slide
  viewport: 1920x1080
  supports:
    - deck-check
  risk:
    scripts: false
    network: false
    remoteAssets: false
    writesExports: false
    writesSecrets: false
    modifiesSource: true
---

# Invalid License Test
