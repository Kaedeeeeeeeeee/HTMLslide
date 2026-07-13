import React from "react";
import { Copy, RefreshCw, TriangleAlert } from "lucide-react";

export const SAFE_ERROR_SUMMARY = "HTMLslide desktop app encountered an unexpected rendering error.";

type CopyStatus = "idle" | "copied" | "failed";

type AppErrorBoundaryState = {
  hasError: boolean;
  copyStatus: CopyStatus;
};

export type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type ClipboardWriter = Pick<Clipboard, "writeText">;

export async function copyErrorSummary(clipboard?: ClipboardWriter): Promise<boolean> {
  try {
    const targetClipboard = clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
    if (!targetClipboard) {
      return false;
    }

    await targetClipboard.writeText(SAFE_ERROR_SUMMARY);
    return true;
  } catch {
    return false;
  }
}

const fallbackShellStyle: React.CSSProperties = {
  alignItems: "center",
  background: "var(--hs-bg)",
  display: "flex",
  height: "100%",
  justifyContent: "center",
  minHeight: "100%",
  padding: "32px"
};

const fallbackPanelStyle: React.CSSProperties = {
  background: "var(--hs-surface)",
  border: "1px solid var(--hs-line)",
  borderRadius: "var(--hs-radius-md)",
  boxShadow: "var(--hs-shadow-soft)",
  maxWidth: "520px",
  padding: "32px",
  width: "100%"
};

const fallbackIconStyle: React.CSSProperties = {
  alignItems: "center",
  background: "var(--hs-danger-soft)",
  borderRadius: "var(--hs-radius-sm)",
  color: "var(--hs-danger)",
  display: "inline-flex",
  height: "40px",
  justifyContent: "center",
  marginBottom: "20px",
  width: "40px"
};

const fallbackEyebrowStyle: React.CSSProperties = {
  color: "var(--hs-text-subtle)",
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0",
  margin: "0 0 8px"
};

const fallbackHeadingStyle: React.CSSProperties = {
  fontSize: "28px",
  lineHeight: 1.2,
  margin: 0
};

const fallbackDescriptionStyle: React.CSSProperties = {
  color: "var(--hs-text-muted)",
  fontSize: "15px",
  lineHeight: 1.55,
  margin: "14px 0 0"
};

const fallbackActionsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  marginTop: "26px"
};

const fallbackStatusStyle: React.CSSProperties = {
  color: "var(--hs-text-subtle)",
  fontSize: "12px",
  lineHeight: 1.4,
  margin: "14px 0 0"
};

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    copyStatus: "idle",
    hasError: false
  };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return {
      copyStatus: "idle",
      hasError: true
    };
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  private readonly handleCopy = (): void => {
    void copyErrorSummary().then(
      (copied) => {
        this.setState({ copyStatus: copied ? "copied" : "failed" });
      },
      () => {
        this.setState({ copyStatus: "failed" });
      }
    );
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copyStatusMessage = this.state.copyStatus === "copied"
      ? "Safe error summary copied."
      : this.state.copyStatus === "failed"
        ? "Could not copy the summary. Please try again."
        : "The summary is safe to share in a support report.";

    return (
      <main
        aria-labelledby="app-error-title"
        aria-describedby="app-error-description"
        role="alert"
        style={fallbackShellStyle}
      >
        <section style={fallbackPanelStyle}>
          <div aria-hidden="true" style={fallbackIconStyle}>
            <TriangleAlert size={22} strokeWidth={2} />
          </div>
          <p style={fallbackEyebrowStyle}>HTMLslide</p>
          <h1 id="app-error-title" style={fallbackHeadingStyle}>HTMLslide needs to restart</h1>
          <p id="app-error-description" style={fallbackDescriptionStyle}>
            The app ran into an unexpected problem while rendering this view. Reload the app to continue.
          </p>
          <div style={fallbackActionsStyle}>
            <button className="hs-button hs-button--md hs-button--primary" onClick={this.handleReload} type="button">
              <span aria-hidden="true" className="hs-button__icon">
                <RefreshCw size={15} strokeWidth={2.1} />
              </span>
              <span className="hs-button__label">Reload app</span>
            </button>
            <button className="hs-button hs-button--md hs-button--secondary" onClick={this.handleCopy} type="button">
              <span aria-hidden="true" className="hs-button__icon">
                <Copy size={15} strokeWidth={2.1} />
              </span>
              <span className="hs-button__label">Copy error summary</span>
            </button>
          </div>
          <p aria-live="polite" role="status" style={fallbackStatusStyle}>{copyStatusMessage}</p>
        </section>
      </main>
    );
  }
}
