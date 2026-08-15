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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...tokenHeader(), ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
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
    req<HeartbeatInfo>(`/student/heartbeat/${examId}`, { method: "POST" }),
  exams: () => req<{ exams: ExamListItem[]; student: { id: string; name: string; rollNo: string; email: string | null } }>("/student/exams"),
  bundle: (examId: string) => req<Bundle>(`/student/exams/${examId}/bundle`),
  // optionOrder (all four answer-carrying calls below): the scheme token from the
  // bundle currently on screen. Passed explicitly rather than read from storage so
  // it can never disagree with the paper the student is actually looking at.
  start: (examId: string, optionOrder?: string) =>
    req<StartInfo>(`/student/attempts/${examId}/start`, { method: "POST", body: JSON.stringify({ optionOrder }) }),
  status: (examId: string, optionOrder?: string) =>
    req<StatusInfo>(`/student/attempts/${examId}/status${optionOrder ? `?optionOrder=${encodeURIComponent(optionOrder)}` : ""}`),
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
    }),
  review: (attemptId: string) => req<Review>(`/student/attempts/${attemptId}/review`),
  runCode: (source: string, language: string, stdin?: string, languageId?: number) =>
    req<{ ok: boolean; stdout: string; stderr: string; compileOutput: string; status: string; time: string | null; memory: number | null }>("/student/run-code", {
      method: "POST",
      body: JSON.stringify({ source, language, languageId, stdin: stdin ?? "" }),
    }),
};
