import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEAKER_NOTES_MODE,
  normalizeSpeakerNotesMode,
  speakerNotesModeDescription,
  speakerNotesModeHasFiles,
  speakerNotesModeLabel
} from "../src/index.js";

describe("speaker notes contract", () => {
  it("normalizes the omitted mode to the New Deck default", () => {
    expect(normalizeSpeakerNotesMode(undefined)).toBe(DEFAULT_SPEAKER_NOTES_MODE);
    expect(normalizeSpeakerNotesMode("full-script")).toBe("full-script");
  });

  it("rejects unknown modes instead of silently changing the request", () => {
    expect(() => normalizeSpeakerNotesMode("verbose" as never)).toThrow("Unknown speaker notes mode");
  });

  it.each([
    ["none", "None", "no speaker notes", false],
    ["bullet-notes", "Bullet notes", "bullet speaker notes", true],
    ["full-script", "Full script", "full speaker script", true],
    ["rehearsal-cues", "Rehearsal cues", "rehearsal cues", true]
  ] as const)("describes %s consistently for UI and agent prompts", (mode, label, description, hasFiles) => {
    expect(speakerNotesModeLabel(mode)).toBe(label);
    expect(speakerNotesModeDescription(mode)).toBe(description);
    expect(speakerNotesModeHasFiles(mode)).toBe(hasFiles);
  });
});
