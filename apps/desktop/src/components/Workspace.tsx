import {
  Button,
  IconButton,
  PanelHeader,
  SegmentedTabs,
  StatusPill,
  inspectorTabLabels,
  qaSeverityLabels,
  qaSeverityTones,
  toolbarActionLabels
} from "@htmlslide/shared-ui";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Download,
  FileText,
  Maximize2,
  MessageSquareText,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Upload
} from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import {
  buildRuntimeStages,
  countIssuesBySeverity,
  filterQaIssues
} from "../model";
import type {
  AgentStage,
  InspectorTab,
  OperationStatus,
  ProjectSummary,
  QaFilter,
  QaIssue,
  SlideSummary
} from "../model";

interface WorkspaceProps {
  activeStageIndex: number;
  commandValue: string;
  inspectorTab: InspectorTab;
  project: ProjectSummary;
  qaFilter: QaFilter;
  qaIssues: QaIssue[];
  running: boolean;
  selectedSlideId: string;
  slides: SlideSummary[];
  stages: AgentStage[];
  operationStatus: OperationStatus;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onQaFilterChange: (filter: QaFilter) => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
  onSelectSlide: (slideId: string) => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
}

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "outline", label: inspectorTabLabels.outline },
  { id: "design", label: inspectorTabLabels.design },
  { id: "notes", label: inspectorTabLabels.notes },
  { id: "qa", label: inspectorTabLabels.qa },
  { id: "export", label: inspectorTabLabels.export }
];

const filterTabs: Array<{ id: QaFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "error", label: qaSeverityLabels.error },
  { id: "warning", label: qaSeverityLabels.warning },
  { id: "suggestion", label: qaSeverityLabels.suggestion }
];

function slideStatusTone(status: SlideSummary["status"]): "success" | "warning" | "danger" {
  if (status === "ready") {
    return "success";
  }

  if (status === "blocked") {
    return "danger";
  }

  return "warning";
}

function toolbarIcon(action: keyof typeof toolbarActionLabels): ReactNode {
  const icons = {
    check: <ShieldCheck />,
    export: <Upload />,
    generate: <Sparkles />,
    present: <MonitorPlay />
  };

  return icons[action];
}

export function Workspace({
  activeStageIndex,
  commandValue,
  inspectorTab,
  onCommandChange,
  onCommandSubmit,
  onInspectorTabChange,
  onQaFilterChange,
  onRunAction,
  onSelectSlide,
  onToolbarAction,
  operationStatus,
  project,
  qaFilter,
  qaIssues,
  running,
  selectedSlideId,
  slides,
  stages
}: WorkspaceProps): ReactNode {
  const currentSlide = slides.find((slide) => slide.id === selectedSlideId) ?? slides[0];
  const selectedSlideIssues = filterQaIssues(qaIssues, "all", selectedSlideId);
  const selectedIssues = filterQaIssues(qaIssues, qaFilter, selectedSlideId);
  const issueCounts = countIssuesBySeverity(qaIssues);
  const selectedIssueCounts = countIssuesBySeverity(selectedSlideIssues);
  const runtimeStages = buildRuntimeStages(stages, activeStageIndex, running);

  if (!currentSlide) {
    return null;
  }

  return (
    <main className="workspace-shell">
      <Toolbar
        issueCounts={issueCounts}
        onInspectorTabChange={onInspectorTabChange}
        onRunAction={onRunAction}
        onToolbarAction={onToolbarAction}
        operationStatus={operationStatus}
        project={project}
        running={running}
      />

      <section className="workspace-body">
        <Filmstrip
          issues={qaIssues}
          onSelectSlide={onSelectSlide}
          selectedSlideId={selectedSlideId}
          slides={slides}
        />

        <PreviewCanvas
          issueCount={selectedIssues.length}
          slide={currentSlide}
        />

        <Inspector
          activeTab={inspectorTab}
          currentSlide={currentSlide}
          issueCounts={selectedIssueCounts}
          issues={selectedIssues}
          onQaFilterChange={onQaFilterChange}
          onToolbarAction={onToolbarAction}
          operationStatus={operationStatus}
          onTabChange={onInspectorTabChange}
          qaFilter={qaFilter}
        />
      </section>

      <AgentRunConsole
        commandValue={commandValue}
        onCommandChange={onCommandChange}
        onCommandSubmit={onCommandSubmit}
        onRunAction={onRunAction}
        running={running}
        stages={runtimeStages}
      />
    </main>
  );
}

interface ToolbarProps {
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  operationStatus: OperationStatus;
  project: ProjectSummary;
  running: boolean;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
}

function Toolbar({
  issueCounts,
  onInspectorTabChange,
  onRunAction,
  onToolbarAction,
  operationStatus,
  project,
  running
}: ToolbarProps): ReactNode {
  return (
    <header className="workspace-toolbar">
      <div className="workspace-title">
        <span className="brand-mark">Hs</span>
        <div>
          <strong>{project.title}</strong>
          <span>{project.path}</span>
        </div>
      </div>

      <div className="toolbar-actions">
        {(["generate", "check", "export", "present"] as const).map((action) => (
          <Button
            icon={toolbarIcon(action)}
            key={action}
            onClick={() => {
              if (action === "generate") {
                onRunAction("start");
              }

              if (action === "check") {
                onInspectorTabChange("qa");
              }

              if (action === "export") {
                onInspectorTabChange("export");
              }

              onToolbarAction(action);
            }}
            variant={action === "generate" ? "primary" : "secondary"}
          >
            {toolbarActionLabels[action]}
          </Button>
        ))}
      </div>

      <div className="toolbar-status">
        <StatusPill tone={running ? "info" : "warning"}>
          {running ? "Agent running" : "Needs check"}
        </StatusPill>
        <StatusPill tone={issueCounts.error > 0 ? "danger" : "success"}>
          {issueCounts.error} blocking
        </StatusPill>
        <StatusPill tone={operationStatus.kind === "failed" ? "danger" : operationStatus.kind === "success" ? "success" : "info"}>
          {operationStatus.message}
        </StatusPill>
        <IconButton
          icon={<Settings2 />}
          label="Workspace settings"
        />
      </div>
    </header>
  );
}

interface FilmstripProps {
  issues: QaIssue[];
  selectedSlideId: string;
  slides: SlideSummary[];
  onSelectSlide: (slideId: string) => void;
}

function Filmstrip({
  issues,
  onSelectSlide,
  selectedSlideId,
  slides
}: FilmstripProps): ReactNode {
  return (
    <aside className="filmstrip">
      <PanelHeader
        actions={<IconButton icon={<ChevronDown />} label="Sort slides" />}
        title="Slides"
      />
      <div className="filmstrip-list">
        {slides.map((slide) => {
          const slideIssues = issues.filter((issue) => issue.slideId === slide.id);
          const selected = slide.id === selectedSlideId;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={selected ? "filmstrip-item is-selected" : "filmstrip-item"}
              key={slide.id}
              onClick={() => onSelectSlide(slide.id)}
              type="button"
            >
              <span
                className="filmstrip-item__thumb"
                style={{ "--slide-accent": slide.accent } as CSSProperties}
              >
                <strong>{slide.number}</strong>
              </span>
              <span className="filmstrip-item__meta">
                <strong>{slide.title}</strong>
                <small>{slide.section}</small>
              </span>
              {slideIssues.length > 0 ? (
                <span className="filmstrip-item__badge">{slideIssues.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

interface PreviewCanvasProps {
  issueCount: number;
  slide: SlideSummary;
}

function PreviewCanvas({ issueCount, slide }: PreviewCanvasProps): ReactNode {
  const hasSourcePreview = Boolean(slide.html && slide.html.trim().length > 0);

  return (
    <section className="preview-stage">
      <div className="preview-topbar">
        <div>
          <strong>{slide.number} / Review Canvas</strong>
          <span>Fixed 16:9 preview, not an editor</span>
        </div>
        <div className="preview-actions">
          <StatusPill tone={slideStatusTone(slide.status)}>{slide.status.replace("-", " ")}</StatusPill>
          <IconButton
            icon={<Maximize2 />}
            label="Fit preview"
          />
        </div>
      </div>

      <div className="slide-canvas-wrap">
        <article
          aria-label={`${slide.title} slide preview`}
          className={hasSourcePreview ? "slide-canvas slide-canvas--source" : "slide-canvas"}
          style={{ "--slide-accent": slide.accent } as CSSProperties}
        >
          {hasSourcePreview ? (
            <div
              className="slide-fragment-preview"
              dangerouslySetInnerHTML={{ __html: slide.html ?? "" }}
            />
          ) : (
            <>
              <header>
                <span>{slide.section}</span>
                <strong>{slide.duration}</strong>
              </header>
              <section>
                <h1>{slide.title}</h1>
                <ul>
                  {slide.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </section>
              <div className="slide-visual">
                <div className="slide-visual__bars">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="slide-visual__card">
                  <Clock3 />
                  <strong>{issueCount} QA notes</strong>
                  <small>Current slide filter</small>
                </div>
              </div>
            </>
          )}
          {hasSourcePreview ? (
            <div className="slide-source-status">
              <Clock3 />
              <strong>{issueCount} QA notes</strong>
              <small>{slide.sourcePath}</small>
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}

interface InspectorProps {
  activeTab: InspectorTab;
  currentSlide: SlideSummary;
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  issues: QaIssue[];
  operationStatus: OperationStatus;
  qaFilter: QaFilter;
  onQaFilterChange: (filter: QaFilter) => void;
  onTabChange: (tab: InspectorTab) => void;
  onToolbarAction: (action: "generate" | "check" | "export" | "present") => void;
}

function Inspector({
  activeTab,
  currentSlide,
  issueCounts,
  issues,
  onQaFilterChange,
  onToolbarAction,
  operationStatus,
  onTabChange,
  qaFilter
}: InspectorProps): ReactNode {
  return (
    <aside className="inspector">
      <SegmentedTabs
        activeTab={activeTab}
        label="Inspector tabs"
        onChange={onTabChange}
        tabs={inspectorTabs}
      />
      <div className="inspector-body">
        {activeTab === "outline" ? <OutlinePanel slide={currentSlide} /> : null}
        {activeTab === "design" ? <DesignPanel slide={currentSlide} /> : null}
        {activeTab === "notes" ? <NotesPanel slide={currentSlide} /> : null}
        {activeTab === "qa" ? (
          <QaPanel
            issueCounts={issueCounts}
            issues={issues}
            onQaFilterChange={onQaFilterChange}
            qaFilter={qaFilter}
          />
        ) : null}
        {activeTab === "export" ? (
          <ExportPanel
            issueCounts={issueCounts}
            onExport={() => onToolbarAction("export")}
            operationStatus={operationStatus}
          />
        ) : null}
      </div>
    </aside>
  );
}

function OutlinePanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader
        eyebrow={slide.section}
        title="Outline"
      />
      <ol className="outline-list">
        {slide.bullets.map((bullet, index) => (
          <li key={bullet}>
            <span>{index + 1}</span>
            <p>{bullet}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DesignPanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader title="Design Tokens" />
      <div className="token-grid">
        <span>
          <i style={{ background: slide.accent }} />
          Accent
        </span>
        <span>
          <i style={{ background: "#1d2530" }} />
          Text
        </span>
        <span>
          <i style={{ background: "#f5f7fb" }} />
          App bg
        </span>
      </div>
      <label className="field-row">
        <span>Safe area</span>
        <select defaultValue="standard">
          <option value="standard">Standard 72 px</option>
          <option value="tight">Tight 48 px</option>
        </select>
      </label>
      <label className="field-row">
        <span>Typography</span>
        <select defaultValue="system">
          <option value="system">System UI</option>
          <option value="serif">Editorial serif</option>
        </select>
      </label>
    </section>
  );
}

function NotesPanel({ slide }: { slide: SlideSummary }): ReactNode {
  return (
    <section className="inspector-section">
      <PanelHeader title="Presenter Notes" />
      <textarea
        aria-label="Presenter notes"
        defaultValue={slide.speakerNotes}
        rows={9}
      />
      <div className="notes-meta">
        <StatusPill tone="info">{slide.duration}</StatusPill>
        <span>Readable in rehearsal mode</span>
      </div>
    </section>
  );
}

interface QaPanelProps {
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  issues: QaIssue[];
  qaFilter: QaFilter;
  onQaFilterChange: (filter: QaFilter) => void;
}

function QaPanel({
  issueCounts,
  issues,
  onQaFilterChange,
  qaFilter
}: QaPanelProps): ReactNode {
  return (
    <section className="inspector-section qa-panel">
      <PanelHeader
        actions={<StatusPill tone={issueCounts.error > 0 ? "danger" : "success"}>{issueCounts.error} errors</StatusPill>}
        title="QA Panel"
      />
      <SegmentedTabs
        activeTab={qaFilter}
        label="QA severity filter"
        onChange={onQaFilterChange}
        tabs={filterTabs.map((tab) => ({
          ...tab,
          count: tab.id === "all" ? issues.length : issueCounts[tab.id]
        }))}
      />
      <div className="qa-issue-list">
        {issues.length === 0 ? (
          <div className="empty-state">
            <CheckCircle2 />
            <strong>No issues in this filter</strong>
            <span>Run Check to refresh the report.</span>
          </div>
        ) : (
          issues.map((issue) => (
            <article
              className="qa-issue"
              key={issue.id}
            >
              <div className="qa-issue__thumb">{issue.slideId.replace("slide-", "")}</div>
              <div>
                <StatusPill tone={qaSeverityTones[issue.severity]}>{issue.severity}</StatusPill>
                <h3>{issue.type}</h3>
                <p>{issue.message}</p>
                <dl>
                  <div>
                    <dt>Location</dt>
                    <dd>{issue.selector}</dd>
                  </div>
                  <div>
                    <dt>Measurement</dt>
                    <dd>{issue.measurement}</dd>
                  </div>
                </dl>
                <small>{issue.suggestedFix}</small>
                <div className="qa-issue__actions">
                  <Button
                    size="sm"
                    variant="primary"
                  >
                    Fix with AI
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                  >
                    Ignore once
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                  >
                    Ignore rule
                  </Button>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function ExportPanel({
  issueCounts,
  onExport,
  operationStatus
}: {
  issueCounts: Record<"error" | "warning" | "suggestion", number>;
  operationStatus: OperationStatus;
  onExport: () => void;
}): ReactNode {
  const blocked = issueCounts.error > 0;

  return (
    <section className="inspector-section">
      <PanelHeader title="Export" />
      <div className="export-stack">
        <label className="check-row">
          <input
            defaultChecked
            type="checkbox"
          />
          <span>PDF</span>
        </label>
        <label className="check-row">
          <input
            defaultChecked
            type="checkbox"
          />
          <span>PNG thumbnails</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
          />
          <span>deckpkg</span>
        </label>
        <Button
          disabled={blocked}
          icon={<Download />}
          onClick={onExport}
          variant="primary"
        >
          Export PDF
        </Button>
        <StatusPill tone={blocked ? "danger" : "success"}>
          {blocked ? "Blocked by QA" : "Ready to export"}
        </StatusPill>
        <p className="export-status">{operationStatus.message}</p>
      </div>
    </section>
  );
}

interface AgentRunConsoleProps {
  commandValue: string;
  running: boolean;
  stages: ReturnType<typeof buildRuntimeStages>;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onRunAction: (action: "start" | "pause" | "cancel" | "retry") => void;
}

function AgentRunConsole({
  commandValue,
  onCommandChange,
  onCommandSubmit,
  onRunAction,
  running,
  stages
}: AgentRunConsoleProps): ReactNode {
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onCommandSubmit();
  };

  return (
    <footer className="agent-console">
      <section className="agent-console__timeline">
        {stages.map((stage) => (
          <article
            className={`agent-stage is-${stage.status}`}
            key={stage.id}
          >
            <span className="agent-stage__dot">
              {stage.status === "complete" ? <CheckCircle2 /> : null}
              {stage.status === "running" ? <Activity /> : null}
              {stage.status === "queued" ? <CircleDot /> : null}
              {stage.status === "paused" ? <Pause /> : null}
            </span>
            <div>
              <strong>{stage.label}</strong>
              <p>{stage.summary}</p>
              <small>
                Files {stage.filesChanged} · Issues {stage.issuesFound} · Next {stage.nextAction}
              </small>
              <details>
                <summary>Logs</summary>
                {stage.logs.map((log) => (
                  <code key={log}>{log}</code>
                ))}
              </details>
            </div>
          </article>
        ))}
      </section>

      <section className="command-bar">
        <div className="command-bar__controls">
          <Button
            icon={running ? <Pause /> : <Play />}
            onClick={() => onRunAction(running ? "pause" : "start")}
            variant={running ? "secondary" : "primary"}
          >
            {running ? "Pause" : "Run"}
          </Button>
          <IconButton
            icon={<Square />}
            label="Cancel run"
            onClick={() => onRunAction("cancel")}
          />
          <IconButton
            icon={<RotateCcw />}
            label="Retry run"
            onClick={() => onRunAction("retry")}
          />
          <IconButton
            icon={<FileText />}
            label="View diff"
          />
          <IconButton
            icon={<TerminalSquare />}
            label="Open logs"
          />
        </div>
        <form onSubmit={handleSubmit}>
          <MessageSquareText />
          <input
            aria-label="Command bar"
            onChange={(event) => onCommandChange(event.currentTarget.value)}
            placeholder="Ask the agent to revise, check, repair, or export this deck"
            value={commandValue}
          />
          <Button
            icon={<Send />}
            size="sm"
            type="submit"
            variant="primary"
          >
            Send
          </Button>
        </form>
      </section>
    </footer>
  );
}
