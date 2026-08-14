// Lockdown proctoring for the running exam. Works in both plain-browser dev and
// inside Electron (where the main process also enforces kiosk fullscreen + traps
// shortcuts and forwards proctor events over IPC via window.examly).

import type { ProctorConfig } from "./api";
import { DEFAULT_PROCTORING } from "./api";

export type ProctorEvent = {
  type: string;
  detail?: string;
  at: number;
  /** Object-storage key of the webcam snapshot captured at this moment (if any). */
  photoKey?: string | null;
};

type Handler = (ev: ProctorEvent) => void;

declare global {
  interface Window {
    examly?: {
      onProctorEvent?: (cb: (payload: { type: string; detail?: string }) => void) => () => void;
      enterKiosk?: () => void;
      exitKiosk?: () => void;
      getDisplayCount?: () => Promise<number>;
    };
  }
}

export function startProctoring(onEvent: Handler, config?: Partial<ProctorConfig>): () => void {
  const cfg = { ...DEFAULT_PROCTORING, ...(config ?? {}) };
  const emit = (type: string, detail?: string) => onEvent({ type, detail, at: Date.now() });
  const cleanups: Array<() => void> = [];

  // Block copy / paste / cut.
  // IMPORTANT: clipboard actions INSIDE the student's own answer field (the code
  // editor, a short-answer textarea) are allowed — a candidate legitimately moves
  // code around while solving, and hard-blocking that mid-exam breaks the coding
  // questions. Those are still RECORDED as evidence (`*_in_answer`) so an admin can
  // review them; clipboard use anywhere else (e.g. copying the question paper out)
  // is blocked outright.
  const inAnswerField = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest("textarea, input, [contenteditable='true']");
  };
  if (cfg.blockCopyPaste) {
    for (const evt of ["copy", "paste", "cut"] as const) {
      const h = (e: Event) => {
        if (inAnswerField(e.target)) {
          emit(`${evt}_in_answer`, `${evt} inside the answer field`);
          return;
        }
        e.preventDefault();
        emit(evt, `Blocked ${evt}`);
      };
      document.addEventListener(evt, h, true);
      cleanups.push(() => document.removeEventListener(evt, h, true));
    }

    // Block right-click context menu.
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      emit("context_menu", "Right-click blocked");
    };
    document.addEventListener("contextmenu", ctx, true);
    cleanups.push(() => document.removeEventListener("contextmenu", ctx, true));
  }

  // Block devtools / view-source / print shortcuts (always on).
  const keydown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const blocked =
      e.key === "F12" ||
      (e.ctrlKey && e.shiftKey && (k === "i" || k === "j" || k === "c")) ||
      (e.ctrlKey && (k === "u" || k === "p" || k === "s"));
    if (blocked) {
      e.preventDefault();
      emit("shortcut", `Blocked ${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`);
    }
  };
  window.addEventListener("keydown", keydown, true);
  cleanups.push(() => window.removeEventListener("keydown", keydown, true));

  // Block screenshot shortcuts (PrintScreen, Win+Shift+S snipping).
  if (cfg.blockScreenshots) {
    const shot = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === "PrintScreen" || k === "printscreen" || (e.shiftKey && e.metaKey && k === "s")) {
        e.preventDefault();
        // Clear the clipboard so any captured image can't be pasted elsewhere.
        try { void navigator.clipboard?.writeText(""); } catch { /* ignore */ }
        emit("screenshot", "Screenshot shortcut blocked");
      }
    };
    window.addEventListener("keydown", shot, true);
    window.addEventListener("keyup", shot, true);
    cleanups.push(() => { window.removeEventListener("keydown", shot, true); window.removeEventListener("keyup", shot, true); });
  }

  // Tab / window focus loss + tab switching.
  if (cfg.flagTabSwitch) {
    const blur = () => emit("focus_loss", "Window lost focus");
    window.addEventListener("blur", blur);
    cleanups.push(() => window.removeEventListener("blur", blur));

    const vis = () => {
      if (document.hidden) emit("tab_switch", "Tab hidden / switched away");
    };
    document.addEventListener("visibilitychange", vis);
    cleanups.push(() => document.removeEventListener("visibilitychange", vis));
  }

  // Fullscreen exit.
  if (cfg.fullscreenRequired) {
    const fs = () => {
      if (!document.fullscreenElement) emit("fullscreen_exit", "Exited fullscreen");
    };
    document.addEventListener("fullscreenchange", fs);
    cleanups.push(() => document.removeEventListener("fullscreenchange", fs));
  }

  // Electron main-process proctor events (kiosk-level).
  if (window.examly?.onProctorEvent) {
    const off = window.examly.onProctorEvent((p) => emit(p.type, p.detail));
    cleanups.push(off);
  }

  return () => cleanups.forEach((c) => c());
}

// ------------------------ Webcam monitoring ------------------------
// Requests the camera, keeps a live stream, and reports when the camera
// stops (device unplugged, permission revoked, track ended). Used to gate
// exam start and to lock the exam if the camera is closed mid-exam.

export type FrameMetrics = {
  /** Mean luminance across the frame, 0 (black) .. 1 (white). */
  mean: number;
  /** Spatial standard deviation of luminance. A real scene has structure and
   *  sits well above ~0.05; a lens under tape/paper is a near-uniform field. */
  stddev: number;
  /** Coarse 8x8 luminance grid, used to detect a frozen / looping feed. */
  grid: number[];
};

/** Measure luminance statistics from an already-drawn canvas.
 *
 *  This is the core of obstruction detection. A covered camera still reports a
 *  perfectly healthy MediaStreamTrack — `live`, unmuted, producing frames — so
 *  no track-level signal can catch tape over the lens. The pixels can: an
 *  obstructed frame loses spatial variance, because whatever is pressed against
 *  the lens fills the whole field with one flat tone.
 *
 *  Samples every 2nd pixel on both axes (1 in 4 pixels, ~19k of 76k at 320x240)
 *  — statistically identical for this purpose and cheap enough to run on a
 *  low-end exam machine. */
export function analyzeFrame(ctx: CanvasRenderingContext2D, w: number, h: number): FrameMetrics | null {
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // tainted canvas — never break capture over metrics
  }
  const GRID = 8;
  const sums = new Array(GRID * GRID).fill(0);
  const counts = new Array(GRID * GRID).fill(0);
  let total = 0;
  let totalSq = 0;
  let n = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      total += lum;
      totalSq += lum * lum;
      n++;
      const gx = Math.min(GRID - 1, Math.floor((x / w) * GRID));
      const gy = Math.min(GRID - 1, Math.floor((y / h) * GRID));
      const gi = gy * GRID + gx;
      sums[gi] += lum;
      counts[gi]++;
    }
  }
  if (n === 0) return null;
  const mean = total / n;
  const variance = Math.max(0, totalSq / n - mean * mean);
  return {
    mean,
    stddev: Math.sqrt(variance),
    grid: sums.map((s, i) => (counts[i] ? s / counts[i] : 0)),
  };
}

export type ObstructionVerdict =
  | { state: "ok" }
  | { state: "covered"; reason: string }
  | { state: "frozen"; reason: string };

/** Thresholds are deliberately conservative — a false "you covered your camera"
 *  accusation against an honest candidate mid-exam is far more damaging than a
 *  missed one, and a reviewer still has the full frame trail either way.
 *
 *  Reference: real verified exam frames measured mean 0.49-0.51 with healthy
 *  spatial variance. Tape/paper over a lens collapses stddev toward 0. */
const FLAT_STDDEV = 0.025;   // uniform field: tape, paper, a hand, a closed shutter
const DARK_MEAN = 0.06;      // essentially black frame
const DARK_STDDEV = 0.04;    // ...with no structure in it

/** Frozen-feed detection deliberately only catches a BIT-IDENTICAL picture.
 *
 *  Averaging ~1200 pixels into each of the 64 grid cells cancels sensor noise, so
 *  the grid moves only when the SCENE moves. Measured: real exam frames moved
 *  0.024-0.027 per cell, a synthetic scene with zero motion still moved ~0.0006,
 *  and a re-fed identical image moved exactly 0. Any live sensor produces noise,
 *  so 1e-4 separates "a still image is being injected" from "this candidate is
 *  sitting very still" — which a looser threshold would confuse, and accusing a
 *  motionless honest candidate of feeding a fake camera is the worse error.
 *
 *  Consequence, accepted: a cheater looping a VIDEO is not caught here. That is
 *  what the reviewable frame trail is for. */
const FROZEN_DELTA = 0.0001;
const FROZEN_RUNS = 5;

/** Stateful obstruction detector. One instance per attempt.
 *
 *  Requires several consecutive bad frames before declaring anything, so a
 *  student briefly leaning into frame, a light flicker, or one dropped frame
 *  can't raise a flag. */
export function createObstructionDetector(consecutive = 3, opts?: { detectFrozen?: boolean }) {
  // Frozen detection is opt-out because the pre-exam camera check samples every
  // 6s: a student reading the instructions without moving would trip it there.
  const detectFrozen = opts?.detectFrozen ?? true;
  let badRun = 0;
  let frozenRun = 0;
  let lastGrid: number[] | null = null;
  let lastFlagged = false;

  return {
    /** Feed one frame's metrics; returns a verdict plus whether it just changed. */
    push(m: FrameMetrics | null): { verdict: ObstructionVerdict; changed: boolean } {
      if (!m) return { verdict: { state: "ok" }, changed: false };

      const flat = m.stddev < FLAT_STDDEV;
      const dark = m.mean < DARK_MEAN && m.stddev < DARK_STDDEV;

      let delta = Infinity;
      if (lastGrid) {
        let d = 0;
        for (let i = 0; i < m.grid.length; i++) d += Math.abs(m.grid[i] - lastGrid[i]);
        delta = d / m.grid.length;
      }
      lastGrid = m.grid;

      if (flat || dark) badRun++; else badRun = 0;
      // A frozen feed only counts while the image is otherwise plausible —
      // a flat frame is already covered by badRun above.
      if (detectFrozen && delta < FROZEN_DELTA && !flat && !dark) frozenRun++; else frozenRun = 0;

      let verdict: ObstructionVerdict = { state: "ok" };
      if (badRun >= consecutive) {
        verdict = {
          state: "covered",
          reason: dark
            ? `Camera view is black (brightness ${m.mean.toFixed(3)}) — lens may be covered or the room is unlit`
            : `Camera view is a flat, featureless image (variation ${m.stddev.toFixed(3)}) — lens may be taped or blocked`,
        };
      } else if (frozenRun >= FROZEN_RUNS) {
        verdict = { state: "frozen", reason: `Camera image has not changed across ${frozenRun} captures — feed may be a still image or a virtual camera` };
      }

      const isFlagged = verdict.state !== "ok";
      const changed = isFlagged !== lastFlagged;
      lastFlagged = isFlagged;
      return { verdict, changed };
    },
    reset() { badRun = 0; frozenRun = 0; lastGrid = null; lastFlagged = false; },
  };
}

export type WebcamHandle = {
  stream: MediaStream;
  stop: () => void;
};

export async function startWebcam(onLost: (reason: string) => void): Promise<WebcamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
  const track = stream.getVideoTracks()[0];
  let stopped = false;

  const handleEnded = () => {
    if (stopped) return;
    onLost("Camera stream ended");
  };
  track.addEventListener("ended", handleEnded);

  // Poll for muted / disabled state (some OS-level camera-off toggles mute the track).
  const poll = setInterval(() => {
    if (stopped) return;
    if (!track.readyState || track.readyState === "ended") {
      onLost("Camera disconnected");
    } else if (track.muted) {
      onLost("Camera turned off");
    }
  }, 1500);

  return {
    stream,
    stop: () => {
      stopped = true;
      clearInterval(poll);
      track.removeEventListener("ended", handleEnded);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export type CapturedFrame = {
  blob: Blob | null;
  /** Luminance stats for the same pixels that were encoded, or null when the
   *  canvas could not be read. Never a reason to drop the blob. */
  metrics: FrameMetrics | null;
};

// Grab a single JPEG frame from the live webcam stream. Used to attach visual
// evidence to a violation (camera loss, tab switch, extra monitor…) and for the
// periodic snapshot trail. Draws the stream into an offscreen canvas so it works
// even when the preview <video> is hidden behind a lock overlay, and measures
// that same canvas for obstruction detection so nothing is decoded twice.
// Returns nulls if the stream can't produce a frame — a missing snapshot must
// never break the exam.
export async function captureFrame(handle: WebcamHandle | null, timeoutMs = 2500): Promise<CapturedFrame> {
  const empty: CapturedFrame = { blob: null, metrics: null };
  if (!handle) return empty;
  const track = handle.stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return empty;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = handle.stream;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      const done = () => { clearTimeout(t); resolve(); };
      if (video.readyState >= 2) { done(); return; }
      video.onloadeddata = done;
      video.onerror = () => { clearTimeout(t); reject(new Error("video error")); };
      void video.play().catch(() => { /* autoplay of a muted stream is allowed */ });
    });
    const w = video.videoWidth || 320;
    const h = video.videoHeight || 240;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return empty;
    ctx.drawImage(video, 0, 0, w, h);
    let metrics: FrameMetrics | null = null;
    try { metrics = analyzeFrame(ctx, w, h); } catch { /* metrics are best-effort */ }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7));
    return { blob, metrics };
  } catch {
    return empty;
  } finally {
    try { video.pause(); } catch { /* ignore */ }
    video.srcObject = null;
  }
}

/** Back-compat wrapper for callers that only want the image. */
export async function captureSnapshot(handle: WebcamHandle | null, timeoutMs = 2500): Promise<Blob | null> {
  return (await captureFrame(handle, timeoutMs)).blob;
}

export function isCameraActive(handle: WebcamHandle | null): boolean {
  if (!handle) return false;
  const track = handle.stream.getVideoTracks()[0];
  return !!track && track.readyState === "live" && !track.muted;
}

// Returns how many monitors are attached. In Electron this is exact (via the
// main process); in a plain browser we approximate using the Screen API (1 unless
// the experimental window.getScreenDetails is available and permitted).
export async function getDisplayCount(): Promise<number> {
  if (window.examly?.getDisplayCount) {
    try { return await window.examly.getDisplayCount(); } catch { /* ignore */ }
  }
  // Browser fallback: multi-screen details API (Chromium, needs permission).
  // IMPORTANT: inside SEB's kiosk Chromium, getScreenDetails() can hang forever
  // waiting on a window-management permission prompt that never appears. That
  // would freeze the "Start secure exam" flow (the await never settles). Race it
  // against a short timeout so the check can never block starting the exam —
  // SEB already enforces single-display at the OS level, so 1 is a safe fallback.
  const anyWin = window as unknown as { getScreenDetails?: () => Promise<{ screens: unknown[] }> };
  if (anyWin.getScreenDetails) {
    try {
      const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(1), 1200));
      const query = anyWin.getScreenDetails().then((d) => (d?.screens?.length ? d.screens.length : 1));
      return await Promise.race([query, timeout]);
    } catch { /* permission denied — assume single */ }
  }
  return 1;
}

export async function requestFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  } catch {
    /* not permitted in dev browser — ignore */
  }
  window.examly?.enterKiosk?.();
}

export async function exitFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignore */
  }
  window.examly?.exitKiosk?.();
}
