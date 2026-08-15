/**
 * Why a camera request failed, and what the student should actually do about it.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Every camera failure used to collapse into one string: "Could not access the
 * camera. Allow camera access and make sure no other app is using it." That text
 * is wrong in the case we actually hit. Students sit these exams inside Safe Exam
 * Browser, and the ones who block the camera do it deliberately — they answer the
 * permission prompt with Block, close a privacy shutter, or unplug the webcam.
 *
 * Once Chromium has recorded a Block for an origin, `getUserMedia` rejects with
 * `NotAllowedError` IMMEDIATELY and never prompts again. So the old "Re-enable
 * camera now" button could not possibly work: it called `getUserMedia`, got an
 * instant rejection, and printed "Camera is still unavailable" forever. The
 * student was told to allow access with no way to allow it, and no instruction
 * that a reviewer or invigilator could act on.
 *
 * Worse, the usual browser advice — "click the camera icon in the address bar" —
 * is unusable here: SEB's kiosk Chromium has NO address bar, no padlock and no
 * site-settings menu. Telling a candidate to click something that does not exist
 * on their screen is how you get a hall full of raised hands.
 *
 * So failures are classified into causes the student can actually act on, each
 * with steps that are true inside a locked-down kiosk. Deliberately DOM-free so
 * it can be unit tested without a browser — `proctor.ts` owns the DOM, this owns
 * the meaning.
 */

export type CameraFailureCode =
  /** Permission refused: prompt answered "Block", or policy/OS privacy denies it. */
  | "permission_denied"
  /** No camera present: unplugged, disabled in Device Manager, or never existed. */
  | "no_device"
  /** Device exists but is held/failing: another app owns it, or the driver errored. */
  | "in_use"
  /** getUserMedia is unavailable (non-secure origin, or an ancient webview). */
  | "unsupported"
  /** Anything unrecognised — still surfaced, never swallowed. */
  | "unknown";

export type CameraFailure = {
  code: CameraFailureCode;
  /** Overlay heading. Short, non-accusatory — an unplugged webcam is not cheating. */
  title: string;
  /** One-line explanation of what the machine reported. */
  message: string;
  /** Ordered, kiosk-true remedies. Never mentions UI that SEB hides. */
  steps: string[];
  /** True when only an invigilator/relaunch can realistically clear it, so the
   *  UI can lead with "raise your hand" instead of a button that cannot work. */
  needsInvigilator: boolean;
  /** Short phrase stored on the integrity event for the admin timeline. */
  eventDetail: string;
};

/**
 * The exam runs inside SEB, so remedies are limited to things reachable WITHOUT
 * leaving the kiosk: hardware shutters, function keys, cables, and the
 * invigilator. Anything requiring browser chrome or another window is a lie.
 */
const RELAUNCH_STEP =
  "Raise your hand for the invigilator. Camera permission can only be restored by closing and reopening the secure browser and choosing Allow.";
const HARDWARE_STEPS = [
  "If your laptop has a camera shutter or privacy slider, open it.",
  "If your laptop has a camera key (often F8 or F10, sometimes with Fn), press it to switch the camera back on.",
  "If you use a plug-in webcam, reconnect it to the same USB port.",
];

/**
 * Map a `getUserMedia` rejection to a cause and a remedy.
 *
 * Matches on `name` first because that is the part of `DOMException` the spec
 * pins down; browsers word `message` however they like and localise it. Falls
 * back to a message sniff so an unusual build still lands somewhere sensible
 * rather than in "unknown".
 */
export function classifyCameraError(err: unknown): CameraFailure {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  const rawMessage =
    typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
  const hay = `${name} ${rawMessage}`.toLowerCase();

  // Permission. NotAllowedError is the prompt being answered "Block" (or a policy
  // block); SecurityError is the same outcome from a stricter configuration.
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError" ||
      (!name && /permission|denied|disallowed|not allowed/.test(hay))) {
    return {
      code: "permission_denied",
      title: "Camera access is blocked",
      message:
        "Your camera is switched off or access was blocked, so we cannot see you. The exam stays paused until the camera is back.",
      steps: [...HARDWARE_STEPS, RELAUNCH_STEP],
      needsInvigilator: true,
      eventDetail: "Camera access blocked by the candidate (permission denied)",
    };
  }

  // No device. OverconstrainedError lands here too: the camera that satisfied our
  // constraints has gone, which from the candidate's seat is "no camera".
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError" ||
      (!name && /not found|no (camera|device)|overconstrained/.test(hay))) {
    return {
      code: "no_device",
      title: "No camera detected",
      message: "This computer is not reporting a camera. The exam stays paused until one is connected.",
      steps: [...HARDWARE_STEPS, "Raise your hand for the invigilator if the camera still does not appear."],
      needsInvigilator: true,
      eventDetail: "No camera device present",
    };
  }

  // Device present but unusable: NotReadableError is the OS refusing to hand over
  // a camera another process holds; AbortError is a driver/hardware fault.
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError" ||
      (!name && /in use|could not start|busy|hardware|readable/.test(hay))) {
    return {
      code: "in_use",
      title: "Camera is busy",
      message: "Another program is using the camera, so this exam cannot see you.",
      steps: [
        "Close any video-call app (Zoom, Teams, Meet) that may have started with the computer.",
        ...HARDWARE_STEPS.slice(2),
        "Raise your hand for the invigilator if it stays busy.",
      ],
      needsInvigilator: true,
      eventDetail: "Camera held by another application",
    };
  }

  if (name === "TypeError" || /getusermedia|mediadevices|secure context|https/.test(hay)) {
    return {
      code: "unsupported",
      title: "Camera cannot be started",
      message: "This browser cannot open the camera for the exam.",
      steps: ["Raise your hand for the invigilator — the secure browser needs to be restarted for this exam."],
      needsInvigilator: true,
      eventDetail: "Camera unsupported in this browser context",
    };
  }

  return {
    code: "unknown",
    title: "Camera unavailable",
    message: "The camera stopped working, so the exam is paused until it is back.",
    steps: [...HARDWARE_STEPS, "Raise your hand for the invigilator if the camera does not come back."],
    needsInvigilator: true,
    eventDetail: rawMessage ? `Camera error: ${rawMessage}`.slice(0, 200) : "Camera unavailable (unknown error)",
  };
}

/**
 * Decide which diagnosis wins when a second detector reports a failure for an
 * incident the first one has already explained.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two independent detectors notice a dead camera, and one incident routinely
 * trips both. Revoking camera access in Chromium does not just make
 * `getUserMedia` reject — it ENDS the live track too. So the permission watcher
 * correctly reports "access is blocked", and up to 1.5s later the track poll
 * reports the vague "camera stopped sending video" for the very same act.
 *
 * Letting the later, vaguer report win was a real regression, caught driving a
 * browser: the overlay flipped back to hardware advice ("open your privacy
 * shutter") for a student who had blocked permission, and re-showed a countdown
 * that could never fix it. Once we KNOW access was denied, only a real
 * diagnosis may replace it — never the absence of one.
 *
 * Deliberately narrow: a genuine `no_device` or `in_use` after a denial is a new
 * fact worth showing, so only the non-diagnosis ("unknown") is talked over.
 */
export function escalateFailure(previouslyDenied: boolean, incoming: CameraFailure): CameraFailure {
  if (!previouslyDenied) return incoming;
  if (incoming.code !== "unknown") return incoming;
  return classifyCameraError({ name: "NotAllowedError" });
}

/**
 * The failure to show when the camera dies mid-exam but nothing threw — the track
 * ended or went muted, which is what an OS privacy toggle, a closed shutter and a
 * yanked USB cable all look like from JavaScript.
 *
 * There is no error object to classify, and guessing "permission" would accuse a
 * candidate whose cable fell out. Stay neutral and list every remedy.
 */
export function cameraLostFailure(reason: string): CameraFailure {
  return {
    code: "unknown",
    title: "Camera turned off",
    message: "Your camera stopped sending video, so the exam is paused until it is back.",
    steps: [...HARDWARE_STEPS, "Raise your hand for the invigilator if the camera does not come back."],
    needsInvigilator: true,
    // Bounded like every other eventDetail: this string is written to the
    // integrity timeline, and a caller could hand us a whole stack trace.
    eventDetail: (reason || "Camera stopped sending video").slice(0, 200),
  };
}
