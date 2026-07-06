import { useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Icon } from "../components/ui";
import logo from "../assets/skilltimate-logo.png";
import labPhoto from "../assets/exam-lab.png";

export function Login() {
  const { login } = useSession();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setErr("Enter your Roll No / Email and password.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await api.login(identifier.trim(), password);
      login(res.student, res.token);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Login failed";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stu-login-split">
      <div className="stu-login-photo" style={{ backgroundImage: `url(${labPhoto})` }} />
      <div className="stu-login-wrap">
      <div className="stu-login-card rise">
        <div style={{ marginBottom: 26 }}>
          <img src={logo} alt="Skilltimate" style={{ height: 46, width: "auto", display: "block" }} />
          <div className="mono-label" style={{ marginTop: 12 }}>Proview · Secure Exam Client</div>
        </div>

        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 28, marginBottom: 4 }}>Sign in to your exams</h1>
        <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 24 }}>Use the roll number and password issued by your college.</p>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>Roll No / Email</label>
            <input className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="STU-21CS102" autoFocus />
          </div>
          <div>
            <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>Password</label>
            <div style={{ position: "relative" }}>
              <input className="input" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={{ paddingRight: 42 }} />
              <button type="button" onClick={() => setShowPw((v) => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--color-muted)", cursor: "pointer", background: "none", border: "none" }}>
                <Icon name={showPw ? "eye-off" : "eye"} />
              </button>
            </div>
          </div>

          {err && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13 }}>
              <Icon name="triangle-alert" size={15} /> {err}
            </div>
          )}

          <button className="btn btn-primary" style={{ padding: "12px", fontSize: 14, marginTop: 4 }} disabled={busy}>
            {busy ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="log-in" />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--color-line)", display: "flex", alignItems: "center", gap: 8, color: "var(--color-muted)", fontSize: 12 }}>
          <Icon name="shield-check" size={14} /> Your session is monitored during exams.
        </div>
      </div>
      </div>
    </div>
  );
}
