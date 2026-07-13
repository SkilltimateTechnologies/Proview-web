import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { api, type Bundle, type BundleQuestion, type ProctorConfig, DEFAULT_PROCTORING } from "../lib/api";
import { useSession } from "../lib/session";
import { requestFullscreen, exitFullscreen, startWebcam, getDisplayCount, type ProctorEvent, type WebcamHandle } from "../lib/proctor";
import { Icon, NetBadge, useOnline } from "../components/ui";

type Phase = "brief" | "preflight" | "resume" | "running" | "validating" | "done";

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
// We persist attemptId + the server-anchored absolute endAt alongside answers so
// that a REFRESH WHILE OFFLINE can rebuild the running session without hitting the
// network. endAt is an absolute wall-clock deadline (not a countdown), so it stays
// honest across a reload; the online heartbeat re-reads the authoritative server
// endAt on reconnect and corrects any drift (admin hold / extra time).
type SavedProgress = { answers: Record<string, unknown>; flags: Record<string, boolean>; cur?: number; attemptId?: string; endAt?: number };
function progressKey(examId: string) { return `examly:progress:${examId}`; }
function saveProgress(examId: string, p: SavedProgress) {
  try {
    // Merge so a partial save (e.g. answers only) never wipes attemptId/endAt.
    const prev = loadProgress(examId) ?? {};
    localStorage.setItem(progressKey(examId), JSON.stringify({ ...prev, ...p }));
  } catch { /* ignore */ }
}
function loadProgress(examId: string): SavedProgress | null {
  try {
    const raw = localStorage.getItem(progressKey(examId));
    return raw ? (JSON.parse(raw) as SavedProgress) : null;
  } catch { return null; }
}
function clearProgress(examId: string) {
  try { localStorage.removeItem(progressKey(examId)); localStorage.removeItem(ACTIVE_EXAM_KEY); localStorage.removeItem(bundleKey(examId)); } catch { /* ignore */ }
}

// Cache the exam bundle locally so a mid-exam refresh works even with no internet
// (the bundle is otherwise fetched fresh from the server on every mount).
function bundleKey(examId: string) { return `examly:bundle:${examId}`; }
function cacheBundle(examId: string, b: Bundle) {
  try { localStorage.setItem(bundleKey(examId), JSON.stringify(b)); } catch { /* ignore */ }
}
function loadCachedBundle(examId: string): Bundle | null {
  try {
    const raw = localStorage.getItem(bundleKey(examId));
    return raw ? (JSON.parse(raw) as Bundle) : null;
  } catch { return null; }
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
  // Grading poll: after submit, AI grades subjective/coding in the background.
  // We poll the attempt status until it flips to "graded", then reveal the real
  // final score (the score returned inline at submit is objective-only/partial).
  const [gradeDone, setGradeDone] = useState(false);
  const [gradedScore, setGradedScore] = useState<number | null>(null);

  const sessionRef = useRef<RunSession | null>(null);
  sessionRef.current = session;
  const submittedRef = useRef(false);
  const curRef = useRef(0);
  curRef.current = cur;
  // Guards the run-once resume-on-mount probe.
  const resumeCheckedRef = useRef(false);

  // Proctoring config comes from the exam bundle (admin-configured); fall back to defaults.
  const proctoring: ProctorConfig = bundle?.proctoring ? { ...DEFAULT_PROCTORING, ...bundle.proctoring } : DEFAULT_PROCTORING;
  const proctoringRef = useRef(proctoring);
  proctoringRef.current = proctoring;

  // Offline-first: when the internet drops we KEEP the exam running (answers are
  // saved locally and sync on reconnect). We only show a single toast on drop and
  // flip the network badge — no freeze, no logout. Time credit for a real outage
  // comes only from an admin GLOBAL hold, never from a single student's drop.
  const notifiedOfflineRef = useRef(false);
  // Real-time answer sync: `dirtyRef` holds question ids whose answers changed
  // but haven't reached the server yet. We flush on navigation + a 2s typing
  // debounce + heartbeat + reconnect. A failed flush leaves ids dirty to retry.
  const dirtyRef = useRef<Set<string>>(new Set());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);
  // Admin global hold: when the whole exam is held (venue outage) the heartbeat
  // reports held=true and we freeze behind an overlay until the admin resumes.
  const [held, setHeld] = useState(false);

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
  // Offline-first: hydrate immediately from the local cache (so a refresh works
  // with no internet), then refresh from the server in the background and re-cache.
  useEffect(() => {
    if (!examId) return;
    const cached = loadCachedBundle(examId);
    if (cached) setBundle(cached);
    api.bundle(examId).then((b) => {
      setBundle(b);
      cacheBundle(examId, b);
    }).catch(() => {
      // Only surface the error if we have nothing cached to fall back to.
      if (!loadCachedBundle(examId)) setErr("Couldn't load the exam. Check your connection and try again.");
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
      // Restore any answers saved locally (offline-first: survives a crash/reload).
      const saved = loadProgress(examId);
      // /start returns the server-anchored deadline already folding in any admin
      // hold time + extra minutes, so we use it directly.
      const endAt = new Date(start.endAt).getTime();
      setSession({
        attemptId: start.attemptId,
        endAt,
        answers: saved?.answers ?? {},
        flags: saved?.flags ?? {},
        integrityEvents: [],
      });
      // Persist attemptId + absolute deadline so an offline refresh can resume.
      saveProgress(examId, { attemptId: start.attemptId, endAt, answers: saved?.answers ?? {}, flags: saved?.flags ?? {}, cur: curRef.current });
      setHeld(!!start.held);
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

  // ---- Refresh-resume: detect an already-running attempt on mount ----
  // A mid-exam browser refresh must land the student back in the running exam
  // (same question, answers, server-anchored timer) — not on the brief/start
  // page. We probe the READ-ONLY status endpoint (never /start, which would
  // wrongly transition a not_started attempt to in_progress). Runs once, after
  // the bundle loads so the proctoring config is known.
  useEffect(() => {
    if (!examId || !bundle || resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    // OFFLINE refresh: the server is unreachable, so rebuild the running session
    // purely from local storage (attemptId + saved absolute endAt + answers). The
    // heartbeat will re-read the authoritative server endAt once we're back online.
    const resumeOffline = () => {
      const saved = loadProgress(examId);
      if (!saved?.attemptId || !saved.endAt) return false;
      setSession({
        attemptId: saved.attemptId,
        endAt: saved.endAt,
        answers: saved.answers ?? {},
        flags: saved.flags ?? {},
        integrityEvents: [],
      });
      if (typeof saved.cur === "number" && Number.isFinite(saved.cur)) setCur(saved.cur);
      const cfg = proctoringRef.current;
      if (cfg.requireWebcam || cfg.fullscreenRequired || cfg.requireSingleScreen) {
        setPhase("resume");
        if (cfg.requireWebcam) void enableCamera();
        if (cfg.requireSingleScreen) void getDisplayCount().then(setDisplayCount).catch(() => {});
      } else {
        enterRunning();
      }
      return true;
    };
    if (!navigator.onLine) { resumeOffline(); return; }
    void (async () => {
      try {
        const st = await api.status(examId);
        if (st.status === "submitted" || st.status === "graded") {
          // Already finished elsewhere — clear any stale local progress + go home.
          clearProgress(examId);
          return;
        }
        if (st.status !== "in_progress" || !st.endAt || !st.attemptId) return;
        // Rebuild the running session from server (attemptId + deadline) + local
        // progress (answers/flags/current question).
        const saved = loadProgress(examId);
        const endAt = new Date(st.endAt).getTime();
        setSession({
          attemptId: st.attemptId,
          endAt,
          answers: saved?.answers ?? {},
          flags: saved?.flags ?? {},
          integrityEvents: [],
        });
        // Refresh the persisted attemptId + deadline from the authoritative server.
        saveProgress(examId, { attemptId: st.attemptId, endAt, answers: saved?.answers ?? {}, flags: saved?.flags ?? {}, cur: saved?.cur });
        if (typeof saved?.cur === "number" && Number.isFinite(saved.cur)) setCur(saved.cur);
        setHeld(!!st.held);
        const cfg = proctoringRef.current;
        // Fullscreen re-entry (and camera) need a user gesture on reload, so if any
        // lockdown gate is on we show a one-click "Resume exam" screen. Otherwise
        // drop straight back into the running exam.
        if (cfg.requireWebcam || cfg.fullscreenRequired || cfg.requireSingleScreen) {
          setPhase("resume");
          if (cfg.requireWebcam) void enableCamera();
          if (cfg.requireSingleScreen) void getDisplayCount().then(setDisplayCount).catch(() => {});
        } else {
          enterRunning();
        }
      } catch {
        // Network died during the probe — try rebuilding from local storage so a
        // refresh mid-outage still resumes; otherwise leave on brief.
        resumeOffline();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, bundle]);

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

  // ---- Offline-first network handling (no freeze, no logout) ----
  // On the FIRST drop we save progress locally + show ONE toast, then stay quiet.
  // The exam keeps running; answers buffer on this device and sync on reconnect.
  useEffect(() => {
    if (phase !== "running" || submittedRef.current || !examId) return;
    if (!online) {
      if (!notifiedOfflineRef.current) {
        notifiedOfflineRef.current = true;
        const s = sessionRef.current;
        if (s) saveProgress(examId, { answers: s.answers, flags: s.flags, cur: curRef.current });
        try { localStorage.setItem(ACTIVE_EXAM_KEY, examId); } catch { /* ignore */ }
        pushAlert("You're offline — keep going, your answers are saved on this device and will sync when the connection returns.", "warn");
      }
    } else if (notifiedOfflineRef.current) {
      // Reconnected: sync buffered answers quietly (no toast), reset the flag.
      notifiedOfflineRef.current = false;
      const s = sessionRef.current;
      if (s) saveProgress(examId, { answers: s.answers, flags: s.flags, cur: curRef.current });
      // Flush every answer edited during the offline window (all still dirty).
      flushSyncRef.current();
    }
  }, [online, phase, examId, pushAlert]);

  // ---- Heartbeat + admin hold poll ----
  // Every ~15s while running + online: ping the server (drives the Live Monitor
  // online dot) and read back the current hold state + up-to-date deadline. This
  // is how an admin GLOBAL hold / resume / extra-time reaches every student
  // without a reload.
  useEffect(() => {
    if (phase !== "running" || !examId) return;
    let stopped = false;
    const beat = () => {
      if (stopped || submittedRef.current || !navigator.onLine) return;
      // Piggyback a sync on every heartbeat so any answer left dirty (e.g. the
      // student is idle on one question) reaches the server within ~15s.
      flushSyncRef.current();
      void api.heartbeat(examId)
        .then((info) => {
          if (stopped) return;
          setHeld(!!info.held);
          const newEnd = new Date(info.endAt).getTime();
          if (Number.isFinite(newEnd)) {
            setSession((prev) => (prev && newEnd !== prev.endAt ? { ...prev, endAt: newEnd } : prev));
            // Persist the latest server deadline so an offline refresh honours
            // any admin extra-time / hold that landed earlier.
            saveProgress(examId, { endAt: newEnd });
          }
        })
        .catch(() => {});
    };
    beat();
    const t = setInterval(beat, 15_000);
    return () => { stopped = true; clearInterval(t); };
  }, [phase, examId]);

  // ---- Grading poll after submit ----
  // Once the exam is submitted (phase "done"), poll the attempt status until it
  // flips to "graded", then reveal the real final score. The score returned
  // inline at submit is objective-only/partial, so we don't show it.
  useEffect(() => {
    if (phase !== "done" || !result || !examId || gradeDone) return;
    let stop = false;
    const poll = async () => {
      try {
        const st = await api.status(examId);
        if (stop) return;
        // Admin RESET: the attempt was flipped back to in_progress (e.g. submitted
        // by accident, or reopened with leftover time). Drop the score screen and
        // bounce the student straight back into the exam — resume screen if any
        // lockdown gate is on, otherwise straight into running — carrying their
        // saved answers and the fresh server-anchored deadline.
        if (st.status === "in_progress" && st.endAt && st.attemptId) {
          submittedRef.current = false;
          setResult(null);
          setGradeDone(false);
          setGradedScore(null);
          const saved = loadProgress(examId);
          const endAt = new Date(st.endAt).getTime();
          setSession({
            attemptId: st.attemptId,
            endAt,
            answers: saved?.answers ?? {},
            flags: saved?.flags ?? {},
            integrityEvents: [],
          });
          saveProgress(examId, { attemptId: st.attemptId, endAt, answers: saved?.answers ?? {}, flags: saved?.flags ?? {}, cur: saved?.cur });
          if (typeof saved?.cur === "number" && Number.isFinite(saved.cur)) setCur(saved.cur);
          setHeld(!!st.held);
          const cfg = proctoringRef.current;
          if (cfg.requireWebcam || cfg.fullscreenRequired || cfg.requireSingleScreen) {
            setPhase("resume");
            if (cfg.requireWebcam) void enableCamera();
            if (cfg.requireSingleScreen) void getDisplayCount().then(setDisplayCount).catch(() => {});
          } else {
            enterRunning();
          }
          return;
        }
        if (st.status === "graded") {
          setGradedScore(typeof st.score === "number" ? st.score : null);
          setGradeDone(true);
          return;
        }
      } catch { /* ignore, retry */ }
      if (!stop) timer = window.setTimeout(poll, 2500);
    };
    let timer = window.setTimeout(poll, 1500);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [phase, result, examId, gradeDone]);

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

  // ---- Timed "minutes left" warnings (10 min + 5 min) ----
  // A big blinking banner appears below the question when the countdown crosses
  // each threshold, then auto-hides after 10 seconds. Fires exactly once on the
  // downward crossing (a baseline is established on the first sample so resuming
  // an exam already below a threshold never triggers a false warning).
  const [timeAlert, setTimeAlert] = useState<number | null>(null);
  const prevRemRef = useRef<number>(Infinity);
  useEffect(() => {
    if (phase !== "running" || submittedRef.current) return;
    const prev = prevRemRef.current;
    prevRemRef.current = remaining;
    if (!Number.isFinite(prev)) return; // first sample: establish baseline only
    for (const th of [10, 5]) {
      const mark = th * 60_000;
      if (prev > mark && remaining <= mark) {
        setTimeAlert(th);
        window.setTimeout(() => setTimeAlert((v) => (v === th ? null : v)), 10_000);
      }
    }
  }, [remaining, phase]);

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
    // Auto-submit on timeout — only when the admin left the grace toggle on,
    // online, and NOT during an admin global hold (timer is frozen while held).
    if (phase === "running" && session && online && !held && remaining <= 0 && proctoringRef.current.autoSubmitOnTimeout) void doSubmit();
  }, [phase, session, remaining, online, held, doSubmit]);

  // Persist answers/flags locally on every change while running, so a forced
  // logout (internet drop) never loses work.
  useEffect(() => {
    if (phase === "running" && examId && session) {
      saveProgress(examId, { answers: session.answers, flags: session.flags, cur: curRef.current });
    }
  }, [phase, examId, session]);

  // ---- Real-time answer sync ----
  // Push every dirty answer to the server. Called on navigation, on a 2s typing
  // debounce, on each heartbeat, and on reconnect. Snapshots the dirty set so
  // concurrent edits aren't lost, and re-queues everything on failure to retry.
  const flushSync = useCallback(() => {
    if (syncingRef.current || submittedRef.current) return;
    const s = sessionRef.current;
    if (!s?.attemptId || !navigator.onLine || dirtyRef.current.size === 0) return;
    const ids = Array.from(dirtyRef.current);
    dirtyRef.current.clear();
    const answers = ids.map((questionId) => ({ questionId, response: s.answers[questionId] ?? null }));
    syncingRef.current = true;
    void api.syncAnswers(s.attemptId, answers)
      .catch(() => { for (const q of ids) dirtyRef.current.add(q); })
      .finally(() => { syncingRef.current = false; });
  }, []);
  const flushSyncRef = useRef(flushSync);
  flushSyncRef.current = flushSync;
  // Navigate to a question index, flushing any pending answer first so the DB is
  // always current the instant a student moves off a question.
  const navTo = useCallback((next: number | ((c: number) => number)) => {
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
    flushSyncRef.current();
    setCur(next);
  }, []);

  // ---- Answer handlers ----
  function setAnswer(qId: string, value: unknown) {
    setSession((prev) => (prev ? { ...prev, answers: { ...prev.answers, [qId]: value } } : prev));
    dirtyRef.current.add(qId);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => flushSyncRef.current(), 2000);
  }
  function toggleFlag(qId: string) {
    setSession((prev) => (prev ? { ...prev, flags: { ...prev.flags, [qId]: !prev.flags[qId] } } : prev));
  }

  const questions = bundle?.questions ?? [];
  const answeredCount = useMemo(() => (session ? questions.filter((q) => session.answers[q.id] != null && String(session.answers[q.id]).length > 0).length : 0), [session, questions]);
  const flagCount = useMemo(() => (session ? questions.filter((q) => session.flags[q.id]).length : 0), [session, questions]);

  // Manual submit — warn if questions are still flagged for review so the
  // student gets a chance to unflag/revisit before finishing. Auto-submit on
  // timeout never runs through here (it calls doSubmit directly, silently).
  function handleSubmitClick() {
    if (flagCount > 0) {
      const ok = window.confirm(
        `You still have ${flagCount} question${flagCount > 1 ? "s" : ""} flagged for review.\n\n` +
          `Press Cancel to go back and review them, or OK to submit anyway.`,
      );
      if (!ok) return;
    }
    void doSubmit();
  }

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

  // ===== RESUME (after a mid-exam refresh) =====
  // The attempt is already running server-side; we just need a user gesture to
  // re-enter fullscreen / confirm the camera before dropping back in. The timer
  // keeps counting from the server-anchored deadline (no reset, no /start call).
  if (phase === "resume" && session) {
    const needCam = proctoring.requireWebcam;
    const needSingle = proctoring.requireSingleScreen;
    const camOk = !needCam || camReady;
    const screenOk = !needSingle || displayCount <= 1;
    const canResume = camOk && screenOk;
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 32, maxWidth: 520, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--color-brand-soft)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}><Icon name="rotate-ccw" size={26} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 4 }}>Resume your exam</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14 }}>Your exam is still in progress. Your answers were saved on this device.</p>
            <div style={{ marginTop: 14, fontFamily: "var(--font-mono, monospace)", fontSize: 30, fontWeight: 700, color: remaining < 60_000 ? "var(--color-danger)" : "var(--color-ink)" }}>{fmtClock(remaining)}</div>
            <p style={{ color: "var(--color-ink2)", fontSize: 12 }}>time remaining</p>
          </div>

          {needCam && (
            <div style={{ marginBottom: 16 }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxHeight: 200, borderRadius: 12, background: "#0b1220", objectFit: "cover", transform: "scaleX(-1)" }} />
            </div>
          )}

          <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
            {needCam && <CheckRow ok={camOk} label="Webcam" detail={camOk ? "Camera active" : camError || "Camera not detected — click Enable camera"} />}
            {needSingle && <CheckRow ok={screenOk} label="Single display" detail={screenOk ? "One monitor detected" : `${displayCount} monitors detected — disconnect extra displays`} />}
          </div>

          {camError && needCam && (
            <div style={{ display: "flex", gap: 8, color: "var(--color-danger)", background: "var(--color-danger-bg)", padding: "10px 12px", borderRadius: 10, fontSize: 13, marginBottom: 14 }}><Icon name="triangle-alert" size={15} /> {camError}</div>
          )}

          {needCam && !camReady && (
            <button className="btn btn-ghost" style={{ width: "100%", padding: 11, marginBottom: 10 }} onClick={() => void enableCamera()}>
              <Icon name="video" /> Enable camera
            </button>
          )}
          <button className="btn btn-primary" style={{ width: "100%", padding: 13 }} disabled={!canResume} onClick={() => { if (proctoringRef.current.fullscreenRequired) void requestFullscreen(); enterRunning(); }}>
            <Icon name="play" /> {canResume ? "Resume exam" : needCam && !camOk ? "Enable your camera to resume" : "Disconnect extra monitors to resume"}
          </button>
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
  // At submit time only objective questions are graded inline; subjective/coding
  // are graded by AI in the background afterward. We poll the attempt status and
  // only show the real final score once grading finishes (gradeDone). Until then
  // we show a "grading in progress" state — never the partial submit-time score.
  if (phase === "done" && result) {
    return (
      <div className="runner" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 36, maxWidth: 480, width: "100%", textAlign: "center" }}>
          <div style={{ width: 58, height: 58, borderRadius: 999, background: "#e7f5ee", color: "var(--color-success)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="check" size={30} /></div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, marginBottom: 6 }}>Exam submitted</h1>
          <p style={{ color: "var(--color-ink2)", marginBottom: 20, lineHeight: 1.6 }}>Your answers were submitted successfully.</p>

          {!gradeDone ? (
            <div style={{ background: "var(--color-brand-soft)", borderRadius: 14, padding: "18px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12, justifyContent: "center" }}>
              <Icon name="loader-circle" size={18} className="animate-spin" />
              <span style={{ color: "var(--color-ink2)", fontSize: 13.5, lineHeight: 1.5, textAlign: "left" }}>Grading in progress… your final score will appear here in a moment.</span>
            </div>
          ) : gradedScore != null ? (
            <div style={{ background: "#e7f5ee", borderRadius: 14, padding: "18px 14px", marginBottom: 12 }}>
              <div className="mono-label" style={{ marginBottom: 4 }}>Your score</div>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 40, fontWeight: 700, color: "var(--color-success)", lineHeight: 1 }}>{Math.round(gradedScore)}<span style={{ fontSize: 20, color: "var(--color-ink2)" }}>/100</span></div>
            </div>
          ) : (
            <div style={{ background: "var(--color-brand-soft)", borderRadius: 14, padding: "16px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
              <Icon name="check" size={16} />
              <span style={{ color: "var(--color-ink2)", fontSize: 13.5, lineHeight: 1.5, textAlign: "left" }}>Grading complete. Your detailed result is available on your dashboard.</span>
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

      {/* Admin global-hold overlay — freezes the exam for everyone during a
          venue-wide outage until the administrator resumes it. Held time is
          added back to the deadline automatically. */}
      {held && (
        <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(8,12,20,.94)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <div className="card" style={{ padding: 34, maxWidth: 440, textAlign: "center" }}>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: "var(--color-warn-bg, #3a2c0a)", color: "var(--color-warn, #f0b429)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Icon name="pause" size={28} /></div>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginBottom: 6 }}>Exam paused by the administrator</h2>
            <p style={{ color: "var(--color-ink2)", fontSize: 14, marginBottom: 18 }}>The exam has been paused for everyone. Your answers are saved and the timer is frozen — the paused time will be added back automatically. Please wait, do not close this window.</p>
            <div className="timer-big" style={{ justifyContent: "center", marginBottom: 6 }}><Icon name="loader-circle" size={20} className="animate-spin" /> Waiting for the administrator to resume…</div>
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
              <button className="btn btn-ghost" disabled={cur === 0} onClick={() => navTo((c) => Math.max(0, c - 1))}><Icon name="arrow-left" /> Previous</button>
              <button className="btn btn-ghost" disabled={cur === questions.length - 1} onClick={() => navTo((c) => Math.min(questions.length - 1, c + 1))}>Next <Icon name="arrow-right" /></button>
            </div>

            {/* Big blinking "minutes left" alert (fires at 10 min + 5 min, auto-hides after 10s) */}
            {timeAlert != null && (
              <div className="time-alert-banner" role="alert">
                <Icon name="alarm-clock" size={30} />
                <span>{timeAlert} minute{timeAlert > 1 ? "s" : ""} left</span>
              </div>
            )}

            {/* End-of-exam actions — only on the last question so Submit sits at the very end */}
            {cur === questions.length - 1 && (
              <div style={{ marginTop: 36, paddingTop: 24, borderTop: "1px solid var(--color-line)", display: "grid", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 13.5, color: "var(--color-ink2)" }}>
                  <span><strong>{answeredCount}</strong> of {questions.length} answered</span>
                  {flagCount > 0 && <span style={{ color: "var(--color-warn)" }}><Icon name="flag" size={13} /> {flagCount} flagged for review</span>}
                </div>
                {flagCount > 0 && (
                  <button className="btn btn-ghost" onClick={() => { const idx = questions.findIndex((qq) => session.flags[qq.id]); if (idx >= 0) navTo(idx); }}>
                    <Icon name="flag" /> Review flagged questions
                  </button>
                )}
                <button className="btn btn-primary" style={{ padding: 14, fontSize: 15 }} onClick={handleSubmitClick} disabled={submitting}>
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
            <button className="btn btn-primary" onClick={handleSubmitClick} disabled={submitting}>
              {submitting ? <Icon name="loader-circle" className="animate-spin" /> : <Icon name="send" />} Finish exam
            </button>
          </div>
          <div className="mono-label" style={{ marginBottom: 12 }}>Question palette</div>
          <div className="palette-grid" style={{ marginBottom: 18 }}>
            {questions.map((qq, i) => {
              const answered = session.answers[qq.id] != null && String(session.answers[qq.id]).length > 0;
              const flagged = session.flags[qq.id];
              return (
                <button key={qq.id} className={`pal-cell ${i === cur ? "cur" : ""} ${flagged ? "pal-flag" : answered ? "pal-answered" : ""}`} onClick={() => navTo(i)}>
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
                  <button key={qq.id} className="btn btn-sm btn-ghost" onClick={() => navTo(i)}>Q{i + 1}</button>
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

  // Program tried to read input but the stdin box was empty → surface a clear hint
  // instead of the cryptic EOFError / NoSuchElementException from the runner.
  const needsInput =
    !!out &&
    !out.ok &&
    !stdin.trim() &&
    /EOFError|EOF when reading|NoSuchElementException|InputMismatchException|unexpected end of input|end of file|Scanner|no line found/i.test(out.text);

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
        <div className="mono-label" style={{ marginBottom: 4 }}>Custom input (stdin)</div>
        <div style={{ fontSize: 12, color: "var(--color-text-dim, #8ba0b8)", marginBottom: 6, lineHeight: 1.5 }}>
          If your program reads input (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>input()</code>, <code style={{ fontFamily: "var(--font-mono)" }}>Scanner</code>, <code style={{ fontFamily: "var(--font-mono)" }}>scanf</code>), type the values here — one per line — before you press Run.
        </div>
        <textarea className="code-area" style={{ minHeight: 60 }} value={stdin} spellCheck={false} onChange={(e) => setStdin(e.target.value)} placeholder={"Type the input your program expects, e.g.\n5"} />
      </div>
      {!online && <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--color-warn)" }}>Reconnect to run your code.</div>}
      {needsInput && (
        <div style={{ marginTop: 12, display: "flex", gap: 9, alignItems: "flex-start", background: "rgba(245,183,66,.12)", border: "1px solid rgba(245,183,66,.4)", borderRadius: 11, padding: "11px 13px" }}>
          <Icon name="info" size={15} style={{ marginTop: 1, color: "var(--color-warn, #f5b742)", flexShrink: 0 }} />
          <div style={{ fontSize: 12.8, lineHeight: 1.55 }}>
            Your program is waiting for input but none was provided. Type the value(s) it expects in the <b>Custom input (stdin)</b> box above, then press <b>Run code</b> again.
          </div>
        </div>
      )}
      {out && !needsInput && (
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
