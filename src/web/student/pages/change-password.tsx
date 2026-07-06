import { useState } from "react";
import { useLocation } from "wouter";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Icon } from "../components/ui";
import logo from "../assets/skilltimate-logo.png";

/**
 * Password change form. Two modes:
 *  - forced=true  → shown full-screen right after first login (mustChangePassword);
 *                   cannot be skipped, no back navigation.
 *  - forced=false → embedded inside the Profile page.
 */
export function ChangePasswordForm({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!current || !next) { setErr("Fill in all fields."); return; }
    if (next.length < 6) { setErr("New password must be at least 6 characters."); return; }
    if (next !== confirm) { setErr("New password and confirmation do not match."); return; }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setOk(true);
      setTimeout(onDone, 900);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not change password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {forced && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "var(--color-brand-soft)", color: "var(--color-ink)", padding: "12px 14px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.5 }}>
          <Icon name="shield-alert" size={18} />
          <span>For your security, set a new password before you start. You'll use this password from now on.</span>
        </div>
      )}
      <div>
        <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>{forced ? "Password issued by your college" : "Current password"}</label>
        <input className="input" type={show ? "text" : "password"} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="••••••••" autoFocus />
      </div>
      <div>
        <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>New password</label>
        <input className="input" type={show ? "text" : "password"} value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 6 characters" />
      </div>
      <div>
        <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>Confirm new password</label>
        <input className="input" type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter new password" />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-ink2)", cursor: "pointer" }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
      </label>

      {err && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13 }}>
          <Icon name="triangle-alert" size={15} /> {err}
        </div>
      )}
      {ok && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-success)", background: "#e7f5ee", padding: "10px 12px", borderRadius: 10, fontSize: 13 }}>
          <Icon name="check" size={15} /> Password updated.
        </div>
      )}

      <button className="btn btn-primary" style={{ padding: "12px", fontSize: 14, marginTop: 4 }} disabled={busy || ok}>
        {busy ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="key-round" />}
        {busy ? "Saving…" : forced ? "Set new password & continue" : "Update password"}
      </button>
    </form>
  );
}

/** Full-screen forced change on first login. */
export function ForcedChangePassword() {
  const { clearMustChange } = useSession();
  const [, navigate] = useLocation();
  return (
    <div className="stu-login-split">
      <div className="stu-login-wrap" style={{ flex: 1 }}>
        <div className="stu-login-card rise" style={{ maxWidth: 440 }}>
          <div style={{ marginBottom: 22 }}>
            <img src={logo} alt="Skilltimate" style={{ height: 42, width: "auto", display: "block" }} />
            <div className="mono-label" style={{ marginTop: 12 }}>Proview · Set your password</div>
          </div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, marginBottom: 4 }}>Create a new password</h1>
          <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 22 }}>This is your first sign-in. Replace the issued password with one only you know.</p>
          <ChangePasswordForm forced onDone={() => { clearMustChange(); navigate("/"); }} />
        </div>
      </div>
    </div>
  );
}
