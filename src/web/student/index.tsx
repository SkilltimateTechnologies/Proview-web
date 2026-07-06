import { Route, Switch, Redirect, Router } from "wouter";
import { SessionProvider, useSession } from "./lib/session";
import { Login } from "./pages/login";
import { Shell } from "./pages/shell";
import { ExamRunner } from "./pages/exam-runner";
import { Review } from "./pages/review";
import { ForcedChangePassword } from "./pages/change-password";
import "./student.css";

function Exit() {
  // SEB is configured to quit automatically when the browser reaches its quitURL
  // (this page). Landing here on any code path triggers the secure browser to close.
  // The button below is a manual fallback in case auto-quit is blocked.
  const quitSeb = () => {
    try { window.close(); } catch { /* ignore */ }
    window.location.replace(window.location.origin + "/student/exit");
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#0b1120", color: "#e6edf7", fontFamily: "system-ui, sans-serif", gap: 14, textAlign: "center", padding: 24 }}>
      <div style={{ fontSize: 44 }}>✓</div>
      <h1 style={{ fontSize: 24, margin: 0 }}>Session ended</h1>
      <p style={{ color: "#7d8ba0", maxWidth: 420, margin: 0 }}>You have signed out of the Proview secure exam client. The secure browser will close automatically.</p>
      <button onClick={quitSeb} style={{ marginTop: 10, background: "#1A3EBF", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Close secure browser</button>
      <a href="/student/login" style={{ marginTop: 4, color: "#5b8cff", textDecoration: "none", fontSize: 13 }}>Sign in again</a>
    </div>
  );
}

function Routes() {
  const { student } = useSession();

  if (!student) {
    return (
      <Switch>
        <Route path="/exit" component={Exit} />
        <Route path="/login" component={Login} />
        <Route>{() => <Redirect to="/login" />}</Route>
      </Switch>
    );
  }

  // First login with the issued password → force a password change before anything else.
  if (student.mustChangePassword) {
    return (
      <Switch>
        <Route path="/exit" component={Exit} />
        <Route>{() => <ForcedChangePassword />}</Route>
      </Switch>
    );
  }

  // If the student was mid-exam when the internet dropped, they were signed out
  // and bounced to login. After signing back in, lock them to ONLY resuming that
  // exam — no dashboard, scheduled, finished or profile until it's submitted.
  const activeExam = typeof localStorage !== "undefined" ? localStorage.getItem("examly:activeExam") : null;
  if (activeExam) {
    return (
      <Switch>
        <Route path="/exit" component={Exit} />
        <Route path="/exam/:examId" component={ExamRunner} />
        <Route>{() => <Redirect to={`/exam/${activeExam}`} />}</Route>
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/exit" component={Exit} />
      <Route path="/login">{() => <Redirect to="/" />}</Route>
      {/* Exam runner + review are full-screen, outside the shell */}
      <Route path="/exam/:examId" component={ExamRunner} />
      <Route path="/review/:attemptId" component={Review} />
      {/* Shell owns dashboard / scheduled / finished / profile */}
      <Route path="/:section?" component={Shell} />
    </Switch>
  );
}

export function StudentApp() {
  return (
    <Router base="/student">
      <SessionProvider>
        <Routes />
      </SessionProvider>
    </Router>
  );
}

export default StudentApp;
