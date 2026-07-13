import { AgentRunCancelledError } from "./errors.js";
import { normalizeSpeakerNotesMode, type SpeakerNotesMode } from "@htmlslide/core";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentOutline,
  AgentOutlineSlide,
  AgentRepairResult,
  AgentRunStage,
  AgentExportResult,
  AgentReviewResult,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  NormalizedBrief,
  VisualDirectionSample,
  VisualDirectionSet
} from "./types.js";

export type MockProviderOptions = {
  id?: string;
  label?: string;
  failStages?: AgentRunStage[];
  hangStages?: AgentRunStage[];
  delayMs?: number | ((stage: AgentRunStage) => number);
  checkResults?: AgentCheckResult[];
  exportResult?: AgentExportResult;
};

const mockTitle = "Mock HTMLslide Deck";

const defaultOutlineSlides = [
  {
    id: "001-title",
    title: "HTMLslide mock deck",
    kind: "title",
    goal: "Introduce the deck promise and project constraints."
  },
  {
    id: "002-workflow",
    title: "Controlled agent workflow",
    kind: "content",
    goal: "Show the brief, outline, visual direction, build, check, repair, export, review loop."
  },
  {
    id: "003-review",
    title: "Reviewable outputs",
    kind: "closing",
    goal: "Summarize files, checks, exports, and next actions."
  }
] as const satisfies readonly AgentOutlineSlide[];

const waitFor = async (ms: number, signal?: AbortSignal, stage?: AgentRunStage): Promise<void> => {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw new AgentRunCancelledError("Agent run was cancelled.", stage);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);

    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new AgentRunCancelledError("Agent run was cancelled.", stage));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const createMockFailedCheck = (): AgentCheckResult => ({
  status: "failed",
  summary: {
    errors: 1,
    warnings: 1,
    info: 0
  },
  issues: [
    {
      severity: "error",
      type: "text-overflow",
      message: "Slide 002 has body copy outside the fixed 16:9 safe area.",
      path: "slides/002-workflow.html",
      slideId: "002-workflow",
      suggestedFix: "Shorten the panel text and keep the slide at 1920x1080."
    },
    {
      severity: "warning",
      type: "missing-speaker-note-detail",
      message: "Slide 002 notes are too thin for presenter review.",
      path: "notes/002-workflow.md",
      slideId: "002-workflow"
    }
  ]
});

export const createMockPassedCheck = (): AgentCheckResult => ({
  status: "passed",
  summary: {
    errors: 0,
    warnings: 0,
    info: 1
  },
  issues: [
    {
      severity: "info",
      type: "mock-check",
      message: "Mock provider check passed after deterministic repair."
    }
  ]
});

const asBriefText = (request: ModelRequest): string => {
  if (typeof request.input === "object" && request.input !== null && "brief" in request.input) {
    const input = request.input as { brief?: unknown };
    return typeof input.brief === "string" && input.brief.trim().length > 0 ? input.brief : request.prompt;
  }

  return request.prompt;
};

const repairAttemptFrom = (request: ModelRequest): number => {
  if (typeof request.input === "object" && request.input !== null && "attempt" in request.input) {
    const input = request.input as { attempt?: unknown };
    return typeof input.attempt === "number" ? input.attempt : 1;
  }

  return 1;
};

const targetSlideCountFrom = (request: ModelRequest): number | undefined => {
  if (typeof request.input !== "object" || request.input === null || !("targetSlideCount" in request.input)) {
    return undefined;
  }

  const targetSlideCount = (request.input as { targetSlideCount?: unknown }).targetSlideCount;
  return typeof targetSlideCount === "number" && Number.isInteger(targetSlideCount) && targetSlideCount > 0
    ? targetSlideCount
    : undefined;
};

const speakerNotesModeFrom = (request: ModelRequest): SpeakerNotesMode => {
  if (typeof request.input !== "object" || request.input === null || !("speakerNotesMode" in request.input)) {
    return normalizeSpeakerNotesMode(undefined);
  }
  return normalizeSpeakerNotesMode((request.input as { speakerNotesMode?: unknown }).speakerNotesMode);
};

const outlineSlidesFrom = (request: ModelRequest): AgentOutlineSlide[] | undefined => {
  if (typeof request.input !== "object" || request.input === null || !("outline" in request.input)) {
    return undefined;
  }

  const outline = (request.input as { outline?: unknown }).outline;
  if (typeof outline !== "object" || outline === null || !("slides" in outline)) {
    return undefined;
  }

  const slides = (outline as { slides?: unknown }).slides;
  return Array.isArray(slides) ? slides as AgentOutlineSlide[] : undefined;
};

const createOutlineSlides = (count: number): AgentOutlineSlide[] => {
  if (count === defaultOutlineSlides.length) {
    return defaultOutlineSlides.map((slide) => ({ ...slide }));
  }

  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    const idPrefix = String(position).padStart(3, "0");
    if (index === 0) {
      return { ...defaultOutlineSlides[0] };
    }
    if (index === count - 1) {
      return {
        id: `${idPrefix}-review`,
        title: "Reviewable outputs",
        kind: "closing",
        goal: "Summarize files, checks, exports, and next actions."
      };
    }
    if (index === 1) {
      return { ...defaultOutlineSlides[1] };
    }
    return {
      id: `${idPrefix}-detail`,
      title: `Supporting detail ${position - 1}`,
      kind: "content",
      goal: `Develop supporting point ${position - 1} with concise, reviewable evidence.`
    };
  });
};

export class MockModelProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly #failStages: Set<AgentRunStage>;
  readonly #hangStages: Set<AgentRunStage>;
  readonly #delayMs: number | ((stage: AgentRunStage) => number);
  readonly #checkResults?: AgentCheckResult[];
  readonly #exportResult?: AgentExportResult;
  readonly #checkCallsByRun = new Map<string, number>();

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "htmlslide-mock";
    this.label = options.label ?? "HTMLslide Mock Provider";
    this.#failStages = new Set(options.failStages ?? []);
    this.#hangStages = new Set(options.hangStages ?? []);
    this.#delayMs = options.delayMs ?? 0;
    this.#checkResults = options.checkResults;
    this.#exportResult = options.exportResult;
  }

  async validateCredentials() {
    return {
      ok: true as const,
      providerId: this.id,
      message: "Mock provider does not require credentials."
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.#hangStages.has(request.stage)) {
      return new Promise<ModelResponse>(() => undefined);
    }

    const delay = typeof this.#delayMs === "function" ? this.#delayMs(request.stage) : this.#delayMs;
    await waitFor(delay, request.signal, request.stage);

    if (this.#failStages.has(request.stage)) {
      throw new Error(`Mock provider failed during ${request.stage}.`);
    }

    switch (request.stage) {
      case "brief":
        return this.#response(request, "Normalized mock brief.", this.#briefOutput(request));
      case "outline":
        return this.#response(request, "Generated deterministic mock outline.", this.#outlineOutput(request));
      case "visual-direction":
        return this.#response(
          request,
          "Generated deterministic mock visual directions.",
          this.#visualDirectionOutput(request)
        );
      case "build":
        return this.#response(request, "Generated deterministic mock deck source files.", this.#buildOutput(request));
      case "check":
        return this.#response(request, "Produced deterministic mock check report.", this.#checkOutput(request.runId));
      case "repair":
        return this.#response(request, "Applied deterministic mock repair.", this.#repairOutput(request));
      case "export":
        return this.#response(request, "Generated deterministic mock export artifact list.", this.#exportOutput());
      case "review":
        return this.#response(request, "Prepared deterministic mock review summary.", this.#reviewOutput(request));
    }
  }

  #response<TOutput>(request: ModelRequest, content: string, output: TOutput): ModelResponse<TOutput> {
    return {
      content,
      output,
      metadata: {
        providerId: this.id,
        stage: request.stage
      }
    };
  }

  #briefOutput(request: ModelRequest): NormalizedBrief {
    return {
      title: mockTitle,
      brief: asBriefText(request),
      language: "en-US",
      audience: "technical reviewers",
      durationMinutes: 8
    };
  }

  #outlineOutput(request: ModelRequest): AgentOutline {
    const slides = createOutlineSlides(targetSlideCountFrom(request) ?? defaultOutlineSlides.length);
    return {
      title: mockTitle,
      language: "en-US",
      audience: "technical reviewers",
      durationMinutes: 8,
      slides
    };
  }

  #visualDirectionOutput(request: ModelRequest): VisualDirectionSet {
    const outlineSlides = outlineSlidesFrom(request) ?? defaultOutlineSlides;
    const slideIds = outlineSlides.map((slide) => slide.id);
    const slidesById = new Map(outlineSlides.map((slide) => [slide.id, slide]));
    const sampleSlidesFor = (ids: string[]): VisualDirectionSample[] => ids.slice(0, 3).map((id, index, samples) => {
      const source = slidesById.get(id);
      const kind: VisualDirectionSample["kind"] = index === 0
        ? "title"
        : index === samples.length - 1
          ? "data"
          : "content";
      return {
        body: source?.goal ?? "A focused point in the story.",
        chartValues: kind === "data" ? [38, 62, 48, 86] : [],
        id,
        kind,
        metric: kind === "data" ? "+42%" : "",
        title: source?.title ?? id
      };
    });
    return {
      directions: [
        {
          id: "direction-editorial",
          label: "Editorial Light",
          rationale: "High contrast typography, compact cards, and calm review surfaces.",
          sampleSlideIds: slideIds.slice(0, 3),
          sampleSlides: sampleSlidesFor(slideIds.slice(0, 3)),
          tokens: {
            background: "#fbfbfd",
            text: "#171923",
            accent: "#2357d9"
          }
        },
        {
          id: "direction-systems",
          label: "Systems Console",
          rationale: "Dense operational layout with status rails and issue summaries.",
          sampleSlideIds: slideIds.slice(-3),
          sampleSlides: sampleSlidesFor(slideIds.slice(-3)),
          tokens: {
            background: "#f4f6f8",
            text: "#111827",
            accent: "#0f766e"
          }
        }
      ],
      selectedDirectionId: "direction-editorial"
    };
  }

  #buildOutput(request: ModelRequest): AgentBuildResult {
    const speakerNotesMode = speakerNotesModeFrom(request);
    const slideIds = outlineSlidesFrom(request)?.map((slide) => slide.id) ?? defaultOutlineSlides.map((slide) => slide.id);
    const slidePaths = slideIds.map((slideId) => `slides/${slideId}.html`);
    const notePaths = speakerNotesMode === "none" ? [] : slideIds.map((slideId) => `notes/${slideId}.md`);
    return {
      filesChanged: [
        "deck.json",
        "theme/theme.css",
        "theme/tokens.json",
        ...slidePaths,
        ...notePaths
      ],
      slidesChanged: slideIds,
      notesChanged: notePaths,
      themeChanged: ["theme/theme.css", "theme/tokens.json"]
    };
  }

  #checkOutput(runId: string): AgentCheckResult {
    const callIndex = this.#checkCallsByRun.get(runId) ?? 0;
    this.#checkCallsByRun.set(runId, callIndex + 1);

    if (this.#checkResults !== undefined) {
      return this.#checkResults[Math.min(callIndex, this.#checkResults.length - 1)] ?? createMockPassedCheck();
    }

    return callIndex === 0 ? createMockFailedCheck() : createMockPassedCheck();
  }

  #repairOutput(request: ModelRequest): AgentRepairResult {
    const speakerNotesMode = speakerNotesModeFrom(request);
    return {
      attempt: repairAttemptFrom(request),
      filesChanged: speakerNotesMode === "none"
        ? ["slides/002-workflow.html"]
        : ["slides/002-workflow.html", "notes/002-workflow.md"],
      issuesAddressed: speakerNotesMode === "none"
        ? ["text-overflow"]
        : ["text-overflow", "missing-speaker-note-detail"]
    };
  }

  #exportOutput(): AgentExportResult {
    if (this.#exportResult !== undefined) {
      return this.#exportResult;
    }

    return {
      artifacts: [
        {
          type: "pdf",
          path: "exports/mock-htmlslide-deck.pdf"
        },
        {
          type: "html",
          path: "exports/mock-htmlslide-deck.html"
        },
        {
          type: "deckpkg",
          path: "exports/mock-htmlslide-deck.deckpkg"
        },
        {
          type: "speaker-notes",
          path: "exports/notes.json"
        }
      ]
    };
  }

  #reviewOutput(request: ModelRequest): AgentReviewResult {
    const input = typeof request.input === "object" && request.input !== null ? request.input as {
      build?: { filesChanged?: unknown };
    } : undefined;
    const generatedFiles = Array.isArray(input?.build?.filesChanged) &&
      input.build.filesChanged.every((filePath) => typeof filePath === "string")
      ? input.build.filesChanged as string[]
      : [];
    return {
      summary: "Mock deck is ready for human review with one repair pass and deterministic exports.",
      filesChanged: generatedFiles,
      issuesRemaining: 0,
      nextActions: ["Review thumbnails", "Check presenter notes", "Export final PDF"]
    };
  }
}

export const createMockProvider = (options?: MockProviderOptions): MockModelProvider => new MockModelProvider(options);
