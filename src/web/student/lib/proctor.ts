// Lockdown proctoring for the running exam. Works in both plain-browser dev and
// inside Electron (where the main process also enforces kiosk fullscreen + traps
// shortcuts and forwards proctor events over IPC via window.examly).

import type { ProctorConfig } from "./api";
import { DEFAULT_PROCTORING } from "./api";

export type ProctorEvent = { type: string; detail?: string; at: number };

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
  if (cfg.blockCopyPaste) {
    for (const evt of ["copy", "paste", "cut"] as const) {
      const h = (e: Event) => {
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
  const anyWin = window as unknown as { getScreenDetails?: () => Promise<{ screens: unknown[] }> };
  if (anyWin.getScreenDetails) {
    try {
      const d = await anyWin.getScreenDetails();
      if (d?.screens?.length) return d.screens.length;
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
