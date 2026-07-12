import { z } from "zod";
import type { HtmlslideIssue } from "./issues.js";
import { normalizeDeckPath } from "./paths.js";
import { SpeakerNotesModeSchema } from "./speaker-notes.js";
import { DECK_SCHEMA_VERSION } from "./version.js";

const CanvasDimensionSchema = z.number().int().min(1).max(16384);

export const ViewportSchema = z
  .object({
    width: CanvasDimensionSchema,
    height: CanvasDimensionSchema
  })
  .strict();

export const SafeAreaSchema = z
  .object({
    top: z.number().int().min(0),
    right: z.number().int().min(0),
    bottom: z.number().int().min(0),
    left: z.number().int().min(0)
  })
  .strict();

export const AspectRatioSchema = z.enum(["16:9"]);

export const DEFAULT_DECK_EXPORT_OPTIONS = {
  pdf: false,
  html: false,
  deckpkg: false,
  thumbnails: false,
  speakerNotes: false
} as const;

export const SlideKindSchema = z.enum([
  "title",
  "section",
  "content",
  "data",
  "image",
  "quote",
  "closing",
  "appendix",
  "custom"
]);

export const SlideStatusSchema = z.enum(["draft", "ready", "final"]);

export const DeckPathSchema = z.string().transform((value, context) => {
  try {
    return normalizeDeckPath(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid project-relative path."
    });
    return z.NEVER;
  }
});

export const ThemeReferenceSchema = z
  .object({
    css: DeckPathSchema.optional(),
    tokens: DeckPathSchema.optional()
  })
  .strict()
  .refine((theme) => theme.css !== undefined || theme.tokens !== undefined, {
    message: "Theme must reference at least css or tokens."
  });

export const DeckSlideSchema = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    title: z.string().min(1),
    source: DeckPathSchema,
    notes: DeckPathSchema.optional(),
    durationSec: z.number().int().positive().max(24 * 60).optional(),
    kind: SlideKindSchema.default("content"),
    status: SlideStatusSchema.default("draft")
  })
  .strict();

export const DeckExportSchema = z
  .object({
    pdf: z.boolean().default(false),
    html: z.boolean().default(false),
    deckpkg: z.boolean().default(false),
    thumbnails: z.boolean().default(false),
    speakerNotes: z.boolean().default(false)
  })
  .strict();

export type DeckExportOptions = z.infer<typeof DeckExportSchema>;

export function parseDeckExportOptions(value: unknown): DeckExportOptions {
  return DeckExportSchema.parse(value ?? DEFAULT_DECK_EXPORT_OPTIONS);
}

export function normalizeDeckExportOptions(value: unknown): DeckExportOptions {
  const result = DeckExportSchema.safeParse(value ?? DEFAULT_DECK_EXPORT_OPTIONS);
  return result.success ? result.data : { ...DEFAULT_DECK_EXPORT_OPTIONS };
}

export const DeckAgentSchema = z
  .object({
    preferredEngine: z.string().min(1).nullable().optional(),
    lastRunId: z.string().min(1).nullable().optional()
  })
  .strict();

export const DeckSchema = z
  .object({
    schemaVersion: z.literal(DECK_SCHEMA_VERSION),
    appVersion: z.string().min(1).optional(),
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    title: z.string().min(1),
    language: z.string().min(2).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/),
    aspectRatio: AspectRatioSchema,
    viewport: ViewportSchema,
    safeArea: SafeAreaSchema.default({ top: 0, right: 0, bottom: 0, left: 0 }),
    speakerNotesMode: SpeakerNotesModeSchema.optional(),
    theme: ThemeReferenceSchema.optional(),
    slides: z.array(DeckSlideSchema).min(1),
    export: DeckExportSchema.default(DEFAULT_DECK_EXPORT_OPTIONS),
    agent: DeckAgentSchema.default({})
  })
  .strict()
  .superRefine((deck, context) => {
    if (deck.aspectRatio === "16:9" && deck.viewport.width * 9 !== deck.viewport.height * 16) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["viewport"],
        message: "Viewport dimensions must match the declared 16:9 aspectRatio."
      });
    }

    if (deck.safeArea.left + deck.safeArea.right >= deck.viewport.width) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeArea"],
        message: "Safe area left + right must be smaller than viewport width."
      });
    }

    if (deck.safeArea.top + deck.safeArea.bottom >= deck.viewport.height) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeArea"],
        message: "Safe area top + bottom must be smaller than viewport height."
      });
    }

    const firstSlideIndexById = new Map<string, number>();
    deck.slides.forEach((slide, index) => {
      const existingIndex = firstSlideIndexById.get(slide.id);
      if (existingIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slides", index, "id"],
          message: `Slide id "${slide.id}" is duplicated; first used at slides.${existingIndex}.id.`
        });
      } else {
        firstSlideIndexById.set(slide.id, index);
      }
    });
  });

export type Viewport = z.infer<typeof ViewportSchema>;
export type SafeArea = z.infer<typeof SafeAreaSchema>;
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export type DeckSlide = z.infer<typeof DeckSlideSchema>;
export type Deck = z.infer<typeof DeckSchema>;

export interface DeckValidationSuccess {
  ok: true;
  deck: Deck;
  issues: [];
}

export interface DeckValidationFailure {
  ok: false;
  issues: HtmlslideIssue[];
  zodError: z.ZodError;
}

export type DeckValidationResult = DeckValidationSuccess | DeckValidationFailure;

export class DeckValidationError extends Error {
  readonly code = "DECK_VALIDATION_FAILED";

  constructor(
    readonly issues: HtmlslideIssue[],
    readonly zodError?: z.ZodError
  ) {
    super("Deck schema validation failed.");
    this.name = "DeckValidationError";
  }
}

export function validateDeck(value: unknown): DeckValidationResult {
  const result = DeckSchema.safeParse(value);

  if (result.success) {
    return {
      ok: true,
      deck: result.data,
      issues: []
    };
  }

  return {
    ok: false,
    issues: zodIssuesToHtmlslideIssues(result.error),
    zodError: result.error
  };
}

export function parseDeck(value: unknown): Deck {
  const result = validateDeck(value);

  if (!result.ok) {
    throw new DeckValidationError(result.issues, result.zodError);
  }

  return result.deck;
}

export function zodIssuesToHtmlslideIssues(error: z.ZodError): HtmlslideIssue[] {
  return error.issues.map((issue) => ({
    severity: "error",
    type: "schema-validation",
    path: issue.path.length > 0 ? issue.path.join(".") : undefined,
    message: issue.message
  }));
}
