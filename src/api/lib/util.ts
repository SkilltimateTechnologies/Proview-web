export function id(prefix = ""): string {
  const s = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${s}` : s;
}

export function displayId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** Auto-grade an objective question. Returns null if type is AI-graded. */
export function autoGrade(
  type: string,
  correct: unknown,
  response: unknown,
  maxScore: number,
): number | null {
  // A blank / unanswered objective question is always 0. Never coerce a missing
  // answer into a matching value: e.g. Number(null) === Number("0") is true, so
  // an unanswered MCQ whose correct option is index 0 (or a truefalse whose
  // answer is False) would otherwise be awarded full marks. Guard first.
  const blank =
    response == null ||
    (typeof response === "string" && response.trim() === "") ||
    (Array.isArray(response) && response.length === 0);

  switch (type) {
    case "mcq":
    case "fillblank":
      if (blank) return 0;
      return Number(response) === Number(correct) ? maxScore : 0;
    case "truefalse":
      if (blank) return 0;
      return Boolean(response) === Boolean(correct) ? maxScore : 0;
    case "multi": {
      if (blank) return 0;
      const c = Array.isArray(correct) ? [...(correct as number[])].sort() : [];
      const r = Array.isArray(response) ? [...(response as number[])].sort() : [];
      const same = c.length === r.length && c.every((v, i) => v === r[i]);
      return same ? maxScore : 0;
    }
    default:
      return null; // short | essay | coding -> AI graded
  }
}

/**
 * Effective absolute deadline for an attempt, in ms.
 * base = startedAt + duration, capped by the exam window (endAt),
 * then extended by: student pausedMs (legacy) + admin extraMin + admin holdMs
 * + the currently-running hold (now - heldAt) if the exam is held right now.
 */
export function effectiveEndMs(
  exam: { durationMin: number; endAt: Date | number | string | null; extraMin?: number | null; holdMs?: number | null; heldAt?: Date | number | string | null },
  attempt: { startedAt: Date | number | string | null; pausedMs?: number | null },
  now: number,
): number {
  const startedMs = attempt.startedAt ? new Date(attempt.startedAt).getTime() : now;
  let base = startedMs + exam.durationMin * 60_000;
  if (exam.endAt) base = Math.min(base, new Date(exam.endAt).getTime());
  let extra = (attempt.pausedMs ?? 0) + (exam.extraMin ?? 0) * 60_000 + (exam.holdMs ?? 0);
  if (exam.heldAt) extra += Math.max(0, now - new Date(exam.heldAt).getTime());
  return base + extra;
}

/**
 * The earliest moment a student may press Submit: their own start time plus the
 * minimum writing time (Settings → Proctoring, default 20 minutes), shifted by
 * any time the attempt was paused for a network drop. Capped at the exam length,
 * so a short quiz is never unsubmittable. The deadline always wins: the guard on
 * the submit route lets everything through once the exam's own time is up.
 */
export function submitAvailableAtMs(
  exam: { durationMin: number },
  attempt: { startedAt: Date | number | string | null; pausedMs?: number | null },
  minSubmitMinutes: number,
  now: number,
): number {
  const startedMs = attempt.startedAt ? new Date(attempt.startedAt).getTime() : now;
  const minutes = Math.max(0, Math.min(Number(minSubmitMinutes) || 0, exam.durationMin));
  return startedMs + minutes * 60_000 + (attempt.pausedMs ?? 0);
}

export function computeYear(batchStartYear: number): number {
  const now = new Date();
  // Academic year rolls in June/July.
  const yearsElapsed = now.getFullYear() - batchStartYear + (now.getMonth() >= 6 ? 1 : 0);
  return Math.max(1, Math.min(4, yearsElapsed));
}
