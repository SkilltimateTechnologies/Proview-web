import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { api, type Bundle, type BundleQuestion, type ProctorConfig, DEFAULT_PROCTORING } from "../lib/api";
import { useSession } from "../lib/session";
import { requestFullscreen, exitFullscreen, startWebcam, getDisplayCount, type ProctorEvent, type WebcamHandle } from "../lib/proctor";
import { Icon, NetBadge, useOnline } from "../components/ui";

type Phase = "brief" | "preflight" | "running" | "validating" | "done";

type Alert = { id: number; text: string; tone: "danger" | "warn" };

// In-memory running session (live web exam — nothing cached to disk).
type RunSession = {
  attemptId: string;
  endAt: number; // absolute ms deadline (server-anchored)
  answers: Record<string, unknown>;
  flags: Record<string, boolean>;
  integrityEvents: ProctorEvent[];
};

function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// localStorage bridge so an in-progress exam survives a forced logout/relogin
// (used when the internet drops mid-exam and we bounce the student to login).
const ACTIVE_EXAM_KEY = "examly:activeExam";
type SavedProgress = { answers: Record<string, unknown>; flags: Record<string, boolean> };
function progressKey(examId: string) { return `examly:progress:${examId}`; }
function saveProgress(examId: string, p: SavedProgress) {
  try { localStorage.setItem(progressKey(examId), JSON.stringify(p)); } catch { /* ignore */ }
}
function loadProgress(examId: string): SavedProgress | null {
  try {
    const raw = localStorage.getItem(progressKey(examId));
    return raw ? (JSON.parse(raw) as SavedProgress) : null;
  } catch { return null; }
}
function clearProgress(examId: string) {
  try { localStorage.removeItem(progressKey(examId)); localStorage.removeItem(ACTIVE_EXAM_KEY); } catch { /* ignore */ }
}

export function ExamRunner() {
  const { examId } = useParams();
  const [, navigate] = useLocation();
  const { student } = useSession();
  const online = useOnline();

  const [phase, setPhase] = useState<Phase>("brief");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");
  const [session, setSession] = useState<RunSession | null>(null);
  const [cur, setCur] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ answered: number; skipped: number; events: number; attemptId: string; score: number | null } | null>(null);

  const sessionRef = useRef<RunSession | null>(null);
  sessionRef.current = session;
  const submittedRef = useRef(false);

  // Proctoring config comes from the exam bundle (admin-configured); fall back to defaults.
  const proctoring: ProctorConfig = bundle?.proctoring ? { ...DEFAULT_PROCTORING, ...bundle.proctoring } : DEFAULT_PROCTORING;
  const proctoringRef = useRef(proctoring);
  proctoringRef.current = proctoring;

  // Network-outage overlay (in-exam). When the internet drops we freeze the exam
  // behind an overlay instead of logging the student out; on reconnect the lost
  // time is granted back and the deadline is extended.
  const [netLost, setNetLost] = useState(false);
  const offlineSinceRef = useRef<number | null>(null);

  // Alerts (violation banners)
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const alertIdRef = useRef(0);
  const pushAlert = useCallback((text: string, tone: "danger" | "warn" = "danger") => {
    const idv = ++alertIdRef.current;
    setAlerts((a) => [...a, { id: idv, text, tone }]);
    setTimeout(() => setAlerts((a) => a.filter((x) => x.id !== idv)), 5000);
  }, []);

  // Webcam
  const webcamRef = useRef<WebcamHandle | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [camError, setCamError] = useState("");
  const [locked, setLocked] = useState(false);
  const [lockLeft, setLockLeft] = useState(0);
  const lockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Multi-monitor state (single-screen enforcement).
  const [displayCount, setDisplayCount] = useState(1);
  const [screenLocked, setScreenLocked] = useState(false);
  const displayCountRef = useRef(1);
  displayCountRef.current = displayCount;

  const attachVideo = useCallback((handle: WebcamHandle) => {
    if (videoRef.current) {
      videoRef.current.srcObject = handle.stream;
      void videoRef.current.play().catch(() => {});
    }
  }, []);

  // ---- Load bundle for the brief (title/meta + question data) ----
  useEffect(() => {
    if (!examId) return;
    api.bundle(examId).then(setBundle).catch(() => {
      setErr("Couldn't load the exam. Check your connection and try again.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  // ---- Camera-loss lock ----
  const engageLock = useCallback((reason: string) => {
    const cfg = proctoringRef.current;
    if (!cfg.blockOnCameraLoss || submittedRef.current) return;
    setCamReady(false);
    const s = sessionRef.current;
    if (s) {
      const ev: ProctorEvent = { type: "camera_lost", detail: reason, at: Date.now() };
      setSession({ ...s, integrityEvents: [...s.integrityEvents, ev] });
    }
    pushAlert(`Camera turned off — exam locked. ${reason}`, "danger");
    setLocked(true);
    setLockLeft(cfg.cameraLossLockSeconds);
    if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    lockTimerRef.current = setInterval(() => {
      setLockLeft((v) => {
        if (v <= 1) {
          if (lockTimerRef.current) clearInterval(lockTimerRef.current);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  }, [pushAlert]);

  const enableCamera = useCallback(async () => {
    setCamError("");
    try {
      const handle = await startWebcam((reason) => engageLock(reason));
      webcamRef.current?.stop();
      webcamRef.current = handle;
      setTimeout(() => attachVideo(handle), 50);
      setCamReady(true);
    } catch {
      setCamError("Could not access the camera. Allow camera access and make sure no other app is using it.");
      setCamReady(false);
    }
  }, [engageLock, attachVideo]);

  const goPreflight = useCallback(() => {
    setErr("");
    setPhase("preflight");
    if (proctoringRef.current.requireWebcam) void enableCamera();
    if (proctoringRef.current.requireSingleScreen) void getDisplayCount().then(setDisplayCount).catch(() => {});
  }, [enableCamera]);

  // Poll the monitor count while on the preflight gate.
  useEffect(() => {
    if (phase !== "preflight" || !proctoringRef.current.requireSingleScreen) return;
    const t = setInterval(() => { void getDisplayCount().then(setDisplayCount).catch(() => {}); }, 1500);
    return () => clearInterval(t);
  }, [phase]);

  const startExam = useCallback(async () => {
    if (!examId || !student || !bundle) return;
    if (proctoringRef.current.requireWebcam && !camReady) { setCamError("Enable your camera to start."); return; }
    if (!online) { setErr("An internet connection is required to start this exam."); return; }
    if (proctoringRef.current.requireSingleScreen) {
      // Never let the display check block the start flow — cap it so a hung
      // permission prompt (seen inside SEB kiosk) can't freeze "Start secure exam".
      const count = await Promise.race([
        getDisplayCount().catch(() => 1),
        new Promise<number>((r) => setTimeout(() => r(1), 1500)),
      ]);
      setDisplayCount(count);
      if (count > 1) { setErr("Disconnect all extra monitors — only one display is allowed during the exam."); return; }
    }
    try {
      const start = await api.start(examId);
      // Restore any answers saved locally before a forced logout (network drop).
      const saved = loadProgress(examId);
      let endAt = new Date(start.endAt).getTime();
      // If this exam was interrupted (saved progress exists), commit the outage
      // to the server so the deadline shifts by however long we were offline.
      if (saved) {
        try {
          const res = await api.resume(examId, 0);
          endAt = new Date(res.endAt).getTime();
        } catch { /* keep the start endAt */ }
      }
      setSession({
        attemptId: start.attemptId,
        endAt,
        answers: saved?.answers ?? {},
        flags: saved?.flags ?? {},
        integrityEvents: [],
      });
      enterRunning();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start exam");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, student, bundle, camReady, online]);

  function enterRunning() {
    setPhase("running");
    // Mark this exam as the active in-progress attempt so a forced logout
    // (e.g. internet loss) can bounce the student straight back to it on relogin.
    if (examId) { try { localStorage.setItem(ACTIVE_EXAM_KEY, examId); } catch { /* ignore */ } }
    if (proctoringRef.current.fullscreenRequired) void requestFullscreen();
  }

  // Try to restore the camera while locked, and auto-unlock once the lock time
  // has elapsed AND the camera is back.
  const tryRestoreCamera = useCallback(async () => {
    try {
      const handle = await startWebcam((reason) => engageLock(reason));
      webcamRef.current?.stop();
      webcamRef.current = handle;
      attachVideo(handle);
      setCamReady(true);
      setCamError("");
      return true;
    } catch {
      setCamError("Camera is still unavailable. Please reconnect / allow your camera.");
      return false;
    }
  }, [engageLock, attachVideo]);

  useEffect(() => {
    if (locked && lockLeft === 0) {
      void (async () => {
        const ok = await tryRestoreCamera();
        if (ok) {
          setLocked(false);
          pushAlert("Camera restored — exam resumed. This was recorded.", "warn");
          if (proctoringRef.current.fullscreenRequired) void requestFullscreen();
        }
      })();
    }
  }, [locked, lockLeft, tryRestoreCamera, pushAlert]);

  // ---- Network-loss handling: freeze behind an overlay, resume on reconnect ----
  // When the internet drops mid-exam we DON'T log the student out. Instead we
  // pause the attempt (server freezes the clock), show a blocking overlay, and
  // measure how long we were offline. On reconnect we tell the server the outage
  // duration so it grants that time back and pushes the deadline out, then we
  // update the local countdown to the new server-anchored endAt.
  useEffect(() => {
    if (phase !== "running" || submittedRef.current || !examId) return;
    if (!online) {
      if (offlineSinceRef.current == null) {
        offlineSinceRef.current = Date.now();
        setNetLost(true);
        const s = sessionRef.current;
        if (s) saveProgress(examId, { answers: s.answers, flags: s.flags });
        try { localStorage.setItem(ACTIVE_EXAM_KEY, examId); } catch { /* ignore */ }
        // Tell the server the outage started (freezes the clock server-side too).
        void api.pause(examId).catch(() => {});
      }
    } else if (offlineSinceRef.current != null) {
      const offlineMs = Date.now() - offlineSinceRef.current;
      offlineSinceRef.current = null;
      void api
        .resume(examId, offlineMs)
        .then((info) => {
          const newEnd = new Date(info.endAt).getTime();
          if (Number.isFinite(newEnd)) setSession((prev) => (prev ? { ...prev, endAt: newEnd } : prev));
          pushAlert("Connection restored — exam resumed. The time lost while offline has been added back.", "warn");
        })
        .catch(() => {
          pushAlert("Connection restored — exam resumed.", "warn");
        })
        .finally(() => setNetLost(false));
    }
  }, [online, phase, examId, pushAlert]);

  // ---- Proctoring while running ----
  // DISABLED on web: real proctored exams run inside Safe Exam Browser (SEB),
  // which enforces lockdown at the OS level. The browser build is preview-only,
  // so tab-switch / focus-loss detection and auto-submit are intentionally off
  // here — switching tabs must NOT flag violations or submit the exam.

  // ---- Webcam lifecycle while running ----
  useEffect(() => {
    if (phase !== "running" || !proctoringRef.current.requireWebcam) return;
    if (webcamRef.current) attachVideo(webcamRef.current);
  }, [phase, attachVideo]);

  // Cleanup webcam + lock timer on unmount.
  useEffect(() => {
    return () => {
      webcamRef.current?.stop();
      webcamRef.current = null;
      if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    };
  }, []);

  // ---- Timer tick ----
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // ---- Single-screen watchdog while running ----
  useEffect(() => {
    if (phase !== "running" || !proctoringRef.current.requireSingleScreen) return;
    const check = () => void getDisplayCount().then((n) => {
      setDisplayCount(n);
      setScreenLocked(n > 1);
    }).catch(() => {});
    const t = setInterval(check, 2500);
    check();
    return () => clearInterval(t);
  }, [phase]);

  // Live server-anchored countdown.
  const remaining = session ? session.endAt - now : 0;

  // ---- Submit ----
  const doSubmit = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || submittedRef.current || !bundle) return;
    submittedRef.current = true;
    setSubmitting(true);

    const answers = bundle.questions
      .filter((q) => s.answers[q.id] != null && String(s.answers[q.id]).length > 0)
      .map((q) => ({ questionId: q.id, response: s.answers[q.id] }));
    const answered = answers.length;
    const skipped = bundle.questions.length - answered;
    const payload = { answers, integrityEvents: s.integrityEvents };

    try {
      // Stop the camera / fullscreen immediately; show the "validating" screen
      // while the server auto-grades (AI grades coding + short answers on submit).
      webcamRef.current?.stop();
      webcamRef.current = null;
      if (lockTimerRef.current) clearInterval(lockTimerRef.current);
      setLocked(false);
      void exitFullscreen();
      setPhase("validating");
      const res = await api.submit(s.attemptId, payload);
      if (examId) clearProgress(examId);
      setResult({ answered, skipped, events: s.integrityEvents.length, attemptId: s.attemptId, score: res.score ?? null });
      setSubmitting(false);
      setPhase("done");
    } catch {
      // Live exam requires connectivity to submit — retry once online returns.
      submittedRef.current = false;
      setSubmitting(false);
      setPhase("running");
      setErr("Couldn't submit — connection lost. Reconnect and press Submit again. Your answers are safe on this device.");
    }
  }, [bundle, examId]);

  const doSubmitRef = useRef<typeof doSubmit | null>(null);
  doSubmitRef.current = doSubmit;

  useEffect(() => {
    // Auto-submit on timeout — only when the admin left the grace toggle on, online and not network-locked.
    if (phase === "running" && session && online && remaining <= 0 && proctoringRef.current.autoSubmitOnTimeout) void doSubmit();
  }, [phase, session, remaining, online, doSubmit]);

  // Persist answers/flags locally on every change while running, so a forced
  // logout (internet drop) never loses work.
  useEffect(() => {
    if (phase === "running" && examId && session) {
      saveProgress(examId, { answers: session.answers, flags: session.flags });
    }
  }, [phase, examId, session]);

  // ---- Answer handlers ----
  function setAnswer(qId: string, value: unknown) {
    setSession((prev) => (prev ? { ...prev, answers: { ...prev.answers, [qId]: value } } : prev));
  }
  function toggleFlag(qId: string) {
    setSession((prev) => (prev ? { ...prev, flags: { ...prev.flags, [qId]: !prev.flags[qId] } } : prev));
  }

  const questions = bundle?.questions ?? [];
  const answeredCount = useMemo(() => (session ? questions.filter((q) => session.answers[q.id] != null && String(session.answers[q.id]).length > 0).length : 0), [session, questions]);
  const flagCount = useMemo(() => (session ? questions.filter((q) => session.flags[q.id]).length : 0), [session, questions]);

  if (!examId) return null;

  // ===== BRIEF =====
  if (phase === "brief") {
    return (
      <div className="runner">
        <div className="runner-top">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate("/")}><Icon name="arrow-left" /> Back</button>
            <span style={{ fontWeight: 700 }}>{bundle?.exam.title || "Exam"}</span>
          </div>
          <NetBadge online={online} />
        </div>
        <div style={{ maxWidth: 640, margin: "0 auto", padding: 40, width: "100%" }}>
          <div className="card" style={{ padding: 30 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--color-brand-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand)" }}><Icon name="shield-check" size={20} /></div>
            </div>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, margin: "10px 0 4px" }}>{bundle?.exam.title || "Loading exam…"}</h1>
            {bundle && <p style={{ color: "var(--color-ink2)", marginBottom: 20 }}>{bundle.questions.length} questions · {bundle.exam.durationMin} minutes · {bundle.exam.totalPoints} points</p>}

            <div style={{ display: "grid", gap: 10, marginBottom: 24 }}>
              {[
                ["monitor", "Fullscreen lockdown for the whole exam"],
                ["timer", "One timer for the whole exam — auto-submits at zero"],
                ["flag", "Flag questions to revisit, jump freely between them"],
              ].map(([ic, txt]) => (
                <div key={txt} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, color: "var(--color-ink2)" }}>
                  <Icon name={ic!} size={16} /> {txt}
                </div>
              ))}
            </div>

            {err && <div style={{ display: "flex", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13, marginBottom: 16 }}><Icon name="triangle-alert" size={15} /> {err}</div>}

            <button className="btn btn-primary" style={{ width: "100%", padding: 13, fontSize: 14 }} disabled={!bundle} onClick={goPreflight}>
              <Icon name="play" /> Start exam
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== PREFLIGHT (webcam + internet gate) =====
  if (phase === "preflight") {
    const needCam = proctoring.requireWebcam;
    const needSingle = proctoring.requireSingleScreen;
    const netOk = online;
    const camOk = !needCam || camReady;
    const screenOk = !needSingle || displayCount <= 1;
    const canStart = netOk && camOk && screenOk;
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 32, maxWidth: 520, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--color-brand-soft)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}><Icon name="shield-check" size={26} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 4 }}>System check</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14 }}>We need to verify your setup before the exam begins.</p>
          </div>

          {needCam && (
            <div style={{ marginBottom: 16 }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxHeight: 220, borderRadius: 12, background: "#0b1220", objectFit: "cover", transform: "scaleX(-1)" }} />
            </div>
          )}

          <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
            {needCam && <CheckRow ok={camOk} label="Webcam" detail={camOk ? "Camera active" : camError || "Camera not detected — click Enable camera"} />}
            <CheckRow ok={netOk} label="Internet connection" detail={netOk ? "Connected" : "Waiting for a connection to start the exam"} />
            {needSingle && <CheckRow ok={screenOk} label="Single display" detail={screenOk ? "One monitor detected" : `${displayCount} monitors detected — disconnect extra displays`} />}
          </div>

          {camError && needCam && (
            <div style={{ display: "flex", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13, marginBottom: 14 }}><Icon name="triangle-alert" size={15} /> {camError}</div>
          )}
          {err && (
            <div style={{ display: "flex", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13, marginBottom: 14 }}><Icon name="triangle-alert" size={15} /> {err}</div>
          )}

          {needCam && !camReady && (
            <button className="btn btn-ghost" style={{ width: "100%", padding: 11, marginBottom: 10 }} onClick={() => void enableCamera()}>
              <Icon name="video" /> Enable camera
            </button>
          )}
          <button className="btn btn-primary" style={{ width: "100%", padding: 13 }} disabled={!canStart} onClick={() => void startExam()}>
            <Icon name="play" /> {canStart ? "Start secure exam" : needCam && !camOk ? "Enable your camera to start" : needSingle && !screenOk ? "Disconnect extra monitors to start" : "Waiting for connection…"}
          </button>
          <button className="btn btn-ghost btn-sm" style={{ width: "100%", marginTop: 10 }} onClick={() => { webcamRef.current?.stop(); webcamRef.current = null; setCamReady(false); navigate("/"); }}>Cancel</button>
        </div>
      </div>
    );
  }

  // ===== VALIDATING (submitting) =====
  if (phase === "validating") {
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 36, maxWidth: 440, width: "100%", textAlign: "center" }}>
          <div style={{ width: 58, height: 58, borderRadius: 999, background: "var(--color-brand-soft)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="loader-circle" size={28} className="animate-spin" /></div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 24, marginBottom: 6 }}>Submitting your exam</h1>
          <p style={{ color: "var(--color-ink2)" }}>Your answers are being submitted. This only takes a moment — please don't close this window.</p>
        </div>
      </div>
    );
  }

  // ===== DONE =====
  // Show the score immediately as marks out of 100 (the server returns a
  // percentage on a 0–100 scale, so "X/100" is the same number framed as marks).
  // The detailed answer report is NOT available to students — only the score.
  if (phase === "done" && result) {
    const marks = result.score != null ? Math.round(result.score) : null;
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 36, maxWidth: 480, width: "100%", textAlign: "center" }}>
          <div style={{ width: 58, height: 58, borderRadius: 999, background: "#e7f5ee", color: "var(--color-success)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="check" size={30} /></div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, marginBottom: 6 }}>Exam submitted</h1>
          <p style={{ color: "var(--color-ink2)", marginBottom: 20, lineHeight: 1.6 }}>Your answers were submitted and scored successfully.</p>

          {marks != null && (
            <div style={{ background: "var(--color-brand-soft)", borderRadius: 14, padding: "16px 14px", marginBottom: 12 }}>
              <div className="mono-label" style={{ marginBottom: 4 }}>Your score</div>
              <div className="stat-num" style={{ fontSize: 38, lineHeight: 1 }}>{marks}<span style={{ fontSize: 20, color: "var(--color-ink2)" }}>/100</span></div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 22 }}>
            <div style={{ background: "#e7f5ee", borderRadius: 12, padding: "14px 10px" }}>
              <div className="stat-num" style={{ fontSize: 22, color: "var(--color-success)" }}>{result.answered}</div>
              <div className="mono-label">Answered</div>
            </div>
            <div style={{ background: "#fdf3e7", borderRadius: 12, padding: "14px 10px" }}>
              <div className="stat-num" style={{ fontSize: 22, color: "var(--color-warn)" }}>{result.skipped}</div>
              <div className="mono-label">Skipped</div>
            </div>
          </div>

          <button className="btn btn-primary" style={{ width: "100%", padding: 12 }} onClick={() => { if (examId) clearProgress(examId); navigate("/"); }}>
            <Icon name="layout-dashboard" /> Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  // ===== RUNNING =====
  if (phase !== "running" || !session || questions.length === 0) {
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-ink2)" }}>
          <Icon name="loader-circle" className="animate-spin" /> Preparing…
        </div>
        {err && <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={startExam}>Retry start</button>}
      </div>
    );
  }

  const q = questions[cur];
  if (!q) return null;
  const danger = remaining < 60_000;

  return (
    <div className="runner">
      {/* Violation alerts */}
      {alerts.length > 0 && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "grid", gap: 8, width: "min(560px, 92vw)" }}>
          {alerts.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 500, color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.25)", background: a.tone === "danger" ? "var(--color-danger)" : "var(--color-warn)" }}>
              <Icon name="triangle-alert" size={16} /> {a.text}
            </div>
          ))}
        </div>
      )}

      {/* Second-monitor lock overlay */}
      {screenLocked && !locked && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(8,12,20,.92)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <div className="card" style={{ padding: 34, maxWidth: 440, textAlign: "center" }}>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: "var(--color-danger-bg)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="monitor-x" size={28} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 6 }}>Extra monitor detected</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 18 }}>Only one display is allowed during this exam. {displayCount} monitors are currently connected. Disconnect the extra display to continue — this has been recorded and the timer keeps running.</p>
            <div className="mono-label" style={{ color: "#8ba0bd" }}>Waiting for a single display…</div>
          </div>
        </div>
      )}

      {/* Camera-loss lock overlay */}
      {locked && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(8,12,20,.92)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <div className="card" style={{ padding: 34, maxWidth: 440, textAlign: "center" }}>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: "var(--color-danger-bg)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="video-off" size={28} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 6 }}>Exam locked</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 18 }}>Your camera was turned off. The exam is paused and this has been recorded. It will unlock shortly — keep your camera on for the rest of the exam.</p>
            <div className="timer-big timer-danger" style={{ justifyContent: "center", marginBottom: 18 }}><Icon name="lock" size={20} /> {fmtClock(lockLeft * 1000)}</div>
            <button className="btn btn-primary" style={{ width: "100%", padding: 11 }} onClick={() => void tryRestoreCamera()}><Icon name="video" /> Re-enable camera now</button>
            {camError && <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--color-danger)" }}>{camError}</div>}
            <p style={{ marginTop: 14, fontSize: 12, color: "#8ba0bd" }}>The exam timer keeps running while locked.</p>
          </div>
        </div>
      )}

      {/* Internet-loss overlay — freezes the exam until the connection returns */}
      {netLost && (
        <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(8,12,20,.94)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <div className="card" style={{ padding: 34, maxWidth: 440, textAlign: "center" }}>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: "var(--color-danger-bg)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="wifi-off" size={28} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 6 }}>Internet disconnected</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 18 }}>Your exam is paused and your answers are saved on this device. The timer is frozen — the time lost while offline will be added back automatically once you reconnect. Do not close this window.</p>
            <div className="timer-big timer-danger" style={{ justifyContent: "center", marginBottom: 6 }}><Icon name="loader-circle" size={20} className="animate-spin" /> Waiting for connection…</div>
            <p style={{ marginTop: 14, fontSize: 12, color: "#8ba0bd" }}>The exam resumes the moment your internet is back.</p>
          </div>
        </div>
      )}

      <div className="runner-top">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontWeight: 700 }}>{bundle?.exam.title}</span>
          <span className="mono-label" style={{ color: "#8ba0bd" }}>Q{cur + 1} / {questions.length}</span>
        </div>
        <div className={`timer-big ${danger ? "timer-danger" : ""}`}>
          <Icon name="timer" size={20} /> {fmtClock(remaining)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {proctoring.requireWebcam && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: camReady ? "var(--color-success)" : "var(--color-danger)" }}>
              <Icon name={camReady ? "video" : "video-off"} size={15} /> {camReady ? "Camera on" : "Camera off"}
            </div>
          )}
          <NetBadge online={online} />
        </div>
      </div>

      {/* Live webcam preview */}
      {proctoring.requireWebcam && (
        <video ref={videoRef} autoPlay playsInline muted style={{ position: "fixed", bottom: 16, right: 16, width: 150, height: 112, borderRadius: 10, objectFit: "cover", background: "#0b1220", border: "2px solid rgba(255,255,255,.15)", transform: "scaleX(-1)", zIndex: 40, boxShadow: "0 6px 18px rgba(0,0,0,.3)" }} />
      )}

      <div className="runner-body">
        <div className="q-main">
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span className="pill" style={{ textTransform: "uppercase" }}>{q.type} · {q.points} pt</span>
              <button className={`btn btn-sm ${session.flags[q.id] ? "btn-danger" : "btn-ghost"}`} onClick={() => toggleFlag(q.id)}>
                <Icon name="flag" size={13} /> {session.flags[q.id] ? "Flagged for review" : "Flag for review"}
              </button>
            </div>
            <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.5, marginBottom: 22 }}>{q.prompt}</div>

            <QuestionInput q={q} value={session.answers[q.id]} onChange={(v) => setAnswer(q.id, v)} online={online} />

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 30 }}>
              <button className="btn btn-ghost" disabled={cur === 0} onClick={() => setCur((c) => Math.max(0, c - 1))}><Icon name="arrow-left" /> Previous</button>
              <button className="btn btn-ghost" disabled={cur === questions.length - 1} onClick={() => setCur((c) => Math.min(questions.length - 1, c + 1))}>Next <Icon name="arrow-right" /></button>
            </div>

            {/* End-of-exam actions — only on the last question so Submit sits at the very end */}
            {cur === questions.length - 1 && (
              <div style={{ marginTop: 36, paddingTop: 24, borderTop: "1px solid var(--color-line)", display: "grid", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 13.5, color: "var(--color-ink2)" }}>
                  <span><strong>{answeredCount}</strong> of {questions.length} answered</span>
                  {flagCount > 0 && <span style={{ color: "var(--color-warn)" }}><Icon name="flag" size={13} /> {flagCount} flagged for review</span>}
                </div>
                {flagCount > 0 && (
                  <button className="btn btn-ghost" onClick={() => { const idx = questions.findIndex((qq) => session.flags[qq.id]); if (idx >= 0) setCur(idx); }}>
                    <Icon name="flag" /> Review flagged questions
                  </button>
                )}
                <button className="btn btn-primary" style={{ padding: 14, fontSize: 15 }} onClick={() => void doSubmit()} disabled={submitting}>
                  {submitting ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="send" />} Submit exam
                </button>
              </div>
            )}
          </div>
        </div>

        <aside className="q-side">
          <div className="side-finish">
            <div className="side-finish-stats">
              <span><strong>{answeredCount}</strong>/{questions.length} answered</span>
              {flagCount > 0 && <span style={{ color: "var(--color-warn)" }}><Icon name="flag" size={12} /> {flagCount} flagged</span>}
            </div>
            <button className="btn btn-primary" onClick={() => void doSubmit()} disabled={submitting}>
              {submitting ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="send" />} Finish exam
            </button>
          </div>
          <div className="mono-label" style={{ marginBottom: 12 }}>Question palette</div>
          <div className="palette-grid" style={{ marginBottom: 18 }}>
            {questions.map((qq, i) => {
              const answered = session.answers[qq.id] != null && String(session.answers[qq.id]).length > 0;
              const flagged = session.flags[qq.id];
              return (
                <button key={qq.id} className={`pal-cell ${i === cur ? "cur" : ""} ${flagged ? "pal-flag" : answered ? "pal-answered" : ""}`} onClick={() => setCur(i)}>
                  {i + 1}
                  {flagged && <span className="pal-flag-dot" />}
                </button>
              );
            })}
          </div>
          <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
            <div className="legend-row"><span className="legend-sw pal-answered" /> Answered · {answeredCount}</div>
            <div className="legend-row"><span className="legend-sw" /> Unanswered · {questions.length - answeredCount}</div>
            <div className="legend-row"><span className="legend-sw pal-flag" /> Review later · {flagCount}</div>
          </div>
          {flagCount > 0 && (
            <div>
              <div className="mono-label" style={{ marginBottom: 8 }}>Flagged for review</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {questions.map((qq, i) => session.flags[qq.id] ? (
                  <button key={qq.id} className="btn btn-sm btn-ghost" onClick={() => setCur(i)}>Q{i + 1}</button>
                ) : null)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--color-line)", background: ok ? "#e7f5ee" : "#fdf3e2" }}>
      <div style={{ width: 30, height: 30, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: ok ? "var(--color-success)" : "var(--color-warn)", color: "#fff", flex: "none" }}>
        <Icon name={ok ? "check" : "clock"} size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--color-ink2)" }}>{detail}</div>
      </div>
    </div>
  );
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function QuestionInput({ q, value, onChange, online }: { q: BundleQuestion; value: unknown; onChange: (v: unknown) => void; online: boolean }) {
  if ((q.type === "mcq" || q.type === "fillblank") && q.options) {
    const sel = value as number | undefined;
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {q.options.map((opt, i) => (
          <div key={i} className={`opt-row ${sel === i ? "sel" : ""}`} onClick={() => onChange(i)}>
            <span className="opt-letter">{LETTERS[i]}</span>
            <span style={{ paddingTop: 2 }}>{opt}</span>
          </div>
        ))}
      </div>
    );
  }
  if (q.type === "multi" && q.options) {
    const arr = (Array.isArray(value) ? value : []) as number[];
    const toggle = (i: number) => onChange(arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i].sort());
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {q.options.map((opt, i) => (
          <div key={i} className={`opt-row ${arr.includes(i) ? "sel" : ""}`} onClick={() => toggle(i)}>
            <span className="opt-letter" style={{ borderRadius: 6 }}>{arr.includes(i) ? "✓" : LETTERS[i]}</span>
            <span style={{ paddingTop: 2 }}>{opt}</span>
          </div>
        ))}
      </div>
    );
  }
  if (q.type === "truefalse") {
    const sel = value as boolean | undefined;
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {[["True", true], ["False", false]].map(([lbl, val]) => (
          <div key={String(val)} className={`opt-row ${sel === val ? "sel" : ""}`} onClick={() => onChange(val)}>
            <span className="opt-letter">{val ? "T" : "F"}</span>
            <span style={{ paddingTop: 2 }}>{lbl as string}</span>
          </div>
        ))}
      </div>
    );
  }
  if (q.type === "coding") {
    return <CodingInput q={q} value={value} onChange={onChange} online={online} />;
  }
  return (
    <textarea className="input" style={{ minHeight: 160, resize: "vertical", fontFamily: "var(--font-sans)", lineHeight: 1.6 }} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="Type your answer…" />
  );
}

// ---- Lightweight syntax highlighter (no deps) ----
const CODE_KEYWORDS: Record<string, Set<string>> = {
  python: new Set(["False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield","self","print","range","len","str","int","float","list","dict","set","tuple","bool","input","enumerate","zip","map","filter","sum","min","max","abs","sorted","open"]),
  javascript: new Set(["var","let","const","function","return","if","else","for","while","do","switch","case","break","continue","default","class","extends","super","new","this","typeof","instanceof","in","of","try","catch","finally","throw","async","await","yield","import","export","from","as","null","undefined","true","false","void","delete","console","log"]),
  java: new Set(["abstract","assert","boolean","break","byte","case","catch","char","class","const","continue","default","do","double","else","enum","extends","final","finally","float","for","goto","if","implements","import","instanceof","int","interface","long","native","new","package","private","protected","public","return","short","static","strictfp","super","switch","synchronized","this","throw","throws","transient","try","void","volatile","while","true","false","null","String","System","out","println","print"]),
  c: new Set(["auto","break","case","char","const","continue","default","do","double","else","enum","extern","float","for","goto","if","inline","int","long","register","restrict","return","short","signed","sizeof","static","struct","switch","typedef","union","unsigned","void","volatile","while","printf","scanf","include","define","std","cout","cin","endl","using","namespace","class","public","private","new","delete","bool","true","false"]),
};
function langKeywords(lang: string): Set<string> {
  const l = lang.toLowerCase();
  if (l.startsWith("py")) return CODE_KEYWORDS.python;
  if (l === "js" || l === "javascript" || l === "node" || l === "ts" || l === "typescript") return CODE_KEYWORDS.javascript;
  if (l === "java" || l === "kotlin") return CODE_KEYWORDS.java;
  if (l === "c" || l === "cpp" || l === "c++" || l === "csharp" || l === "c#" || l === "go" || l === "rust") return CODE_KEYWORDS.c;
  return CODE_KEYWORDS.python;
}
function escHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function highlightCode(code: string, lang: string): string {
  const kw = langKeywords(lang);
  const re = /(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.eExXbBoOaAfF]*\b)|([A-Za-z_$][\w$]*)/g;
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    out += escHtml(code.slice(last, m.index));
    if (m[1]) out += `<span class="tk-com">${escHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tk-str">${escHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tk-num">${escHtml(m[3])}</span>`;
    else {
      const w = m[4];
      const rest = code.slice(m.index + w.length);
      if (kw.has(w)) out += `<span class="tk-kw">${escHtml(w)}</span>`;
      else if (/^\s*\(/.test(rest)) out += `<span class="tk-fn">${escHtml(w)}</span>`;
      else if (/^[A-Z]/.test(w)) out += `<span class="tk-type">${escHtml(w)}</span>`;
      else out += escHtml(w);
    }
    last = m.index + m[0].length;
  }
  out += escHtml(code.slice(last));
  return out + "\n";
}

function CodeEditor({ code, language, onChange }: { code: string; language: string; onChange: (v: string) => void }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, code.split("\n").length);

  function syncScroll() {
    const ta = taRef.current; if (!ta) return;
    if (preRef.current) { preRef.current.scrollTop = ta.scrollTop; preRef.current.scrollLeft = ta.scrollLeft; }
    if (gutRef.current) gutRef.current.scrollTop = ta.scrollTop;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const start = ta.selectionStart, end = ta.selectionEnd;
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        // dedent line start
        const lineStart = code.lastIndexOf("\n", start - 1) + 1;
        const removed = code.slice(lineStart).match(/^( {1,4}|\t)/);
        if (removed) {
          const n = removed[0].length;
          const next = code.slice(0, lineStart) + code.slice(lineStart + n);
          onChange(next);
          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start - n); });
        }
      } else {
        const next = code.slice(0, start) + "    " + code.slice(end);
        onChange(next);
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 4; });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const lineStart = code.lastIndexOf("\n", start - 1) + 1;
      const curLine = code.slice(lineStart, start);
      const indent = (curLine.match(/^[ \t]*/) || [""])[0];
      const extra = /[:{[(]\s*$/.test(curLine.trimEnd()) ? "    " : "";
      const insert = "\n" + indent + extra;
      const next = code.slice(0, start) + insert + code.slice(end);
      onChange(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + insert.length; });
    }
  }

  return (
    <div className="ide">
      <div className="ide-gutter" ref={gutRef}>
        {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div className="ide-code">
        <pre className="ide-hl" ref={preRef} aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }} /></pre>
        <textarea
          ref={taRef}
          className="ide-input"
          value={code}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Write your solution here…"
        />
      </div>
    </div>
  );
}

function CodingInput({ q, value, onChange, online }: { q: BundleQuestion; value: unknown; onChange: (v: unknown) => void; online: boolean }) {
  const code = (value as string) ?? q.meta.starter ?? "";
  const language = q.meta.language || "python";
  const languageId = q.meta.languageId;
  const languageLabel = q.meta.languageLabel || language;
  const [stdin, setStdin] = useState("");
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string; status?: string } | null>(null);

  async function run() {
    setRunning(true);
    setOut(null);
    try {
      const res = await api.runCode(code, language, stdin, languageId);
      const parts = [res.compileOutput, res.stderr, res.stdout].map((x) => (x || "").trim()).filter(Boolean);
      setOut({ ok: !(res.stderr || res.compileOutput), text: parts.join("\n\n") || "(no output)", status: res.status });
    } catch (e) {
      setOut({ ok: false, text: e instanceof Error ? e.message : "Couldn't run your code." });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div className="mono-label">{languageLabel} · your solution</div>
        <button className="btn btn-ghost btn-sm" onClick={() => void run()} disabled={running || !online || !code.trim()}>
          {running ? <Icon name="loader-circle" className="animate-spin" size={14} /> : <Icon name="play" size={14} />} {running ? "Running…" : "Run code"}
        </button>
      </div>
      <CodeEditor code={code} language={language} onChange={(v) => onChange(v)} />
      <div style={{ marginTop: 12 }}>
        <div className="mono-label" style={{ marginBottom: 6 }}>Custom input (stdin) — optional</div>
        <textarea className="code-area" style={{ minHeight: 60 }} value={stdin} spellCheck={false} onChange={(e) => setStdin(e.target.value)} placeholder="Input passed to your program when you press Run" />
      </div>
      {!online && <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--color-warn)" }}>Reconnect to run your code.</div>}
      {out && (
        <div style={{ marginTop: 12 }}>
          <div className="mono-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <Icon name={out.ok ? "terminal" : "triangle-alert"} size={13} /> Output{out.status ? ` · ${out.status}` : ""}
          </div>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 13, background: "#0f1b2b", color: out.ok ? "#b7f7c8" : "#ffb4b4", padding: 14, borderRadius: 11, lineHeight: 1.55, margin: 0, maxHeight: 240, overflow: "auto" }}>{out.text}</pre>
        </div>
      )}
    </div>
  );
}
