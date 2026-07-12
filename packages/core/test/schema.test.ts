import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseDeck,
  statusFromIssueSummary,
  summarizeIssues,
  validateDeck,
  type HtmlslideIssue
} from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../test-fixtures/decks/", import.meta.url));

function readFixtureDeck(fixtureName: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, fixtureName, "deck.json"), "utf8"));
}

describe("DeckSchema v0.1", () => {
  it.each([
    ["valid-minimal", 1],
    ["valid-full", 2]
  ])("accepts %s", (fixtureName, expectedSlideCount) => {
    const result = validateDeck(readFixtureDeck(fixtureName));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.issues.map((issue) => issue.message).join("\n"));
    }

    expect(result.deck.schemaVersion).toBe("0.1.0");
    expect(result.deck.slides).toHaveLength(expectedSlideCount);
    expect(result.deck.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("applies deterministic defaults for minimal decks", () => {
    const deck = parseDeck(readFixtureDeck("valid-minimal"));

    expect(deck.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(deck.export).toEqual({
      pdf: false,
      html: false,
      deckpkg: false,
      thumbnails: false,
      speakerNotes: false
    });
    expect(deck.agent).toEqual({});
    expect(deck.slides[0].kind).toBe("content");
    expect(deck.slides[0].status).toBe("draft");
  });

  it("normalizes partial export profiles with deterministic field defaults", () => {
    const deck = readFixtureDeck("valid-minimal") as Record<string, unknown>;
    expect(parseDeck({
      ...deck,
      export: { html: true }
    }).export).toEqual({
      deckpkg: false,
      html: true,
      pdf: false,
      speakerNotes: false,
      thumbnails: false
    });
  });

  it.each([
    ["invalid-duplicate-slide-id", "slides.1.id"],
    ["invalid-viewport", "viewport.width"],
    ["invalid-safe-area", "safeArea"],
    ["invalid-unsupported-schema", "schemaVersion"]
  ])("rejects %s", (fixtureName, expectedIssuePath) => {
    const result = validateDeck(readFixtureDeck(fixtureName));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(`${fixtureName} unexpectedly parsed`);
    }

    expect(result.issues.map((issue) => issue.path)).toContain(expectedIssuePath);
  });

  it("keeps missing files as a project loading concern", () => {
    const result = validateDeck(readFixtureDeck("invalid-missing-slide-source"));

    expect(result.ok).toBe(true);
  });

  it("accepts and preserves the recorded speaker notes mode", () => {
    const deck = readFixtureDeck("valid-minimal") as Record<string, unknown>;
    deck.speakerNotesMode = "none";

    const result = parseDeck(deck);

    expect(result.speakerNotesMode).toBe("none");
  });

  it.each([
    ["absolute path", "/tmp/slide.html"],
    ["URL path", "https://example.com/slide.html"],
    ["backslash path", "slides\\001-title.html"],
    ["dot segment", "./slides/001-title.html"],
    ["parent segment", "slides/../001-title.html"],
    ["exports path", "exports/001-title.html"]
  ])("rejects unsafe %s references", (_label, unsafePath) => {
    const deck = readFixtureDeck("valid-minimal") as Record<string, unknown>;
    const slides = deck.slides as Array<Record<string, unknown>>;
    slides[0].source = unsafePath;

    const result = validateDeck(deck);

    expect(result.ok).toBe(false);
  });
});

describe("issue summary helpers", () => {
  it("aggregates issue severities using the CLI JSON shape", () => {
    const issues: HtmlslideIssue[] = [
      { severity: "error", type: "schema-validation", message: "Invalid deck." },
      { severity: "warning", type: "contrast", message: "Low contrast." },
      { severity: "info", type: "notes", message: "Notes loaded." },
      { severity: "warning", type: "timing", message: "Long slide." }
    ];

    const summary = summarizeIssues(issues);

    expect(summary).toEqual({ errors: 1, warnings: 2, info: 1 });
    expect(statusFromIssueSummary(summary)).toBe("failed");
    expect(statusFromIssueSummary({ errors: 0, warnings: 2, info: 1 })).toBe("passed");
  });
});
