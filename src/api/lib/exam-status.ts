/**
 * Derived (effective) exam status.
 *
 * The `exams.status` column is the ADMIN'S INTENT ("draft" | "scheduled" | "live" |
 * "finished"). It is not self-updating: an exam scheduled for last month still reads
 * "scheduled" forever unless a human presses a button. Anything that needs to know
 * what is actually happening right now must therefore derive status from the clock,
 * never read the raw column.
 *
 * This module is the single source of that derivation. It exists because the same
 * logic was previously inlined in the /reports list handler while sibling handlers
 * compared the raw column instead — which silently hid every conducted exam from
 * TPOs, whose Reports page filtered on `status === "finished"`.
 */

/** Minimal exam shape needed to derive status. */
export type StatusExam = {
  status: string;
  startAt: Date | number | string | null;
  endAt: Date | number | string | null;
  extraMin?: number | null;
  holdMs?: number | null;
  heldAt?: number | string | Date | null;
};

export type EffStatus = "draft" | "scheduled" | "live" | "ended" | "finished";

/** Coerce a timestamp column (Date | epoch ms | ISO string | null) to epoch ms. */
export function toMs(v: Date | number | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = typeof v === "number" ? v : v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** True once the exam's start time has passed. Unscheduled (null start) is never started. */
export function isStarted(e: Pick<StatusExam, "startAt">, now: number = Date.now()): boolean {
  const ms = toMs(e.startAt);
  return ms !== null && now >= ms;
}

/**
 * The moment the exam window truly closes: endAt plus the admin's extra time plus any
 * accumulated hold. Null when the exam has no end (open-ended).
 */
export function closesAtMs(e: StatusExam): number | null {
  const end = toMs(e.endAt);
  if (end === null) return null;
  return end + (e.extraMin ?? 0) * 60_000 + (e.holdMs ?? 0);
}

/**
 * Effective status right now.
 *
 * - "draft" and "finished" are terminal admin states — returned as-is.
 * - A held (paused) exam never auto-ends; the admin must resume or finish it.
 * - Past its closing time -> "ended" (conducted, but never formally finished).
 * - Started and not yet closed -> "live", even if the column still says "scheduled".
 */
export function examEffStatus(e: StatusExam, now: number = Date.now()): EffStatus {
  if (e.status === "draft" || e.status === "finished") return e.status;
  const closes = closesAtMs(e);
  if (!e.heldAt && closes !== null && now > closes) return "ended";
  if (e.status === "live") return "live";
  if (e.status === "scheduled" && isStarted(e, now)) return "live";
  return (e.status as EffStatus) ?? "scheduled";
}

/**
 * Was this exam actually CONDUCTED — i.e. is it over?
 *
 * True for a formally finished exam and for one whose window simply lapsed. This is
 * the correct gate for TPO report access: results exist and nothing is in flight.
 */
export function isConcluded(e: StatusExam, now: number = Date.now()): boolean {
  const s = examEffStatus(e, now);
  return s === "finished" || s === "ended";
}

/**
 * Should this exam appear in the Reports list at all?
 *
 * Concluded exams plus currently-live ones (admins watch partial results mid-exam).
 * Excludes drafts and exams scheduled in the future, which have no results yet.
 */
export function isReportable(e: StatusExam, now: number = Date.now()): boolean {
  const s = examEffStatus(e, now);
  return s === "finished" || s === "ended" || s === "live";
}
