---
name: deck-architect-test
version: 0.1.0
description: Test skill for planning HTMLslide deck structure.
license: MIT
entrypoint: SKILL.md
supportedDeckSchema:
  - 0.1.0
riskLevel: low
installTargets:
  - global
  - project
author: HTMLslide Tests
deck:
  type: planning
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

# Deck Architect Test

Fixture skill used by package tests.
