import type { AgentStage, OnboardingStep, ProjectSummary, QaIssue, SlideSummary } from "./model";

export const onboardingSteps: OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome to HTMLslide",
    description: "Set up a local-first workbench for AI-generated HTML and PDF decks.",
    optionalAction: "Skip into No AI mode"
  },
  {
    id: "workspace",
    title: "Choose workspace",
    description: "Pick the folder where projects, sources, reports, and exports live.",
    optionalAction: "Use default folder"
  },
  {
    id: "engine",
    title: "Choose AI engine",
    description: "Connect BYOK providers later or start with mock generation now.",
    optionalAction: "Continue without AI"
  },
  {
    id: "cli",
    title: "Install CLI integration",
    description: "Expose htmlslide commands for project checks, exports, and doctor reports.",
    optionalAction: "Skip CLI install"
  },
  {
    id: "skills",
    title: "Install official skills",
    description: "Add deck generation, QA repair, and export review skills for agent runs.",
    optionalAction: "Install later"
  },
  {
    id: "ready",
    title: "Ready",
    description: "Open the project library and start from a deck, template, or folder.",
    optionalAction: "Go to library"
  }
];

export const projects: ProjectSummary[] = [
  {
    id: "demo-alpha",
    title: "Investor Demo Alpha",
    path: "~/Documents/HTMLslide/investor-demo",
    lastOpened: "Today, 10:24",
    status: "Needs check",
    slideCount: 12
  },
  {
    id: "product-review",
    title: "Q3 Product Review",
    path: "~/Work/reviews/q3-product",
    lastOpened: "Yesterday, 18:05",
    status: "Ready",
    slideCount: 18
  },
  {
    id: "field-guide",
    title: "Workshop Field Guide",
    path: "~/Workshops/htmlslide-field-guide",
    lastOpened: "Mon, 14:12",
    status: "External changes detected",
    slideCount: 9
  },
  {
    id: "launch-memo",
    title: "Launch Memo Export",
    path: "~/Documents/HTMLslide/launch-memo",
    lastOpened: "Jul 7, 09:40",
    status: "Export failed",
    slideCount: 7
  }
];

export const slides: SlideSummary[] = [
  {
    id: "slide-01",
    number: "01",
    title: "AI-native pitch studio",
    section: "Title",
    status: "ready",
    duration: "0:45",
    accent: "#315fcb",
    speakerNotes:
      "Open by framing HTMLslide as a local-first workbench for generating, checking, exporting, and presenting decks.",
    bullets: ["Local-first project folders", "HTML/PDF export loop", "Agent-readable QA reports"]
  },
  {
    id: "slide-02",
    number: "02",
    title: "Deck work is fragmented",
    section: "Problem",
    status: "needs-check",
    duration: "1:10",
    accent: "#9a6410",
    speakerNotes:
      "Describe how deck creation, QA, and export are split across tools that do not preserve agent context.",
    bullets: ["Manual design reviews", "Lost source provenance", "Exports drift from source"]
  },
  {
    id: "slide-03",
    number: "03",
    title: "Local agent loop",
    section: "Solution",
    status: "ready",
    duration: "1:00",
    accent: "#267a4f",
    speakerNotes:
      "Walk through the brief, outline, visual direction, build, check, repair, export, and review loop.",
    bullets: ["Deterministic project spec", "Structured run timeline", "Repairable issue reports"]
  },
  {
    id: "slide-04",
    number: "04",
    title: "Preview, check, repair",
    section: "Demo",
    status: "blocked",
    duration: "1:25",
    accent: "#bc3a3a",
    speakerNotes:
      "Show a slide with intentional QA issues and explain how the inspector turns findings into action.",
    bullets: ["Fixed 16:9 review canvas", "Per-slide QA badges", "Fix with AI actions"]
  },
  {
    id: "slide-05",
    number: "05",
    title: "Export and present",
    section: "Output",
    status: "ready",
    duration: "0:50",
    accent: "#286a8d",
    speakerNotes:
      "Close with the PDF, deckpkg, and presenter-mode path from the same project state.",
    bullets: ["PDF and thumbnails", "deckpkg manifest", "Presenter notes alignment"]
  }
];

export const qaIssues: QaIssue[] = [
  {
    id: "qa-001",
    slideId: "slide-02",
    severity: "warning",
    type: "body-too-dense",
    message: "Body copy density is above the recommended reading threshold.",
    selector: ".slide-problem .body",
    measurement: "42 words in primary body region",
    suggestedFix: "Split the last two proof points into speaker notes or a follow-up slide."
  },
  {
    id: "qa-002",
    slideId: "slide-04",
    severity: "error",
    type: "safe-area-violation",
    message: "The lower caption falls outside the 72 px safe area.",
    selector: ".slide-demo .caption",
    measurement: "18 px below safe bottom",
    suggestedFix: "Move the caption upward or reduce the preview stack height."
  },
  {
    id: "qa-003",
    slideId: "slide-04",
    severity: "error",
    type: "missing-asset",
    message: "Referenced chart image is not available in the project assets folder.",
    selector: "img[data-asset='run-timeline.png']",
    measurement: "assets/run-timeline.png missing",
    suggestedFix: "Regenerate the thumbnail or relink the source asset."
  },
  {
    id: "qa-004",
    slideId: "slide-03",
    severity: "suggestion",
    type: "title-too-long",
    message: "Slide title is close to the upper length bound for presenter view.",
    selector: "h1",
    measurement: "23 characters",
    suggestedFix: "Consider shortening to “Agent loop” if the presenter display wraps."
  },
  {
    id: "qa-005",
    slideId: "slide-05",
    severity: "warning",
    type: "export-outdated",
    message: "PDF export timestamp predates the current deck manifest.",
    selector: "exports/demo.pdf",
    measurement: "Manifest is 14 minutes newer",
    suggestedFix: "Run Export after the next successful Check."
  }
];

export const agentStages: AgentStage[] = [
  {
    id: "plan",
    label: "Plan",
    summary: "Read brief, source paths, and export target.",
    filesChanged: "0",
    issuesFound: "0",
    nextAction: "Draft outline",
    logs: ["Loaded deck.json", "Confirmed local No AI mode fallback"]
  },
  {
    id: "outline",
    label: "Outline",
    summary: "Mapped five-slide narrative with presenter timing.",
    filesChanged: "1",
    issuesFound: "0",
    nextAction: "Choose visual direction",
    logs: ["Updated slides/outline.json", "Preserved slide ids"]
  },
  {
    id: "visual",
    label: "Visual direction",
    summary: "Selected calm neutral theme with restrained QA colors.",
    filesChanged: "2",
    issuesFound: "1 suggestion",
    nextAction: "Build slide HTML",
    logs: ["Resolved token set", "Queued title length suggestion"]
  },
  {
    id: "build",
    label: "Build",
    summary: "Rendered HTML slides and refreshed thumbnails.",
    filesChanged: "8",
    issuesFound: "0",
    nextAction: "Run checker",
    logs: ["Built slide-01.html", "Built slide-05.html"]
  },
  {
    id: "check",
    label: "Check",
    summary: "Ran safe area, asset, contrast, and notes checks.",
    filesChanged: "1",
    issuesFound: "2 errors, 2 warnings",
    nextAction: "Repair blocking issues",
    logs: ["safe-area-violation on slide-04", "missing-asset on slide-04"]
  },
  {
    id: "repair",
    label: "Repair",
    summary: "Prepared fixes for caption placement and missing timeline asset.",
    filesChanged: "2",
    issuesFound: "0",
    nextAction: "Export PDF",
    logs: ["Moved caption into safe area", "Regenerated run-timeline.png"]
  },
  {
    id: "export",
    label: "Export",
    summary: "Queued PDF, thumbnails, and deckpkg outputs.",
    filesChanged: "3",
    issuesFound: "0",
    nextAction: "Review final report",
    logs: ["Wrote exports/demo.pdf", "Wrote exports/demo.deckpkg"]
  },
  {
    id: "review",
    label: "Review",
    summary: "Final report ready for presenter rehearsal.",
    filesChanged: "0",
    issuesFound: "0",
    nextAction: "Open presenter mode",
    logs: ["report.json clean", "Presenter notes aligned"]
  }
];
