# Speaker Notes Development

Speaker notes are source content, not an export-only preference. The shared contract lives in `@htmlslide/core` as `SpeakerNotesMode`:

| Mode | Source behavior |
| --- | --- |
| `none` | Omit every slide `notes` path and remove existing `notes/*.md` files when the deterministic mock writer replaces a project. |
| `bullet-notes` | Write concise Markdown bullets for the slide goal, context, and presenter cue. |
| `full-script` | Write a complete presenter script with context, cue, and timing guidance. |
| `rehearsal-cues` | Write short cue, bridge, pause, and timing instructions for rehearsal. |

`deck.json.speakerNotesMode` is the persisted source-of-truth. `deck.json.slides[].notes` remains optional and is present only when the selected mode writes notes. `export.speakerNotes` follows the same policy; the compiler may still emit its required `exports/notes.json` sidecar, whose slides have `hasNotes: false` when source notes are absent.

The desktop New Deck flow maps its `speakerNotes` field to `speakerNotesMode` on the shared agent request. The CLI uses the same contract with `htmlslide agent run --speaker-notes <mode>`. Provider-backed and external paths receive the mode in their request/prompt, but deterministic tests use only `htmlslide-mock`; no real provider is required.

Focused verification:

```bash
./node_modules/.bin/tsc -p packages/core/tsconfig.json
./node_modules/.bin/tsc -p packages/agent/tsconfig.json
./node_modules/.bin/vitest run --root ../.. --config vitest.config.ts packages/core/test/speaker-notes.test.ts packages/agent/test/mock-project.test.ts packages/agent/test/orchestrator.test.ts
./node_modules/.bin/vitest run --root ../.. --config vitest.config.ts packages/cli/__tests__/cli-project.test.ts
```

The desktop smoke test selects `full-script` in New Deck and verifies the persisted manifest, sanitized agent report, generated Markdown, and Notes inspector label. Do not modify `exports/` by hand; export artifacts are compiler-owned.
