import { AgentRunCancelledError } from "./errors.js";
import type {
  AgentBuildResult,
  AgentCheckResult,
  AgentOutline,
  AgentRepairResult,
  AgentRunStage,
  AgentExportResult,
  AgentReviewResult,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  NormalizedBrief,
  VisualDirectionSet
} from "./types.js";

export type MockProviderOptions = {
  id?: string;
  label?: string;
  failStages?: AgentRunStage[];
  delayMs?: number | ((stage: AgentRunStage) => number);
  checkResults?: AgentCheckResult[];
};

const mockTitle = "Mock HTMLslide Deck";

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

export class MockModelProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly #failStages: Set<AgentRunStage>;
  readonly #delayMs: number | ((stage: AgentRunStage) => number);
  readonly #checkResults?: AgentCheckResult[];
  readonly #checkCallsByRun = new Map<string, number>();

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "htmlslide-mock";
    this.label = options.label ?? "HTMLslide Mock Provider";
    this.#failStages = new Set(options.failStages ?? []);
    this.#delayMs = options.delayMs ?? 0;
    this.#checkResults = options.checkResults;
  }

  async validateCredentials() {
    return {
      ok: true as const,
      providerId: this.id,
      message: "Mock provider does not require credentials."
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const delay = typeof this.#delayMs === "function" ? this.#delayMs(request.stage) : this.#delayMs;
    await waitFor(delay, request.signal, request.stage);

    if (this.#failStages.has(request.stage)) {
      throw new Error(`Mock provider failed during ${request.stage}.`);
    }

    switch (request.stage) {
      case "brief":
        return this.#response(request, "Normalized mock brief.", this.#briefOutput(request));
      case "outline":
        return this.#response(request, "Generated deterministic mock outline.", this.#outlineOutput());
      case "visual-direction":
        return this.#response(
          request,
          "Generated deterministic mock visual directions.",
          this.#visualDirectionOutput()
        );
      case "build":
        return this.#response(request, "Generated deterministic mock deck source files.", this.#buildOutput());
      case "check":
        return this.#response(request, "Produced deterministic mock check report.", this.#checkOutput(request.runId));
      case "repair":
        return this.#response(request, "Applied deterministic mock repair.", this.#repairOutput(request));
      case "export":
        return this.#response(request, "Generated deterministic mock export artifact list.", this.#exportOutput());
      case "review":
        return this.#response(request, "Prepared deterministic mock review summary.", this.#reviewOutput());
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

  #outlineOutput(): AgentOutline {
    return {
      title: mockTitle,
      language: "en-US",
      audience: "technical reviewers",
      durationMinutes: 8,
      slides: [
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
      ]
    };
  }

  #visualDirectionOutput(): VisualDirectionSet {
    return {
      directions: [
        {
          id: "direction-editorial",
          label: "Editorial Light",
          rationale: "High contrast typography, compact cards, and calm review surfaces.",
          sampleSlideIds: ["001-title", "002-workflow"],
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
          sampleSlideIds: ["002-workflow", "003-review"],
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

  #buildOutput(): AgentBuildResult {
    return {
      filesChanged: [
        "deck.json",
        "theme/theme.css",
        "slides/001-title.html",
        "slides/002-workflow.html",
        "slides/003-review.html",
        "notes/001-title.md",
        "notes/002-workflow.md",
        "notes/003-review.md"
      ],
      slidesChanged: ["001-title", "002-workflow", "003-review"],
      notesChanged: ["001-title", "002-workflow", "003-review"],
      themeChanged: ["theme/theme.css"]
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
    return {
      attempt: repairAttemptFrom(request),
      filesChanged: ["slides/002-workflow.html", "notes/002-workflow.md"],
      issuesAddressed: ["text-overflow", "missing-speaker-note-detail"]
    };
  }

  #exportOutput(): AgentExportResult {
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

  #reviewOutput(): AgentReviewResult {
    return {
      summary: "Mock deck is ready for human review with one repair pass and deterministic exports.",
      filesChanged: [
        "deck.json",
        "theme/theme.css",
        "slides/001-title.html",
        "slides/002-workflow.html",
        "slides/003-review.html",
        "notes/001-title.md",
        "notes/002-workflow.md",
        "notes/003-review.md"
      ],
      issuesRemaining: 0,
      nextActions: ["Review thumbnails", "Check presenter notes", "Export final PDF"]
    };
  }
}

export const createMockProvider = (options?: MockProviderOptions): MockModelProvider => new MockModelProvider(options);
