import { describe, expect, test } from "bun:test";
import {
  EPISODE_CLEAR_MS,
  freshEpisode,
  onCameraSeen,
  onLoss,
  type CameraEpisode,
} from "./camera-episode";

const T0 = 1_700_000_000_000;

describe("onLoss", () => {
  test("records the first loss of an episode", () => {
    const { record, episode } = onLoss(freshEpisode(), "camera_lost");
    expect(record).toBe(true);
    expect(episode.lost).toBe(true);
    expect(episode.recorded).toBe("camera_lost");
  });

  test("suppresses repeat detections of the SAME episode", () => {
    let ep = freshEpisode();
    let recorded = 0;
    // The unlock poll re-acquires every 2.5s; a flaky camera dies on each handle.
    for (let i = 0; i < 40; i++) {
      const r = onLoss(ep, "camera_lost", T0 + i * 2500);
      ep = r.episode;
      if (r.record) recorded++;
    }
    expect(recorded).toBe(1);
  });

  test("escalates camera_lost to camera_blocked exactly once", () => {
    const first = onLoss(freshEpisode(), "camera_lost");
    const esc = onLoss(first.episode, "camera_blocked");
    expect(esc.record).toBe(true);
    expect(esc.episode.recorded).toBe("camera_blocked");

    // Every later detection of the same denial is the same offence.
    const again = onLoss(esc.episode, "camera_blocked");
    expect(again.record).toBe(false);
  });

  test("does NOT de-escalate: a vague loss after a known denial writes nothing", () => {
    const denied = onLoss(freshEpisode(), "camera_blocked");
    const vague = onLoss(denied.episode, "camera_lost");
    expect(vague.record).toBe(false);
    // and the named cause survives
    expect(vague.episode.recorded).toBe("camera_blocked");
  });

  test("a suppressed loss still voids an in-progress live run", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    ep = onCameraSeen(ep, true, T0); // recovery starts ticking
    expect(ep.liveSince).toBe(T0);
    ep = onLoss(ep, "camera_lost", T0 + 1_000).episode; // camera died again
    expect(ep.liveSince).toBeNull();
    // so the clock restarts rather than inheriting credit from before the drop
    ep = onCameraSeen(ep, true, T0 + 2_000);
    expect(ep.liveSince).toBe(T0 + 2_000);
  });
});

describe("onCameraSeen", () => {
  test("a single live observation does NOT end the episode", () => {
    const ep = onLoss(freshEpisode(), "camera_lost").episode;
    const next = onCameraSeen(ep, true, T0);
    expect(next.lost).toBe(true);
  });

  test("ends the episode after an unbroken live run", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    ep = onCameraSeen(ep, true, T0);
    ep = onCameraSeen(ep, true, T0 + EPISODE_CLEAR_MS);
    expect(ep.lost).toBe(false);
    expect(ep.recorded).toBeNull();
  });

  test("does not end it one tick early", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    ep = onCameraSeen(ep, true, T0);
    ep = onCameraSeen(ep, true, T0 + EPISODE_CLEAR_MS - 1);
    expect(ep.lost).toBe(true);
  });

  test("a flapping camera never clears, and never writes a second row", () => {
    // Live for 2.5s, dead, live for 2.5s, dead ... exactly what the 2.5s recovery
    // poll does to a failing USB webcam. This is the 43-row case.
    let ep = freshEpisode();
    let recorded = 0;
    let t = T0;
    for (let i = 0; i < 60; i++) {
      const r = onLoss(ep, "camera_lost", t);
      ep = r.episode;
      if (r.record) recorded++;
      t += 2500;
      ep = onCameraSeen(ep, true, t); // briefly re-acquired
      t += 2500;
    }
    expect(recorded).toBe(1);
    expect(ep.lost).toBe(true);
  });

  test("after a real recovery, a NEW failure is a new violation", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    ep = onCameraSeen(ep, true, T0);
    ep = onCameraSeen(ep, true, T0 + EPISODE_CLEAR_MS);
    expect(ep.lost).toBe(false);
    const second = onLoss(ep, "camera_lost", T0 + 60_000);
    expect(second.record).toBe(true);
  });

  test("observations while healthy are inert", () => {
    const ep = freshEpisode();
    expect(onCameraSeen(ep, true, T0)).toEqual(ep);
    expect(onCameraSeen(ep, false, T0)).toEqual(ep);
  });

  test("a dead observation clears the live run", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    ep = onCameraSeen(ep, true, T0);
    ep = onCameraSeen(ep, false, T0 + 1_000);
    expect(ep.liveSince).toBeNull();
    // the full run must be served again from the later mark
    ep = onCameraSeen(ep, true, T0 + 2_000);
    ep = onCameraSeen(ep, true, T0 + 2_000 + EPISODE_CLEAR_MS - 1);
    expect(ep.lost).toBe(true);
    ep = onCameraSeen(ep, true, T0 + 2_000 + EPISODE_CLEAR_MS);
    expect(ep.lost).toBe(false);
  });

  test("does not allocate a new object when nothing changed", () => {
    const down: CameraEpisode = onLoss(freshEpisode(), "camera_lost").episode;
    expect(onCameraSeen(down, false, T0)).toBe(down);
  });
});

describe("the exam resuming is NOT proof the camera is fixed", () => {
  // Found by scripts/verify-camera-episode.py against a real browser, not here:
  // this module used to export onRestored(), which the runner called when the
  // unlock poll lifted the overlay. But that poll releases on ONE instantaneous
  // isCameraActive() reading, so a camera that dies 700ms after every open still
  // "restored" the exam once per lock period and the next death opened a new
  // episode. One row per lock period is precisely the 60.0s cadence measured on
  // the exam that exposed this bug.
  test("a lock-length cycle of loss -> brief live -> loss bills once", () => {
    let ep = freshEpisode();
    let recorded = 0;
    let t = T0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const r = onLoss(ep, "camera_lost", t);
      ep = r.episode;
      if (r.record) recorded++;
      // 60s of lock with the camera down...
      for (let k = 0; k < 30; k++) {
        t += 2_000;
        ep = onCameraSeen(ep, false, t);
      }
      // ...then the device opens, reads live for one tick, and dies again.
      t += 2_000;
      ep = onCameraSeen(ep, true, t);
      t += 2_000;
    }
    expect(recorded).toBe(1);
  });

  test("a camera flapping faster than the clear window never clears the episode", () => {
    // Absolute times, not multiples of EPISODE_CLEAR_MS: this is the test that
    // pins the constant to reality. The health feeder samples every 2s and the
    // recovery poll re-opens the device every 2.5s, so a camera that survives a
    // few seconds per open hands out consecutive "live" readings. The window has
    // to outlast that or the storm restarts.
    let ep = freshEpisode();
    let recorded = 0;
    let t = T0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const r = onLoss(ep, "camera_lost", t);
      ep = r.episode;
      if (r.record) recorded++;
      ep = onCameraSeen(ep, true, t + 2_000);
      ep = onCameraSeen(ep, true, t + 4_000);   // ~4s of apparent life, then dead again
      t += 6_000;
    }
    expect(recorded).toBe(1);
  });

  test("the clear window comfortably outlasts the 2.5s recovery poll", () => {
    expect(EPISODE_CLEAR_MS).toBeGreaterThanOrEqual(5_000);
  });

  test("a camera that genuinely stays up ends the episode without any restore signal", () => {
    let ep = onLoss(freshEpisode(), "camera_lost").episode;
    for (let k = 1; k <= 6; k++) ep = onCameraSeen(ep, true, T0 + k * 2_000);
    expect(ep.lost).toBe(false);
    expect(onLoss(ep, "camera_lost", T0 + 20_000).record).toBe(true);
  });
});

describe("the shape of the incident this module was written for", () => {
  test("one failing webcam across a whole exam is one violation", () => {
    // Reproduces 23K91A66K3: ~37 minutes of a camera that keeps dying, with the
    // recovery poll re-opening it every 2.5s. Previously 43 rows.
    let ep = freshEpisode();
    let recorded = 0;
    for (let t = T0; t < T0 + 37 * 60_000; t += 2500) {
      const r = onLoss(ep, "camera_lost", t);
      ep = r.episode;
      if (r.record) recorded++;
      ep = onCameraSeen(ep, Math.random() < 0.4, t + 1200);
    }
    expect(recorded).toBe(1);
  });

  test("but a student who covers, uncovers and covers again is billed twice", () => {
    let ep = freshEpisode();
    let recorded = 0;
    const loss = (t: number) => {
      const r = onLoss(ep, "camera_lost", t);
      ep = r.episode;
      if (r.record) recorded++;
    };
    loss(T0);
    // genuinely back for well over the clear window
    ep = onCameraSeen(ep, true, T0 + 5_000);
    ep = onCameraSeen(ep, true, T0 + 5_000 + EPISODE_CLEAR_MS);
    loss(T0 + 120_000);
    expect(recorded).toBe(2);
  });
});
