# Phase 4 Real Provider Acceptance Design

## Status

Approved for implementation as the smallest Phase 4 closure that preserves the existing desktop BYOK architecture.

## Problem

Phase 4 has provider adapters, Keychain-backed credentials, an orchestrator, source-write application, checkpoints, real CLI check/export, and sanitized desktop reports. Three gaps prevent a product-grade real-provider acceptance claim:

1. A requested slide count is only prompt text. Provider output is not rejected when it misses an explicit count.
2. Desktop BYOK can validate credentials, spend provider tokens, and apply source writes before discovering that the authoritative CLI runtime is unavailable.
3. Release acceptance is a Markdown checklist. Provider validation, the desktop run report, the final deck, and exports are not bound into one machine-verifiable evidence artifact.

No provider credential is currently available in the default local environment or HTMLslide Keychain accounts. This design therefore separates implementation readiness from the final manual provider run and does not treat fixtures as real-provider evidence.

## Considered Approaches

### A. Add a second headless BYOK runner to the CLI

This could perform provider validation, generation, source writes, check, export, and evidence creation in one process. It duplicates the desktop execution path, credential behavior, checkpoint handling, and reporting. It would violate the shared-core intent unless the desktop path were first refactored around the new runner, which is larger than the Phase 4 acceptance gap.

### B. Drive the packaged desktop app through UI automation

This best represents the user workflow, but it is fragile for release evidence, depends on macOS UI state and Keychain prompts, and makes secret handling harder to audit. UI automation remains useful for broader RC acceptance, not as the evidence format itself.

### C. Verify existing sanitized outputs after a desktop run

This is the selected approach. The desktop remains the only real BYOK execution surface. A release verifier consumes a sanitized `agent validate-provider --json` result plus the exact desktop run report and project outputs. It emits a run-bound evidence manifest or fails closed. This adds no provider network path and never accepts a raw API key argument.

## Runtime Contract

### Structured slide target

An explicit New Deck count is propagated as `targetSlideCount` from the renderer request through Electron to `AgentRunInput`. `auto` remains undefined. The orchestrator supplies the target to provider stage input and rejects an outline whose length differs from the explicit target. Provider schemas require non-empty arrays; deterministic mock output honors the target so automated acceptance can exercise an 8-12 page deck.

The desktop source-write boundary validates the generated `deck.json` before applying writes. Its slide IDs and count must match the accepted outline. This prevents a provider from returning a valid ten-slide outline with a partial one-slide build.

### CLI preflight

Desktop BYOK requires an available packaged/development CLI runtime before reading Keychain credentials or constructing a provider. Missing runtime fails at the brief stage with an actionable error. No provider call or project source write occurs. Real CLI `check` and `export` remain authoritative after source writes.

### Evidence command

The root command is:

```text
pnpm rc:byok-evidence -- --project <deck> --provider-validation <validation.json> [--run-id <id>] [--output <file>]
```

The verifier reads the exact run report, defaulting to `.htmlslide/reports/latest-agent-run.json`, and requires:

- passed sanitized provider validation with `secretRecorded: false`;
- a successful `htmlslide-byok` desktop report with matching provider/model;
- 8-12 unique outline and manifest slide IDs with exact ID/order agreement;
- provider source writes applied through the guarded source-write path;
- a reversible `file-copy` checkpoint;
- successful authoritative CLI check and export stages;
- an export manifest whose current source and artifact fingerprints match its canonical source digest and whose SHA-256 artifact digests are recorded in evidence;
- a matching checkpoint manifest with existing snapshots;
- no raw secret fields or common API-key/token patterns in the consumed JSON evidence or exported text sources.

The evidence file records metadata, checks, explicit slide count, run ID, provider/model, compatible endpoint hash, export source digest, relative artifact paths, byte sizes, and SHA-256 digests. Candidate commit/artifact URL values are caller-declared labels for the human RC checklist, not downloaded or cryptographically verified by this script. Evidence does not embed prompts, slide source, notes, provider responses, CLI stdout/stderr, environment values, or Keychain contents.

## Failure And Rollback

Count or build-manifest mismatch fails before provider source writes are applied. A missing CLI runtime fails before credential access. Failures after a checkpoint and source-write application continue to use the existing file-copy revert path. The evidence verifier is read-only except for its output file and exits nonzero on malformed, stale, mismatched, incomplete, symlinked, or secret-bearing evidence.

## Tests

- Agent tests cover explicit count success, mismatch failure, non-empty provider schemas, and deterministic mock count.
- Desktop tests prove missing CLI runtime performs no credential/provider/source-write work and prove outline/deck-manifest mismatch is rejected before apply.
- Renderer/registry tests cover `targetSlideCount` validation and propagation.
- Release-script tests use deterministic temporary projects to prove valid 8-12 slide evidence passes; wrong run/provider/count, missing artifacts, malformed reports, and secret-like fields fail; emitted evidence never contains a supplied sentinel secret.
- Documentation and CLI specs describe the file-copy checkpoint and the exact real-provider acceptance command.

The final real-provider acceptance remains a manual release action until a configured test credential is available. The generated evidence manifest is the completion record for that action.
