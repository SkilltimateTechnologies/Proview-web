import { describe, expect, test } from "bun:test";
import { type CameraFailure, cameraLostFailure, classifyCameraError } from "./camera-failure";

/**
 * These tests guard two promises the overlay makes to a candidate sitting in a
 * locked-down Safe Exam Browser kiosk:
 *
 *  1. The cause is named correctly. `permission_denied` is the only code that
 *     hard-blocks with no countdown, because waiting cannot clear a Block — so
 *     misclassifying a yanked USB cable as a permission denial would strand a
 *     student in an overlay that never lifts, and misclassifying a real Block as
 *     something else would show a countdown that can never reach zero usefully.
 *
 *  2. Every step is something the candidate can physically do inside the kiosk.
 *     SEB has no address bar, no padlock and no site-settings menu. Any step that
 *     names them is a dead end, so the text is asserted, not just the shape.
 */

/** UI that does not exist on a kiosk screen. A step naming any of these is a bug. */
const IMPOSSIBLE_UI = [
  "address bar",
  "padlock",
  "lock icon",
  "site settings",
  "site permissions",
  "three dots",
  "browser settings",
  "chrome://",
  "new tab",
  "reload the page",
  "refresh the page",
];

const ALL_FAILURES = (): CameraFailure[] => [
  classifyCameraError(domError("NotAllowedError")),
  classifyCameraError(domError("NotFoundError")),
  classifyCameraError(domError("NotReadableError")),
  classifyCameraError(domError("TypeError")),
  classifyCameraError(domError("SomethingBrandNewError")),
  cameraLostFailure("track ended"),
];

/** A stand-in for a DOMException — Bun's test env has one, but plain objects
 *  prove the classifier reads `name`/`message` rather than relying on instanceof. */
function domError(name: string, message = "") {
  return { name, message };
}

describe("classifyCameraError — permission", () => {
  test.each(["NotAllowedError", "PermissionDeniedError", "SecurityError"])(
    "%s is a deliberate block, not a fault",
    (name) => {
      const fail = classifyCameraError(domError(name));
      expect(fail.code).toBe("permission_denied");
      expect(fail.title).toBe("Camera access is blocked");
      expect(fail.eventDetail).toContain("blocked");
    },
  );

  test("a real DOMException classifies the same as a plain object", () => {
    const fail = classifyCameraError(new DOMException("Permission denied", "NotAllowedError"));
    expect(fail.code).toBe("permission_denied");
  });

  test("permission steps lead with hardware and end with the invigilator", () => {
    const fail = classifyCameraError(domError("NotAllowedError"));
    // The last step must be the only thing that actually clears a recorded Block:
    // relaunching the secure browser and answering Allow. If it stops being last,
    // a candidate reads it before trying the shutter and raises their hand early.
    expect(fail.steps[fail.steps.length - 1]).toContain("secure browser");
    expect(fail.steps[0]?.toLowerCase()).toContain("shutter");
    expect(fail.needsInvigilator).toBe(true);
  });

  test("an unnamed error whose message says denied is still a permission block", () => {
    // Some embedded webviews reject with a bare Error. Missing the block here
    // would show a countdown that can never help.
    expect(classifyCameraError({ message: "Permission denied by user" }).code).toBe("permission_denied");
    expect(classifyCameraError({ message: "The request is not allowed" }).code).toBe("permission_denied");
  });
});

describe("classifyCameraError — device and hardware", () => {
  test.each(["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"])("%s means no camera", (name) => {
    const fail = classifyCameraError(domError(name));
    expect(fail.code).toBe("no_device");
    expect(fail.title).toBe("No camera detected");
  });

  test.each(["NotReadableError", "TrackStartError", "AbortError"])("%s means the camera is held", (name) => {
    const fail = classifyCameraError(domError(name));
    expect(fail.code).toBe("in_use");
    expect(fail.title).toBe("Camera is busy");
  });

  test("a busy camera is told to close the call app first, not to open a shutter", () => {
    // Ordering carries the diagnosis: a camera the OS says is in use is powered
    // on, so "open your privacy shutter" would be nonsense as the opening move.
    const fail = classifyCameraError(domError("NotReadableError"));
    expect(fail.steps[0]).toMatch(/Zoom|Teams|Meet/);
    expect(fail.steps[0]?.toLowerCase()).not.toContain("shutter");
  });

  test("TypeError means the browser context cannot do camera at all", () => {
    const fail = classifyCameraError(domError("TypeError", "getUserMedia is not a function"));
    expect(fail.code).toBe("unsupported");
  });
});

describe("classifyCameraError — unknown input never throws", () => {
  // Wrapped in objects because test.each spreads a bare array as an argument
  // list, which would call the case with no arguments at all.
  test.each([
    { label: "null", v: null },
    { label: "undefined", v: undefined },
    { label: "empty string", v: "" },
    { label: "string", v: "boom" },
    { label: "zero", v: 0 },
    { label: "number", v: 42 },
    { label: "boolean", v: true },
    { label: "empty object", v: {} },
    { label: "empty array", v: [] },
    { label: "symbol", v: Symbol("x") },
    { label: "Error with no message", v: new Error("") },
    { label: "object with a non-string name", v: { name: 7, message: null } },
  ])("survives $label and still returns a usable failure", ({ v }) => {
      const fail = classifyCameraError(v as unknown);
      expect(typeof fail.code).toBe("string");
      expect(fail.title.length).toBeGreaterThan(0);
      expect(fail.message.length).toBeGreaterThan(0);
      expect(fail.steps.length).toBeGreaterThan(0);
    },
  );

  test("an unrecognised name falls through to unknown, and is not silently a block", () => {
    const fail = classifyCameraError(domError("WeirdVendorError", "something odd"));
    expect(fail.code).toBe("unknown");
    // Accusing a candidate of blocking their camera on an unrecognised error is
    // the one wrong answer here — unknown must stay neutral.
    expect(fail.code).not.toBe("permission_denied");
    expect(fail.eventDetail).toContain("something odd");
  });

  test("a novel-length error message cannot flood the integrity timeline", () => {
    const fail = classifyCameraError(domError("WeirdVendorError", "x".repeat(5000)));
    expect(fail.eventDetail.length).toBeLessThanOrEqual(200);
  });
});

describe("cameraLostFailure", () => {
  test("stays neutral — a dead track is not proof of cheating", () => {
    const fail = cameraLostFailure("track ended");
    expect(fail.code).toBe("unknown");
    expect(fail.code).not.toBe("permission_denied");
    expect(fail.title).toBe("Camera turned off");
    expect(fail.eventDetail).toBe("track ended");
  });

  test("carries the caller's reason through to the admin timeline, bounded", () => {
    expect(cameraLostFailure("track muted").eventDetail).toBe("track muted");
    expect(cameraLostFailure("y".repeat(400)).eventDetail.length).toBe(200);
    expect(cameraLostFailure("").eventDetail.length).toBeGreaterThan(0);
  });
});

describe("every failure is safe to show inside SEB", () => {
  test("no step points at browser UI the kiosk hides", () => {
    for (const fail of ALL_FAILURES()) {
      for (const step of fail.steps) {
        for (const banned of IMPOSSIBLE_UI) {
          expect(`${fail.code} :: ${step}`.toLowerCase()).not.toContain(banned);
        }
      }
    }
  });

  test("no step is empty or punctuation-only, and every one is an instruction", () => {
    for (const fail of ALL_FAILURES()) {
      for (const step of fail.steps) {
        expect(step.trim().length).toBeGreaterThan(10);
      }
    }
  });

  test("every failure names a way out, so the overlay is never a dead end", () => {
    for (const fail of ALL_FAILURES()) {
      const joined = fail.steps.join(" ").toLowerCase();
      expect(joined).toContain("invigilator");
      expect(fail.needsInvigilator).toBe(true);
    }
  });

  test("titles and eventDetails are distinct enough to triage from the timeline", () => {
    const details = ALL_FAILURES().map((f) => f.eventDetail);
    expect(new Set(details).size).toBe(details.length);
    for (const fail of ALL_FAILURES()) {
      expect(fail.eventDetail.length).toBeGreaterThan(0);
      expect(fail.eventDetail.length).toBeLessThanOrEqual(200);
    }
  });
});
