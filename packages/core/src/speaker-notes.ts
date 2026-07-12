import { z } from "zod";

export const SpeakerNotesModeSchema = z.enum([
  "none",
  "bullet-notes",
  "full-script",
  "rehearsal-cues"
]);

export type SpeakerNotesMode = z.infer<typeof SpeakerNotesModeSchema>;

export const SPEAKER_NOTES_MODES = SpeakerNotesModeSchema.options;
export const DEFAULT_SPEAKER_NOTES_MODE: SpeakerNotesMode = "bullet-notes";

const SPEAKER_NOTES_MODE_LABELS: Record<SpeakerNotesMode, string> = {
  "bullet-notes": "Bullet notes",
  "full-script": "Full script",
  none: "None",
  "rehearsal-cues": "Rehearsal cues"
};

const SPEAKER_NOTES_MODE_DESCRIPTIONS: Record<SpeakerNotesMode, string> = {
  "bullet-notes": "bullet speaker notes",
  "full-script": "full speaker script",
  none: "no speaker notes",
  "rehearsal-cues": "rehearsal cues"
};

export function isSpeakerNotesMode(value: unknown): value is SpeakerNotesMode {
  return typeof value === "string" && SPEAKER_NOTES_MODES.includes(value as SpeakerNotesMode);
}

export function normalizeSpeakerNotesMode(value: unknown): SpeakerNotesMode {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SPEAKER_NOTES_MODE;
  }
  if (!isSpeakerNotesMode(value)) {
    throw new Error(`Unknown speaker notes mode: ${String(value)}.`);
  }
  return value;
}

export function speakerNotesModeLabel(mode: SpeakerNotesMode): string {
  return SPEAKER_NOTES_MODE_LABELS[mode];
}

export function speakerNotesModeDescription(mode: SpeakerNotesMode): string {
  return SPEAKER_NOTES_MODE_DESCRIPTIONS[mode];
}

export function speakerNotesModeHasFiles(mode: SpeakerNotesMode): boolean {
  return mode !== "none";
}
