// Student API client for the desktop client. Talks to the deployed backend.
// All requests carry the HMAC student token in the X-Student-Token header.

// Same-origin: the web server hosts both the student flow and the /api backend.
const API_URL = "";

export type StudentProfile = {
  id: string;
  tenantId: string;
  classId: string | null;
  rollNo: string;
  name: string;
  email: string | null;
  collegeName: string;
  collegeShort: string;
  primaryColor: string;
  logoUrl?: string | null;
  mustChangePassword?: boolean;
};

export type ExamListItem = {
  id: string;
  title: string;
  status: string;
  durationMin: number;
  totalPoints: number;
  questionCount: number;
  startAt: string | null;
  endAt: string | null;
  phase: "available" | "in_progress" | "finished" | "upcoming" | "closed" | "absent";
  resultsReady?: boolean;
  attempt: { id: string; status: string; score: number | null; submittedAt: string | null } | null;
};

export type BundleQuestion = {
  id: string;
  order: number;
  points: number;
  type: "mcq" | "multi" | "truefalse" | "fillblank" | "short" | "coding";
  prompt: string;
  options: string[] | null;
  difficulty: string;
  topic: string | null;
  meta: { language?: string; starter?: string; languageId?: number; languageLabel?: string };
};

export type ProctorConfig = {
  requireWebcam: boolean;
  requireInternet: boolean;
  blockOnCameraLoss: boolean;
  cameraLossLockSeconds: number;
  fullscreenRequired: boolean;
  blockCopyPaste: boolean;
  flagTabSwitch: boolean;
  maxTabSwitches: number;
  webcamSnapshots: boolean;
  snapshotIntervalSec: number;
  detectCameraBlock: boolean;
  requireSingleScreen: boolean;
  blockScreenshots: boolean;
  autoSubmitOnTimeout: boolean;
};

export const DEFAULT_PROCTORING: ProctorConfig = {
  requireWebcam: true, requireInternet: true, blockOnCameraLoss: true, cameraLossLockSeconds: 120,
  fullscreenRequired: true, blockCopyPaste: true, flagTabSwitch: true, maxTabSwitches: 0,
  webcamSnapshots: false, snapshotIntervalSec: 27, detectCameraBlock: true,
  requireSingleScreen: true, blockScreenshots: true, autoSubmitOnTimeout: true,
};

export type Bundle = {
  exam: { id: string; title: string; durationMin: number; totalPoints: number; startAt: string | null; endAt: string | null };
  questions: BundleQuestion[];
  proctoring?: ProctorConfig;
  /**
   * Names the option-ordering scheme this paper was rendered with. Options are
   * shuffled per student, so the indices in this bundle are DISPLAY indices — the
   * server only knows how to map them back if it is told which scheme produced
   * them. Echoed on every call that carries an answer index in either direction
   * (start / status / syncAnswers / submit).
   *
   * Optional on purpose: bundles are cached in localStorage and served offline
   * first, so a running client can hold a paper from an older build that has no
   * token. Sending undefined tells the server "these are original indices, do not
   * translate", which is exactly right for that client.
   */
  optionOrder?: string;
};

export type StartInfo = { attemptId: string; startedAt: string; endAt: string; serverNow: string; durationMin: number; pausedMs?: number; held?: boolean; answers?: Record<string, unknown> };
export type ResumeInfo = { attemptId: string; endAt: string; serverNow: string; pausedMs: number };
export type HeartbeatInfo = { held: boolean; endAt: string; serverNow: string };
export type StatusInfo = { status: "not_started" | "in_progress" | "submitted" | "graded"; attemptId: string | null; startedAt: string | null; endAt: string | null; serverNow: string; held: boolean; score?: number | null; answers?: Record<string, unknown> };

export type ReviewQuestion = {
  id: string;
  type: string;
  prompt: string;
  options: string[] | null;
  correct: unknown;
  points: number;
  response: unknown;
  score: number | null;
  maxScore: number;
  aiNotes: string | null;
  explanation?: string | null;
};
export type Review = {
  attempt: { id: string; status: string; score: number | null; integrityScore: number | null; submittedAt: string | null };
  exam: { id: string; title: string; totalPoints: number } | null;
  questions: ReviewQuestion[];
};

function tokenHeader(): Record<string, string> {
  const t = localStorage.getItem("examly:token");
  return t ? { "X-Student-Token": t } : {};
}

/**
 * Per-call reliability policy. Opt-in, because retrying is only safe for calls
 * that are idempotent server-side.
 *
 * `retries` = extra attempts AFTER the first, `timeoutMs` = per-attempt abort.
 * Without a timeout a request that never answers hangs forever: `fetch` has no
 * default deadline, so a student watching a dead socket got no error and no
 * retry — the submit button just stayed stuck.
 */
type ReqOpts = { retries?: number; timeoutMs?: number };

/** An HTTP status that a retry could plausibly fix. 4xx means "don't bother". */
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Carries the HTTP status through to the caller so submit can tell "the server
 * refused this" from "we never reached the server".
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit, opts?: ReqOpts): Promise<T> {
  const retries = opts?.retries ?? 0;
  const timeoutMs = opts?.timeoutMs ?? 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Fresh controller per attempt — an aborted one stays aborted.
    const ctl = timeoutMs > 0 ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${API_URL}/api${path}`, {
        ...init,
        signal: ctl?.signal ?? init?.signal,
        headers: { "Content-Type": "application/json", ...tokenHeader(), ...(init?.headers || {}) },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new ApiError(
          (body as { message?: string }).message || `Request failed (${res.status})`,
          res.status,
        );
        // A 4xx is the server's considered answer (already submitted, bad token,
        // exam closed). Repeating it just wastes the student's time.
        if (!isRetriableStatus(res.status) || attempt === retries) throw err;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (e) {
      // Network failure, DNS, dropped connection or our own timeout abort.
      if (e instanceof ApiError && !isRetriableStatus(e.status)) throw e;
      lastErr = e;
      if (attempt === retries) throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Exponential backoff (400ms, 800ms, 1600ms...) capped at 4s, with jitter so
    // 300 students whose submits failed together don't retry in lockstep and
    // rebuild the same spike that broke them.
    const backoff = Math.min(400 * 2 ** attempt, 4000);
    await sleep(backoff * (0.5 + Math.random() * 0.5));
  }
  throw lastErr instanceof Error ? lastErr : new Error("Request failed");
}

export const api = {
  apiUrl: API_URL,
  login: (identifier: string, password: string) =>
    req<{ ok: boolean; token: string; student: StudentProfile }>("/students/verify-login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean }>("/student/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  resume: (examId: string, offlineMs: number) =>
    req<ResumeInfo>(`/student/attempts/${examId}/resume`, { method: "POST", body: JSON.stringify({ offlineMs }) }),
  pause: (examId: string) =>
    req<{ ok: boolean }>(`/student/attempts/${examId}/pause`, { method: "POST", body: JSON.stringify({}) }),
  heartbeat: (examId: string) =>
    // Pure keepalive, no side effect worth protecting: retry freely so one blip
    // does not surface as a scary "connection lost" to a student mid-exam.
    req<HeartbeatInfo>(`/student/heartbeat/${examId}`, { method: "POST" }, { retries: 2, timeoutMs: 10000 }),
  exams: () => req<{ exams: ExamListItem[]; student: { id: string; name: string; rollNo: string; email: string | null } }>("/student/exams"),
  // Read-only, and the paper is what the student came for: retry hard. A failed
  // bundle fetch falls back to the localStorage cache, so this only has to win
  // on a student's FIRST sitting — where there is no cache to fall back to.
  bundle: (examId: string) => req<Bundle>(`/student/exams/${examId}/bundle`, undefined, { retries: 3, timeoutMs: 20000 }),
  // optionOrder (all four answer-carrying calls below): the scheme token from the
  // bundle currently on screen. Passed explicitly rather than read from storage so
  // it can never disagree with the paper the student is actually looking at.
  start: (examId: string, optionOrder?: string) =>
    // Idempotent by design: a second /start resumes the existing attempt instead
    // of creating a new one, so retrying cannot cost a student their timer.
    req<StartInfo>(`/student/attempts/${examId}/start`, { method: "POST", body: JSON.stringify({ optionOrder }) }, { retries: 3, timeoutMs: 15000 }),
  status: (examId: string, optionOrder?: string) =>
    // Read-only. Drives the post-submit confirmation screen, so a blip here is
    // what makes a successful submit LOOK like a failure.
    req<StatusInfo>(`/student/attempts/${examId}/status${optionOrder ? `?optionOrder=${encodeURIComponent(optionOrder)}` : ""}`, undefined, { retries: 3, timeoutMs: 15000 }),
  // Real-time per-answer autosave. keepalive lets the request survive a page
  // hide/unload so the last answer still reaches the server. Never throws — a
  // failed sync just leaves the answer in the client's dirty set to retry.
  syncAnswers: (attemptId: string, answers: { questionId: string; response: unknown }[], optionOrder?: string) =>
    fetch(`${API_URL}/api/student/attempts/${attemptId}/answers`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...tokenHeader() },
      body: JSON.stringify({ answers, optionOrder }),
    }).then((r) => (r.ok ? (r.json() as Promise<{ ok: boolean; answeredCount?: number; frozen?: boolean }>) : Promise.reject(new Error(`sync failed (${r.status})`)))),
  // Proctoring: flush violation events the moment they happen so the evidence
  // survives a crash / force-quit. keepalive lets a flush fired during page
  // unload still reach the server. Never throws — the caller retries.
  flushEvents: (attemptId: string, events: { type: string; detail?: string; at?: number; photoKey?: string | null }[]) =>
    fetch(`${API_URL}/api/student/attempts/${attemptId}/events`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...tokenHeader() },
      body: JSON.stringify({ events }),
    }).then((r) => (r.ok ? (r.json() as Promise<{ ok: boolean; saved: number }>) : Promise.reject(new Error(`events failed (${r.status})`)))),
  // Proctoring: presigned PUT for a violation snapshot (uploaded direct to storage).
  snapshotUrl: (attemptId: string) =>
    req<{ ok: boolean; url: string | null; key: string | null }>(`/student/attempts/${attemptId}/snapshot-url`, { method: "POST", body: JSON.stringify({}) }),
  submit: (attemptId: string, payload: { answers: { questionId: string; response: unknown }[]; integrityEvents: { type: string; detail?: string; at?: number; photoKey?: string | null }[]; optionOrder?: string }) =>
    req<{ ok: boolean; score: number; integrityScore: number }>(`/student/attempts/${attemptId}/submit`, {
      method: "POST",
      body: JSON.stringify(payload),
    },
    // The fix for "not able to submit". This used to be a single bare fetch: one
    // dropped packet and the student was stuck staring at a Submit button that
    // blamed their wifi. Safe to retry — the server treats a repeat submit as
    // idempotent and answers { ok: true, alreadySubmitted: true } rather than
    // re-grading. Generous deadline because submit is the heaviest call in the
    // exam and the one we must not give up on.
    { retries: 4, timeoutMs: 20000 }),
  review: (attemptId: string) => req<Review>(`/student/attempts/${attemptId}/review`),
  runCode: (source: string, language: string, stdin?: string, languageId?: number) =>
    req<{ ok: boolean; stdout: string; stderr: string; compileOutput: string; status: string; time: string | null; memory: number | null }>("/student/run-code", {
      method: "POST",
      body: JSON.stringify({ source, language, languageId, stdin: stdin ?? "" }),
    }),
};
