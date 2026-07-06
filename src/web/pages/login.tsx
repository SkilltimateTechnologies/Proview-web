import { useState } from "react";
import { useSession } from "../lib/session";
import { Field } from "../components/ui";

export default function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const res = await signIn(email.trim(), password);
    setBusy(false);
    if (res.error) setErr(res.error);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background:
          "radial-gradient(900px 500px at 20% 0%, #eef2f7 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #e8eef5 0%, transparent 55%), #f4f6f9",
      }}
    >
      {/* Card */}
      <div
        style={{
          width: "100%",
          maxWidth: 940,
          background: "#ffffff",
          borderRadius: 24,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(30, 58, 95, 0.28), 0 2px 8px rgba(30,58,95,0.06)",
          border: "1px solid rgba(30,58,95,0.06)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          minHeight: 560,
        }}
        className="login-card"
      >
        {/* Photo panel */}
        <div
          style={{
            position: "relative",
            backgroundImage: "url('/exam-lab.png')",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
          className="login-photo"
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(18,37,61,0.20) 0%, rgba(18,37,61,0.10) 40%, rgba(15,30,51,0.35) 100%)",
            }}
          />
        </div>

        {/* Form panel */}
        <div
          style={{
            padding: "48px 44px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
          className="login-form"
        >
          <img
            src="/skilltimate-logo.png"
            alt="Skilltimate"
            style={{ height: 38, width: 164, objectFit: "contain", alignSelf: "flex-start", marginBottom: 32 }}
          />
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@college.edu"
                required
              />
            </Field>
            <Field label="Password">
              <div style={{ position: "relative" }}>
                <input
                  className="input"
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ paddingRight: 44 }}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide password" : "Show password"}
                  style={{
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--color-muted)",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: 4,
                  }}
                >
                  {show ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
            {err && (
              <div className="text-sm text-[var(--color-danger)] bg-[var(--color-danger-bg)] rounded-lg px-3 py-2">
                {err}
              </div>
            )}
            <button className="btn btn-primary w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p style={{ color: "var(--color-muted)", fontSize: 12.5, marginTop: 24, textAlign: "center" }}>
            Skilltimate Technologies · Proview
          </p>
        </div>
      </div>
    </div>
  );
}
