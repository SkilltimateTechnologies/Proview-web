import { useEffect, useState } from "react";
import { Icon } from "../student/components/ui";
import logo from "../student/assets/skilltimate-logo.png";
import labPhoto from "../student/assets/exam-lab.png";

type Section = { id: string; code: string };
type Meta = { tenant: { id: string; name: string; code?: string }; sections: Section[] };

// College short code comes from the URL: /register/<code>
function tenantIdFromPath(): string {
  const m = window.location.pathname.match(/\/register\/([^/?#]+)/);
  return m ? m[1] : "";
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { message?: string }).message || "Request failed");
  return data as T;
}
async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { message?: string }).message || "Request failed");
  return data as T;
}

type Step = "roll" | "form" | "done" | "exists";

export function RegisterPage() {
  const tenantId = tenantIdFromPath();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaErr, setMetaErr] = useState("");

  const [step, setStep] = useState<Step>("roll");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [existingName, setExistingName] = useState("");

  // form fields
  const [rollNo, setRollNo] = useState("");
  const [name, setName] = useState("");
  const [classId, setClassId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState("");

  useEffect(() => {
    if (!tenantId) { setMetaErr("Invalid registration link."); return; }
    jget<Meta>(`/api/register/${tenantId}/meta`)
      .then(setMeta)
      .catch((e) => setMetaErr(e instanceof Error ? e.message : "Failed to load"));
  }, [tenantId]);

  async function checkRoll(e: React.FormEvent) {
    e.preventDefault();
    const roll = rollNo.trim().replace(/\s+/g, "").toUpperCase();
    if (!roll) { setErr("Enter your roll number."); return; }
    setBusy(true); setErr("");
    try {
      const res = await jget<{ exists: boolean; name: string | null; rollNo: string }>(
        `/api/register/${tenantId}/check?rollNo=${encodeURIComponent(roll)}`,
      );
      setRollNo(res.rollNo);
      if (res.exists) {
        setExistingName(res.name || "");
        setStep("exists");
      } else {
        setStep("form");
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Enter your full name."); return; }
    if (!classId) { setErr("Select your section."); return; }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr("Enter a valid email address."); return; }
    if (phone.replace(/\D/g, "").length < 10) { setErr("Enter a valid 10-digit phone number."); return; }
    if (!gender) { setErr("Select your gender."); return; }
    setBusy(true); setErr("");
    try {
      const res = await jpost<{ name?: string }>(`/api/register/${tenantId}`, { rollNo, name, classId, email, phone, gender });
      if (res && typeof res.name === "string" && res.name) setName(res.name);
      setStep("done");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  const lbl: React.CSSProperties = { display: "block", marginBottom: 6 };

  return (
    <div className="stu-login-split">
      <div className="stu-login-photo" style={{ backgroundImage: `url(${labPhoto})` }} />
      <div className="stu-login-wrap">
        <div className="stu-login-card rise" style={{ maxWidth: 460 }}>
          <div style={{ marginBottom: 18 }}>
            <img src={logo} alt="Skilltimate" style={{ height: 40, width: "auto", display: "block" }} />
            <div className="mono-label" style={{ marginTop: 12 }}>Student Registration</div>
          </div>

          {/* College name — always shown on top once loaded */}
          {meta && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", borderRadius: 12, background: "var(--color-accent-bg, #eef3fb)", border: "1px solid var(--color-line, #e3e8f0)", marginBottom: 20 }}>
              <div style={{ width: 38, height: 38, flex: "0 0 auto", borderRadius: 9, background: "var(--color-accent, #1e3a5f)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono, monospace)", fontSize: 13, fontWeight: 700 }}>
                {(meta.tenant.code || meta.tenant.name.slice(0, 3)).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--color-ink2)", marginBottom: 2 }}>Registering for</div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, lineHeight: 1.25, color: "var(--color-ink)" }}>{meta.tenant.name}</div>
              </div>
            </div>
          )}

          {metaErr && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "12px 14px", borderRadius: 10, fontSize: 13 }}>
              <Icon name="triangle-alert" size={16} /> {metaErr}
            </div>
          )}

          {!metaErr && !meta && (
            <div style={{ color: "var(--color-ink2)", fontSize: 14 }}>Loading…</div>
          )}

          {meta && (step === "roll" || step === "form") && (
            <>
              <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 22 }}>
                {step === "roll"
                  ? "Enter your roll number to begin."
                  : "Fill in your details to complete registration."}
              </p>
            </>
          )}

          {/* Step 1 — roll number */}
          {meta && step === "roll" && (
            <form onSubmit={checkRoll} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label className="mono-label" style={lbl}>Roll Number</label>
                <input className="input" value={rollNo} onChange={(e) => { setRollNo(e.target.value.toUpperCase()); setErr(""); }} placeholder="23K91A0501" autoFocus style={{ textTransform: "uppercase" }} />
              </div>
              {err && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13 }}>
                  <Icon name="info" size={15} /> {err}
                </div>
              )}
              <button className="btn btn-primary" style={{ padding: 12, fontSize: 14, marginTop: 4 }} disabled={busy}>
                {busy ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="arrow-right" />}
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
          )}

          {/* Step 2 — details form */}
          {meta && step === "form" && (
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label className="mono-label" style={lbl}>Roll Number</label>
                <input className="input" value={rollNo} readOnly style={{ opacity: 0.75, cursor: "not-allowed" }} />
              </div>
              <div>
                <label className="mono-label" style={lbl}>Full Name</label>
                <input className="input" value={name} onChange={(e) => { setName(e.target.value); setErr(""); }} placeholder="Ira Reddy" autoFocus />
              </div>
              <div>
                <label className="mono-label" style={lbl}>Section</label>
                <select className="input" value={classId} onChange={(e) => { setClassId(e.target.value); setErr(""); }}>
                  <option value="">Select section…</option>
                  {meta.sections.map((s) => (
                    <option key={s.id} value={s.id}>{s.code}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mono-label" style={lbl}>Email</label>
                <input className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setErr(""); }} placeholder="you@example.com" />
              </div>
              <div>
                <label className="mono-label" style={lbl}>Phone Number</label>
                <input className="input" inputMode="numeric" value={phone} onChange={(e) => { setPhone(e.target.value.replace(/[^\d]/g, "").slice(0, 10)); setErr(""); }} placeholder="9876543210" />
              </div>
              <div>
                <label className="mono-label" style={lbl}>Gender</label>
                <div style={{ display: "flex", gap: 10 }}>
                  {["male", "female"].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => { setGender(g); setErr(""); }}
                      className="btn"
                      style={{
                        flex: 1,
                        padding: 11,
                        textTransform: "capitalize",
                        border: `1px solid ${gender === g ? "var(--color-accent, #1e3a5f)" : "var(--color-line)"}`,
                        background: gender === g ? "var(--color-accent, #1e3a5f)" : "transparent",
                        color: gender === g ? "#fff" : "var(--color-ink)",
                        fontWeight: 600,
                      }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              {err && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13 }}>
                  <Icon name="triangle-alert" size={15} /> {err}
                </div>
              )}

              <button className="btn btn-primary" style={{ padding: 12, fontSize: 14, marginTop: 4 }} disabled={busy}>
                {busy ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="check" />}
                {busy ? "Registering…" : "Register"}
              </button>
              <button type="button" className="btn" onClick={() => { setStep("roll"); setErr(""); }} style={{ padding: 10, fontSize: 13, color: "var(--color-ink2)" }}>
                <Icon name="arrow-left" size={14} /> Back
              </button>
            </form>
          )}

          {/* Already registered */}
          {step === "exists" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ width: 66, height: 66, borderRadius: "50%", background: "var(--color-accent-bg, #eaf1fb)", color: "var(--color-accent, #1e3a5f)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                <Icon name="badge-check" size={34} />
              </div>
              <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 25, marginBottom: 8, lineHeight: 1.25 }}>
                {existingName || "You"}, you are already registered
              </h1>
              <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 18 }}>
                Roll number <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{rollNo}</span> already exists in our records. No need to register again.
              </p>
              <button type="button" className="btn" onClick={() => { setStep("roll"); setRollNo(""); setExistingName(""); setErr(""); }} style={{ padding: 10, fontSize: 13, color: "var(--color-ink2)" }}>
                <Icon name="arrow-left" size={14} /> Check another roll number
              </button>
            </div>
          )}

          {/* Step 3 — success */}
          {step === "done" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ width: 66, height: 66, borderRadius: "50%", background: "var(--color-success-bg, #e7f6ec)", color: "var(--color-success, #1a8a4b)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                <Icon name="check" size={34} />
              </div>
              <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 25, marginBottom: 8, lineHeight: 1.25 }}>
                {name}, you are now successfully registered
              </h1>
              <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 4 }}>
                Roll number <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{rollNo}</span>
              </p>
              <p style={{ color: "var(--color-ink2)", fontSize: 13 }}>
                You can now sign in with your roll number and the default password <strong>Welcome@123</strong>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



