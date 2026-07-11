# Executable Onboarding Setup Wizard

## Problem

The six-step onboarding screen currently presents setup copy, but only the CLI and official-skills steps trigger real work. Workspace and AI-engine choices happen later in Project Library settings, and completion is not persisted, so every normal launch returns to onboarding.

## Decision

Keep the existing six-step shell and connect each step to the existing desktop services:

1. Welcome starts setup or exits immediately into No AI mode.
2. Workspace opens the native folder picker; using the default folder remains a skip path.
3. AI engine uses the same three modes and stored metadata as AI Engines settings.
4. CLI installs through the shared CLI integration service and reports its real status.
5. Official skills install through the shared skills service and report their real status.
6. Ready summarizes the selected workspace, AI mode, CLI state, and skills state.

Every optional path keeps No AI mode usable. Provider credentials and external-agent details remain in the full AI Engines settings page; onboarding selects the operating mode without duplicating credential forms.

## Persistence

Store `onboardingCompleted` in the existing desktop library JSON. The field is backward-compatible and defaults to `false` when absent. Completing or globally skipping onboarding updates the library through a dedicated Electron IPC method. Subsequent normal launches open Project Library directly, while explicit project or deck-package open requests continue to take precedence.

## Verification

- Desktop service tests cover legacy library migration and completion persistence.
- Electron E2E completes the real workspace, No AI, CLI, skills, and Ready flow using isolated paths.
- The same E2E relaunches against the persisted user data and proves onboarding does not reappear.
- Accessibility E2E continues to scan the first onboarding screen and named setup progress.
