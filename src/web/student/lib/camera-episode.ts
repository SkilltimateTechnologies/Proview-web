/** One camera failure = one violation, however many times it is detected.
 *
 *  A dead camera is detected over and over: the track poll notices it, the
 *  permission watcher notices it, and the unlock poll re-acquires the device
 *  every 2.5s — each new handle carrying its own fresh "report once" latch. A
 *  webcam that can be opened but dies immediately therefore produced a fresh
 *  `camera_lost` row every few seconds. Measured on a real exam: one student's
 *  failing webcam wrote 43 rows, putting her at the top of the misconduct table
 *  above the only student in the hall with an actual copy/paste pattern.
 *
 *  This module owns the question "is this a new incident, or the same one still
 *  going?" so the answer is decided in one place and can be tested without a
 *  browser, a camera, or a DOM.
 */

/** How long the camera must stay CONTINUOUSLY live before the incident is over.
 *
 *  Not zero, and not "isCameraActive() === true" on a single observation: the
 *  recovery poll re-opens the device every 2.5s, so a flapping camera reads as
 *  live for an instant on almost every tick. Clearing on that would restart the
 *  storm this module exists to stop. Ten seconds is longer than the recovery
 *  poll and longer than a flap, and short enough that a student who genuinely
 *  reconnects is treated as recovered well before they could lose the camera
 *  again in a way anyone would call a separate incident. */
export const EPISODE_CLEAR_MS = 10_000;

export type LossType = "camera_lost" | "camera_blocked";

export type CameraEpisode = {
  /** Inside an unresolved camera failure. */
  lost: boolean;
  /** What was already written for this episode, so an escalation can be spotted. */
  recorded: LossType | null;
  /** When the camera was first seen live in an unbroken run, or null if it is down. */
  liveSince: number | null;
};

export const freshEpisode = (): CameraEpisode => ({ lost: false, recorded: null, liveSince: null });

/** A loss was detected. Says whether it deserves a row of its own.
 *
 *  Records when:
 *    - this is the first detection of a new episode, or
 *    - it escalates `camera_lost` to `camera_blocked`. Revoking camera permission
 *      also ends the track, so the vague "camera turned off" can land a beat
 *      before the permission watcher names the real cause. The real cause is a
 *      different offence — it can only happen on purpose — so it must reach the
 *      timeline even mid-episode. Once only: `camera_blocked` never re-escalates.
 */
export function onLoss(
  ep: CameraEpisode,
  type: LossType,
  _now?: number,
): { record: boolean; episode: CameraEpisode } {
  const escalation = ep.lost && ep.recorded === "camera_lost" && type === "camera_blocked";
  const record = !ep.lost || escalation;
  return {
    record,
    // liveSince resets unconditionally: the camera is demonstrably down again, so
    // any run of "seen live" in progress is void even when nothing is written.
    episode: { lost: true, recorded: record ? type : ep.recorded, liveSince: null },
  };
}

/** A camera-health observation. Ends the episode only after an unbroken live run
 *  of EPISODE_CLEAR_MS — see the constant for why a single true is not enough. */
export function onCameraSeen(ep: CameraEpisode, live: boolean, now: number): CameraEpisode {
  if (!live) return ep.liveSince === null ? ep : { ...ep, liveSince: null };
  if (!ep.lost) return ep;
  if (ep.liveSince === null) return { ...ep, liveSince: now };
  if (now - ep.liveSince >= EPISODE_CLEAR_MS) return freshEpisode();
  return ep;
}

/* There is deliberately NO onRestored(). The exam resuming is not evidence that
 * the camera works: the unlock poll releases the overlay on a SINGLE instantaneous
 * isCameraActive() reading, and a flapping camera hands it one every time the
 * device is re-opened. An earlier version of this module cleared the episode there
 * and the browser check caught it billing a row per lock period — loss, lock,
 * "restored", dead 700ms later, loss. That is exactly the 60.0s cadence measured on
 * the exam that exposed this bug, so the unlock is the storm's clock, not its cure.
 * The continuous live run above is the only thing that ends an episode. */
