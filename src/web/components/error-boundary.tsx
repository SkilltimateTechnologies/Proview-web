import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render-time exceptions so a crash shows a message instead of a blank page.
 *
 * Why this exists: students reported "blank pages" during a live exam, and
 * `rg -n ErrorBoundary src/web` returned ZERO matches — there was no boundary
 * anywhere in the app. React 19 unmounts the whole tree when a render throws, so
 * any uncaught error in any component left a white screen with no message and no
 * way back. Mid-exam, that is indistinguishable from the app being dead.
 *
 * Deliberately dependency-free and inline-styled: it must render even when the
 * failure is in the stylesheet, the theme provider, or a UI component it would
 * otherwise import.
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console only, on purpose. Shipping these to the server would mean a new
    // unauthenticated write endpoint (the student token is not always present
    // when the crash is in the login/boot path), which is an abuse surface not
    // worth opening for this fix. The message is rendered on screen below so an
    // invigilator can read it off the student's machine, and it stays in the
    // console for a support screen-share.
    console.error("[error-boundary] render failed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0f172a",
          color: "#f1f5f9",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: 520, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 10px" }}>This page hit an error</h1>
          {/* The reassurance that matters mid-exam: answers are saved locally and
              autosaved server-side, so reloading does not restart the paper. */}
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "#cbd5e1", margin: "0 0 20px" }}>
            Your answers are saved on this device and on the server. Reload to continue
            your exam from where you left off — your timer and answers are not lost.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "12px 22px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload and continue
          </button>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: "18px 0 0" }}>
            If this keeps happening, tell your invigilator and show them this message:
          </p>
          <code
            style={{
              display: "block",
              marginTop: 8,
              padding: "8px 10px",
              background: "#1e293b",
              borderRadius: 8,
              fontSize: 12,
              color: "#fca5a5",
              wordBreak: "break-word",
            }}
          >
            {String(error.message || error)}
          </code>
        </div>
      </div>
    );
  }
}
