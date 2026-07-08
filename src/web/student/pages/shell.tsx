import { useEffect, useMemo, useRef, useState } from "react";
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
// A ticking HH:MM:SS clock for the waiting-room gate (prefixes days when >= 24h).
function clock(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
}
// How close an upcoming exam must be to take over the whole screen with a live
// countdown. Exams further out than this stay on the dashboard as normal cards.
const WAIT_WINDOW_MS = 12 * 60 * 60 * 1000;

export function Shell() {
  const params = useParams();
  const section = params.section ?? "";
  const [, navigate] = useLocation();
  const { student, logout } = useSession();
  const online = useOnline();
  const [exams, setExams] = useState<ExamListItem[] | null>(null);
  const [err, setErr] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null);

  const loadRef = useRef<() => Promise<void>>(async () => {});
  loadRef.current = async () => {
    try {
      const res = await api.exams();
      setExams(res.exams);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load exams");
      setExams((prev) => prev ?? []);
    }
  };

  // Keep the exam list fresh so a student who is already logged in and waiting
  // sees the Start gate appear the moment an exam goes live — no manual refresh.
  //  1. Poll every 15s while the dashboard is open (only when online).
  //  2. Additionally, schedule a precise one-shot refresh for the exact instant
  //     the nearest upcoming exam's start time hits, so the flip is immediate.
  useEffect(() => {
    void loadRef.current();
    const poll = setInterval(() => {
      if (typeof navigator === "undefined" || navigator.onLine) void loadRef.current();
    }, 15000);
    // Refresh as soon as the tab regains focus (e.g. student switches back at 11:30).
    const onFocus = () => void loadRef.current();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(poll); window.removeEventListener("focus", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Precise refresh right when the soonest upcoming exam is due to start.
  useEffect(() => {
    if (!exams) return;
    const now = Date.now();
    const nextStart = exams
      .filter((e) => e.phase === "upcoming" && e.startAt)
      .map((e) => new Date(e.startAt as string).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (nextStart == null) return;
    // +500ms cushion so the server has definitely crossed startAt when we refetch.
    const delay = Math.min(nextStart - now + 500, 2_147_000_000);
    const t = setTimeout(() => void loadRef.current(), delay);
    return () => clearTimeout(t);
  }, [exams]);

  const live = useMemo(() => (exams || []).filter((e) => e.phase === "available" || e.phase === "in_progress"), [exams]);
  // Soonest imminent upcoming exam (within WAIT_WINDOW_MS). It takes over the
  // whole screen as a waiting room with a live countdown, so the student just
  // waits for the Start button to unlock — no manual refresh needed. Far-future
  // exams stay on the dashboard as cards.
  const waiting = useMemo(() => {
    const now = Date.now();
    return (exams || [])
      .filter((e) => e.phase === "upcoming" && e.startAt)
      .map((e) => ({ e, t: new Date(e.startAt as string).getTime() }))
      .filter(({ t }) => t - now <= WAIT_WINDOW_MS)
      .sort((a, b) => a.t - b.t)
      .map(({ e }) => e)[0] ?? null;
  }, [exams]);
  // A live/in-progress exam always wins; otherwise show the imminent waiting room.
  const gateExam = live[0] ?? waiting;
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

  // When an exam is live/in-progress — OR an imminent scheduled exam is due soon
  // — strip ALL chrome (no sidebar, no nav) and show only a centered, focused
  // gate. For a live exam that's the Start/Resume button; for a scheduled exam
  // it's a waiting room with a live countdown that unlocks Start at start time.
  if (!(err && exams.length === 0) && gateExam) {
    return (
      <div className="exam-focus">
        <header className="exam-focus-top">
          <div className="exam-focus-brand">
            <img src={logo} alt="Skilltimate" style={{ height: 26, width: "auto" }} />
            <span className="brand-name">Proview</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NetBadge online={online} />
            <button className="btn btn-ghost btn-sm" onClick={() => { logout(); window.location.replace(window.location.origin + "/px9k2m7/exit"); }}>
              <Icon name="log-out" size={15} /> Sign out
            </button>
          </div>
        </header>
        <div className="exam-focus-body">
          <ExamGate exam={gateExam} onStart={(id) => navigate(`/exam/${id}`)} onElapsed={() => void loadRef.current()} />
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
            <div className="brand-name" style={{ fontSize: 12, lineHeight: 1.3, whiteSpace: "normal", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{student?.collegeName || "Proview"}</div>
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
          <button className="snav" style={{ width: "100%" }} onClick={() => { logout(); window.location.replace(window.location.origin + "/px9k2m7/exit"); }}>
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
        {e.attempt?.status === "graded" && e.attempt?.score != null
          ? <div className="m"><span className="mono-label">Score</span><span className="m-v">{e.attempt.score}/100</span></div>
          : <div className="m"><span className="mono-label">Points</span><span className="m-v">{e.totalPoints}</span></div>}
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
          ) : e.attempt?.status !== "graded" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-ink2)", fontSize: 13, fontWeight: 600 }}>
              <Icon name="loader-circle" size={15} className="animate-spin" /> Grading in progress — your score will appear shortly
            </div>
          ) : e.attempt && !e.resultsReady ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--color-ink2)", fontSize: 12.5, fontWeight: 600 }}>
                <Icon name="lock" size={14} /> Review unlocks after the exam closes
              </span>
              <button className="btn btn-ghost" disabled style={{ opacity: 0.55, cursor: "not-allowed" }}><Icon name="file-search" /> Review answers</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {e.attempt && <button className="btn btn-ghost" onClick={() => onOpen(e.attempt!.id)}><Icon name="file-search" /> Review answers</button>}
            </div>
          )}
        </ExamCard>
      ))}
    </div>
  );
}

// Full-screen focused gate. Two states:
//  • Ready (exam live / in progress, or the scheduled start time has passed) —
//    shows a big Start / Resume button.
//  • Waiting (scheduled exam not started yet) — shows a live ticking countdown
//    and a disabled Start button that unlocks automatically at the start time.
//    No polling: the client tick flips the gate to Ready the instant it hits 0.
function ExamGate({ exam, onStart, onElapsed }: { exam: ExamListItem; onStart: (id: string) => void; onElapsed: () => void }) {
  const started = exam.phase === "available" || exam.phase === "in_progress";
  const startMs = exam.startAt ? new Date(exam.startAt).getTime() : null;
  const [now, setNow] = useState(Date.now());

  // Tick every second only while we're waiting on a future start time.
  useEffect(() => {
    if (started || startMs == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [started, startMs]);

  // The moment the countdown crosses the start time, refresh the exam list once
  // so the server phase flips to "available" (label + list stay in sync).
  const firedRef = useRef(false);
  const reached = started || (startMs != null && now >= startMs);
  useEffect(() => {
    if (!started && startMs != null && now >= startMs && !firedRef.current) {
      firedRef.current = true;
      onElapsed();
    }
  }, [now, started, startMs, onElapsed]);

  const remaining = startMs != null ? startMs - now : 0;
  const resume = exam.phase === "in_progress";

  return (
    <div style={{ width: "100%", maxWidth: 620, margin: "0 auto", display: "grid", gap: 20 }}>
      <div style={{ textAlign: "center" }}>
        {reached ? (
          <div className="mono-label" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-danger)" }}>
            <span className="pill-dot" style={{ background: "var(--color-danger)" }} /> Live now
          </div>
        ) : (
          <div className="mono-label" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-warn)" }}>
            <Icon name="clock" size={13} /> Scheduled
          </div>
        )}
        <h1 className="page-title" style={{ marginTop: 8 }}>{exam.title}</h1>
        <p style={{ color: "var(--color-ink2)", marginTop: 4 }}>
          {reached
            ? "Your exam is ready. Review the details below, then start when you are."
            : "Your exam hasn't started yet. This screen will unlock the moment it begins — no need to refresh."}
        </p>
      </div>
      <div className="exam-card rise">
        <div className="exam-meta">
          <div className="m"><span className="mono-label">Questions</span><span className="m-v">{exam.questionCount}</span></div>
          <div className="m"><span className="mono-label">Duration</span><span className="m-v">{exam.durationMin} min</span></div>
          <div className="m"><span className="mono-label">Points</span><span className="m-v">{exam.totalPoints}</span></div>
        </div>

        {!reached && (
          <div style={{ textAlign: "center", margin: "4px 0 18px" }}>
            <div className="mono-label">Starts in</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 40, fontWeight: 700, letterSpacing: 1, color: "var(--color-ink)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              {clock(remaining)}
            </div>
            {exam.startAt && (
              <div style={{ color: "var(--color-muted)", fontSize: 13, marginTop: 4 }}>Scheduled for {fmtDate(exam.startAt)}</div>
            )}
          </div>
        )}

        {reached ? (
          <button className="btn btn-primary" style={{ width: "100%", padding: 14, fontSize: 15 }} onClick={() => onStart(exam.id)}>
            <Icon name="play" /> {resume ? "Resume exam" : "Start exam"}
          </button>
        ) : (
          <button className="btn btn-primary" style={{ width: "100%", padding: 14, fontSize: 15, opacity: 0.55, cursor: "not-allowed" }} disabled>
            <Icon name="lock" size={15} /> Start exam
          </button>
        )}
      </div>
    </div>
  );
}

function Dashboard({ finished, onReview }: { finished: ExamListItem[]; onReview: (a: string) => void }) {
  const { student } = useSession();
  // Only truly-completed attempts count towards averages / completed count.
  // `finished` is already sorted latest-first upstream.
  const completed = useMemo(() => finished.filter((e) => e.phase === "finished"), [finished]);
  // A student sees their own score once their attempt is fully graded — only count
  // graded attempts with a real score in the average (a still-grading exam must
  // not drag it to 0).
  const revealed = useMemo(() => completed.filter((e) => e.attempt?.status === "graded" && e.attempt?.score != null), [completed]);
  const avg = revealed.length ? Math.round((revealed.reduce((s, e) => s + (e.attempt?.score || 0), 0) / revealed.length) * 10) / 10 : null;
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
                {e.attempt?.status !== "graded" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-ink2)", fontSize: 13, fontWeight: 600 }}>
                    <Icon name="loader-circle" size={15} className="animate-spin" /> Grading in progress
                  </div>
                ) : e.attempt && !e.resultsReady ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--color-ink2)", fontSize: 12.5, fontWeight: 600 }}>
                      <Icon name="lock" size={14} /> Review unlocks after the exam closes
                    </span>
                    <button className="btn btn-ghost" disabled style={{ opacity: 0.55, cursor: "not-allowed" }}><Icon name="file-search" /> Review</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    {e.attempt && <button className="btn btn-ghost" onClick={() => onReview(e.attempt!.id)}><Icon name="file-search" /> Review</button>}
                  </div>
                )}
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
