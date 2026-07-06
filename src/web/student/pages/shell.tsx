import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import { api, type ExamListItem, type Review as ReviewData } from "../lib/api";
import { useSession } from "../lib/session";
import { ChangePasswordForm } from "./change-password";
import { ReviewBody } from "./review";
import { Icon, Pill, Loader, EmptyState, NetBadge, useOnline } from "../components/ui";
import logo from "../assets/skilltimate-logo.png";

const NAV = [
  { key: "", label: "Dashboard", icon: "layout-dashboard" },
  { key: "finished", label: "Finished Exams", icon: "circle-check-big" },
  { key: "profile", label: "Profile", icon: "user-round" },
];

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
function countdown(startAt: string | null): string {
  if (!startAt) return "";
  const diff = new Date(startAt).getTime() - Date.now();
  if (diff <= 0) return "Starting now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

export function Shell() {
  const params = useParams();
  const section = params.section ?? "";
  const [, navigate] = useLocation();
  const { student, logout } = useSession();
  const online = useOnline();
  const [exams, setExams] = useState<ExamListItem[] | null>(null);
  const [err, setErr] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.exams();
      setExams(res.exams);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load exams");
      setExams([]);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = useMemo(() => (exams || []).filter((e) => e.phase === "available" || e.phase === "in_progress"), [exams]);
  // "Finished Exams" shows completed attempts and any missed (absent) exams —
  // latest submission on top.
  const finished = useMemo(() => {
    const list = (exams || []).filter((e) => e.phase === "finished" || e.phase === "absent");
    const t = (e: ExamListItem) => new Date(e.attempt?.submittedAt || e.endAt || e.startAt || 0).getTime();
    return [...list].sort((a, b) => t(b) - t(a));
  }, [exams]);

  // While exams are still loading, show a neutral full-screen loader so we never
  // flash the dashboard chrome before swapping to the live-exam focus layout.
  if (exams === null) {
    return (
      <div className="exam-focus">
        <div className="exam-focus-body">
          <Loader label="Loading your exams…" />
        </div>
      </div>
    );
  }

  // When an exam is live/in-progress, strip ALL chrome (no sidebar, no nav) and
  // show only a centered, focused gate. This keeps the student locked to the
  // one action that matters: start / resume the exam.
  if (!(err && exams.length === 0) && live.length > 0) {
    return (
      <div className="exam-focus">
        <header className="exam-focus-top">
          <div className="exam-focus-brand">
            <img src={logo} alt="Skilltimate" style={{ height: 26, width: "auto" }} />
            <span className="brand-name">Proview</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NetBadge online={online} />
            <button className="btn btn-ghost btn-sm" onClick={() => { logout(); window.location.replace(window.location.origin + "/student/exit"); }}>
              <Icon name="log-out" size={15} /> Sign out
            </button>
          </div>
        </header>
        <div className="exam-focus-body">
          <LiveExamGate live={live} onStart={(id) => navigate(`/exam/${id}`)} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="side">
        <div className="brand" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
          <img src={logo} alt="Skilltimate" style={{ height: 30, width: "auto", maxWidth: 170, objectFit: "contain" }} />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">{student?.collegeName || "Proview"}</div>
            <div className="brand-sub">Student Portal</div>
          </div>
        </div>
        <nav className="snav-list">
          {NAV.map((n) => (
            <Link key={n.key} href={`/${n.key}`} className={`snav ${section === n.key ? "active" : ""}`}>
              <Icon name={n.icon} /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 12px" }}>
            <div style={{ width: 34, height: 34, borderRadius: 999, background: "var(--color-brand-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "var(--brand)", fontSize: 13 }}>
              {student?.name?.split(" ").map((x) => x[0]).slice(0, 2).join("")}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--color-ink)", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{student?.name}</div>
              <div style={{ fontSize: 11, color: "var(--color-muted)", fontFamily: "var(--font-mono)" }}>{student?.rollNo}</div>
            </div>
          </div>
          <button className="snav" style={{ width: "100%" }} onClick={() => { logout(); window.location.replace(window.location.origin + "/student/exit"); }}>
            <Icon name="log-out" /> Sign out
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div>
            <div className="mono-label">{student?.collegeName}</div>
            <div style={{ fontWeight: 700, fontSize: 16, textTransform: "capitalize" }}>{NAV.find((n) => n.key === section)?.label || "Dashboard"}</div>
          </div>
          <NetBadge online={online} />
        </header>

        <main className="content">
          <div className="content-inner">
            {exams === null ? (
              <Loader label="Loading your exams…" />
            ) : err && exams.length === 0 ? (
              <EmptyState icon="cloud-off" title="Can't reach the server" sub={err} />
            ) : section === "profile" ? (
              <ProfileView />
            ) : section === "finished" ? (
              <FinishedList exams={finished} onOpen={setReviewId} />
            ) : (
              <Dashboard finished={finished} onReview={setReviewId} />
            )}
          </div>
        </main>
      </div>
      <ReviewDrawer attemptId={reviewId} onClose={() => setReviewId(null)} />
    </div>
  );
}

function StartButton({ e, onStart }: { e: ExamListItem; onStart: (id: string) => void }) {
  if (e.phase === "upcoming") {
    return e.startAt
      ? <Pill tone="warn"><Icon name="clock" size={13} /> Starts {countdown(e.startAt)}</Pill>
      : <Pill tone="default"><Icon name="clock" size={13} /> Not yet scheduled</Pill>;
  }
  if (e.phase === "absent") {
    return <Pill tone="danger"><Icon name="user-x" size={13} /> Absent</Pill>;
  }
  return (
    <button className="btn btn-primary" onClick={() => onStart(e.id)}>
      <Icon name="play" />
      {e.phase === "in_progress" ? "Resume exam" : "Start exam"}
    </button>
  );
}

function ExamCard({ e, children }: { e: ExamListItem; children: React.ReactNode }) {
  return (
    <div className="exam-card rise">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div className="mono-label">{e.status === "live" ? "Live now" : e.status === "scheduled" ? "Scheduled" : "Exam"}</div>
          <div style={{ fontWeight: 700, fontSize: 17, marginTop: 2 }}>{e.title}</div>
        </div>
        {e.phase === "in_progress" && <Pill tone="warn"><span className="pill-dot" style={{ background: "var(--color-warn)" }} /> In progress</Pill>}
        {e.phase === "finished" && <Pill tone="success"><Icon name="check" size={13} /> Submitted</Pill>}
        {e.phase === "absent" && <Pill tone="danger"><Icon name="user-x" size={13} /> Absent</Pill>}
      </div>
      <div className="exam-meta">
        <div className="m"><span className="mono-label">Questions</span><span className="m-v">{e.questionCount}</span></div>
        <div className="m"><span className="mono-label">Duration</span><span className="m-v">{e.durationMin} min</span></div>
        <div className="m"><span className="mono-label">Points</span><span className="m-v">{e.totalPoints}</span></div>
        {e.startAt && <div className="m"><span className="mono-label">Starts</span><span className="m-v" style={{ fontSize: 14 }}>{fmtDate(e.startAt)}</span></div>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>{children}</div>
    </div>
  );
}

function FinishedList({ exams, onOpen }: { exams: ExamListItem[]; onOpen: (attemptId: string) => void }) {
  if (exams.length === 0) return <EmptyState icon="circle-check-big" title="No finished exams yet" sub="Completed exams will show here so you can review your answers." />;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {exams.map((e) => (
        <ExamCard key={e.id} e={e}>
          {e.phase === "absent" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", fontSize: 13, fontWeight: 600 }}>
              <Icon name="user-x" size={15} /> Marked absent — exam window closed
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {e.attempt?.score != null && <div style={{ textAlign: "right" }}><div className="mono-label">Score</div><div className="stat-num" style={{ fontSize: 20 }}>{e.attempt.score}%</div></div>}
              {e.attempt && <button className="btn btn-ghost" onClick={() => onOpen(e.attempt!.id)}><Icon name="file-search" /> Review answers</button>}
            </div>
          )}
        </ExamCard>
      ))}
    </div>
  );
}

// Full-screen focused gate shown when an exam is live — the ONLY thing the
// student sees is the exam brief + a single big "Start exam" button.
function LiveExamGate({ live, onStart }: { live: ExamListItem[]; onStart: (id: string) => void }) {
  const e = live[0];
  return (
    <div style={{ width: "100%", maxWidth: 620, margin: "0 auto", display: "grid", gap: 20 }}>
      <div style={{ textAlign: "center" }}>
        <div className="mono-label" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-danger)" }}>
          <span className="pill-dot" style={{ background: "var(--color-danger)" }} /> Live now
        </div>
        <h1 className="page-title" style={{ marginTop: 8 }}>{e.title}</h1>
        <p style={{ color: "var(--color-ink2)", marginTop: 4 }}>Your exam is ready. Review the details below, then start when you are.</p>
      </div>
      <div className="exam-card rise">
        <div className="exam-meta">
          <div className="m"><span className="mono-label">Questions</span><span className="m-v">{e.questionCount}</span></div>
          <div className="m"><span className="mono-label">Duration</span><span className="m-v">{e.durationMin} min</span></div>
          <div className="m"><span className="mono-label">Points</span><span className="m-v">{e.totalPoints}</span></div>
        </div>
        <button className="btn btn-primary" style={{ width: "100%", padding: 14, fontSize: 15 }} onClick={() => onStart(e.id)}>
          <Icon name="play" /> {e.phase === "in_progress" ? "Resume exam" : "Start exam"}
        </button>
      </div>
    </div>
  );
}

function Dashboard({ finished, onReview }: { finished: ExamListItem[]; onReview: (a: string) => void }) {
  const { student } = useSession();
  // Only truly-completed attempts count towards averages / completed count.
  // `finished` is already sorted latest-first upstream.
  const completed = useMemo(() => finished.filter((e) => e.phase === "finished"), [finished]);
  const avg = completed.length ? Math.round((completed.reduce((s, e) => s + (e.attempt?.score || 0), 0) / completed.length) * 10) / 10 : null;
  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <div className="mono-label">Welcome back</div>
        <h1 className="page-title">{student?.name?.split(" ")[0]}</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
        <StatCard icon="circle-check-big" label="Completed" value={String(completed.length)} />
        <StatCard icon="target" label="Average score" value={avg != null ? `${avg}%` : "—"} />
      </div>

      {completed.length > 0 && (
        <div>
          <div className="mono-label" style={{ marginBottom: 10 }}>Recent results</div>
          <div style={{ display: "grid", gap: 16 }}>
            {completed.slice(0, 3).map((e) => (
              <ExamCard key={e.id} e={e}>
                {e.attempt?.score != null && <div style={{ textAlign: "right", marginRight: 12 }}><div className="mono-label">Score</div><div className="stat-num" style={{ fontSize: 20 }}>{e.attempt.score}%</div></div>}
                {e.attempt && <button className="btn btn-ghost" onClick={() => onReview(e.attempt!.id)}><Icon name="file-search" /> Review</button>}
              </ExamCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: "var(--color-brand-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand)" }}>
        <Icon name={icon} size={19} />
      </div>
      <div>
        <div className="mono-label">{label}</div>
        <div className="stat-num" style={{ fontSize: 26 }}>{value}</div>
      </div>
    </div>
  );
}

function ProfileView() {
  const { student } = useSession();
  const [showPw, setShowPw] = useState(false);
  const rows = [
    { label: "Name", value: student?.name },
    { label: "Roll No", value: student?.rollNo },
    { label: "Email", value: student?.email || "—" },
    { label: "College", value: student?.collegeName },
  ];
  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 560 }}>
      <div className="card" style={{ padding: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
          <div style={{ width: 60, height: 60, borderRadius: 999, background: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 22 }}>
            {student?.name?.split(" ").map((x) => x[0]).slice(0, 2).join("")}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 19 }}>{student?.name}</div>
            <div className="mono-label">{student?.rollNo}</div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 2 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid var(--color-line)" }}>
              <span className="mono-label">{r.label}</span>
              <span style={{ fontWeight: 500 }}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 26 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: showPw ? 20 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--color-brand-soft)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="key-round" size={19} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Password</div>
              <div className="mono-label">Change the password you use to sign in</div>
            </div>
          </div>
          {!showPw && <button className="btn btn-ghost" onClick={() => setShowPw(true)}><Icon name="pencil" size={14} /> Change password</button>}
        </div>
        {showPw && <ChangePasswordForm forced={false} onDone={() => setShowPw(false)} />}
      </div>
    </div>
  );
}

// Right-side sliding panel that shows a finished attempt's review (answers,
// correct answers, score, AI feedback) without leaving the current page.
function ReviewDrawer({ attemptId, onClose }: { attemptId: string | null; onClose: () => void }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!attemptId) { setData(null); setErr(""); return; }
    setData(null);
    setErr("");
    api.review(attemptId).then(setData).catch((e) => setErr(e instanceof Error ? e.message : "Failed to load review"));
  }, [attemptId]);

  // Lock body scroll while open.
  useEffect(() => {
    if (attemptId) { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }
  }, [attemptId]);

  const open = !!attemptId;
  return (
    <>
      <div className={`rev-scrim ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`rev-drawer ${open ? "open" : ""}`} role="dialog" aria-modal="true">
        <header className="rev-drawer-top">
          <div style={{ minWidth: 0 }}>
            <div className="mono-label">Review answers</div>
            <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{data?.exam?.title || "Loading…"}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="x" /> Close</button>
        </header>
        <div className="rev-drawer-body">
          {err ? (
            <EmptyState icon="cloud-off" title="Can't load review" sub={err} />
          ) : !data ? (
            <Loader label="Loading your results…" />
          ) : (
            <ReviewBody data={data} />
          )}
        </div>
      </aside>
    </>
  );
}
