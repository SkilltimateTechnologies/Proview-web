/**
 * Per-student option shuffling for objective questions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Question ORDER is already shuffled per student, but option ORDER was not, so the
 * answer key was identical for everyone. Two live papers were badly skewed:
 *
 *   General Set-1     (40 mcq): A=6  B=22 (55%)  C=12  D=0
 *   Python DSA SET 4  (20 mcq): A=16 (80%) B=2   C=2   D=0
 *
 * A student who understood nothing and picked "B" (or "A") for every question
 * scored far above chance, and nobody could pick "D" and be right. That is a
 * marking defect, not a student achievement.
 *
 * Shuffling the options per student removes the exploit structurally: every
 * student sees the same four options in a different order, so no single letter is
 * worth more than chance for anyone.
 *
 * WHY DISPLAY-TIME ONLY
 * ---------------------
 * We deliberately do NOT rewrite questions.options / questions.correct in the
 * database:
 *   - questions are shared across exams through categories, so a rewrite would
 *     silently alter papers that are already graded, and
 *   - answers.response stores the chosen option as an INDEX. Reordering the stored
 *     options would reinterpret every historical answer row and corrupt past
 *     reports.
 *
 * So the permutation is applied when the paper is rendered and undone on the way
 * back in. `answers.response` always holds the ORIGINAL index, which means the
 * grading path (autoGrade) and every historical row are untouched — the change
 * only affects exams taken from here on, which is exactly the requirement.
 *
 * THE FOUR PLACES IT MUST BE APPLIED (all of them, or answers get misread)
 *   1. GET  /student/exams/:id/bundle          options -> display order
 *   2. POST /student/attempts/:id/answers      response: display -> original
 *   3. POST /student/attempts/:id/submit       response: display -> original
 *   4. /start + /status resume prefill         response: original -> display
 *   (review is translated too, so a student sees the letters they actually saw)
 *
 * STALE-BUNDLE SAFETY
 * -------------------
 * The bundle is cached in localStorage and served offline-first, so a client can
 * be holding a paper rendered by an OLDER build (original order). If we blindly
 * un-permuted its answers we would corrupt them. The bundle therefore carries an
 * `optionOrder` token which the client echoes back on every write. We only
 * translate when the token matches the current scheme; a client with no token (or
 * an older one) rendered the original order, so its indices are already original
 * and are stored as-is. Nothing about the token is secret — it identifies the
 * rendering scheme, never the permutation itself, which stays server-side.
 */

/**
 * Current scheme token. Bump this if the permutation function ever changes, so
 * in-flight clients rendered by the old build keep being interpreted correctly.
 */
export const OPTION_ORDER_TOKEN = "v1";

/** Only index-valued objective types can be permuted. */
const PERMUTABLE_TYPES = new Set(["mcq", "multi", "fillblank"]);

/**
 * Options whose meaning depends on their position, or that refer to other
 * options. "All of the above" makes no sense in slot 2, so such questions are
 * left in their authored order.
 *
 * Kept deliberately narrow: patterns like "A & B" or "A | B" are bitwise-operator
 * ANSWERS in the live DSA bank, not references to options A and B, and must NOT
 * match.
 */
const ORDER_DEPENDENT =
  /\b(all|none|both|any|either)\s+of\s+(the\s+)?(above|below|these|foregoing)\b|\ball\s+the\s+above\b|\bnone\s+of\s+these\b|\ball\s+of\s+these\b|\bboth\s+\(?[a-d]\)?\s+and\s+\(?[a-d]\)?\b|\boptions?\s+\(?[a-d]\)?\s+and\s+\(?[a-d]\)?\b|\b(a|b|c|d)\s+and\s+(a|b|c|d)\s+(are|is)\s+(both\s+)?correct\b/i;

/** True when this question's options must keep their authored order. */
export function hasOrderDependentOptions(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  return options.some((o) => typeof o === "string" && ORDER_DEPENDENT.test(o));
}

/** True when this question's options may be shuffled for display. */
export function isPermutable(type: unknown, options: unknown): boolean {
  if (typeof type !== "string" || !PERMUTABLE_TYPES.has(type)) return false;
  if (!Array.isArray(options) || options.length < 2) return false;
  if (hasOrderDependentOptions(options)) return false;
  return true;
}

/** Deterministic 32-bit hash — same style as the existing question-order shuffle. */
function hashSeed(s: string): number {
  let seed = 0;
  for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
  // Never return 0: an all-zero LCG state produces a constant stream.
  return seed === 0 ? 0x9e3779b9 : seed;
}

/**
 * The permutation for one (student, exam, question).
 *
 * Returns display->original: `perm[displayPosition] === originalIndex`.
 *
 * Deterministic, so it is identical on the render path, on every autosave, on a
 * resume from a different machine and at submit — including after a server
 * restart mid-exam. Nothing is persisted.
 *
 * Returns the identity permutation when the question must not be shuffled, so
 * callers can use it unconditionally.
 */
export function optionPermutation(
  studentId: string,
  examId: string,
  questionId: string,
  count: number,
): number[] {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const perm = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return perm;
  let seed = hashSeed(`${studentId}:${examId}:${questionId}:opt-${OPTION_ORDER_TOKEN}`);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/** Reorder an options array into the student's display order. */
export function optionsForDisplay<T>(options: T[], perm: number[]): T[] {
  if (perm.length !== options.length) return options;
  return perm.map((orig) => options[orig]);
}

/**
 * One index, display space -> original space.
 * Anything out of range is returned untouched: a watchdog on the answer path must
 * never invent an answer, and an unparseable response grades exactly as it did
 * before (wrong), instead of throwing mid-exam.
 */
export function displayToOriginalIndex(displayIdx: number, perm: number[]): number {
  if (!Number.isInteger(displayIdx) || displayIdx < 0 || displayIdx >= perm.length) return displayIdx;
  return perm[displayIdx];
}

/** One index, original space -> display space. */
export function originalToDisplayIndex(originalIdx: number, perm: number[]): number {
  if (!Number.isInteger(originalIdx) || originalIdx < 0 || originalIdx >= perm.length) return originalIdx;
  const at = perm.indexOf(originalIdx);
  return at === -1 ? originalIdx : at;
}

/**
 * Translate a stored/incoming response between index spaces.
 *
 * The response TYPE is preserved exactly: a string stays a string ("2" -> "0"),
 * a number stays a number. autoGrade coerces with Number(), and historical rows
 * hold both shapes, so preserving the shape keeps this change invisible to every
 * other code path. Blanks, booleans, free text and code pass straight through.
 */
function translateResponse(response: unknown, perm: number[], dir: "toOriginal" | "toDisplay"): unknown {
  const one = dir === "toOriginal" ? displayToOriginalIndex : originalToDisplayIndex;

  if (typeof response === "number") return one(response, perm);
  if (typeof response === "string") {
    const t = response.trim();
    if (t === "" || !/^\d+$/.test(t)) return response;
    return String(one(Number(t), perm));
  }
  if (Array.isArray(response)) {
    // "multi": a set of indices. Re-sorted so the stored value is canonical and
    // two clients that ticked the same boxes in a different order still match.
    const mapped = response.map((v) => translateResponse(v, perm, dir));
    const allNumeric = mapped.every((v) => typeof v === "number");
    if (allNumeric) return (mapped as number[]).slice().sort((a, b) => a - b);
    const allDigits = mapped.every((v) => typeof v === "string" && /^\d+$/.test(v));
    if (allDigits) return (mapped as string[]).slice().sort((a, b) => Number(a) - Number(b));
    return mapped;
  }
  return response;
}

type QuestionShape = { id: string; type?: unknown; options?: unknown };

/**
 * Build a translator for one attempt.
 *
 * `questions` must be the exam's full question set (any order — lookup is by id).
 * `active` is false for a client that rendered the paper under an older scheme:
 * every method then becomes a pass-through, so old cached bundles and offline
 * clients keep working exactly as before.
 */
export function optionTranslator(
  studentId: string,
  examId: string,
  questions: QuestionShape[],
  active: boolean,
) {
  const perms = new Map<string, number[]>();
  if (active) {
    for (const q of questions) {
      if (!q || typeof q.id !== "string") continue;
      if (!isPermutable(q.type, q.options)) continue;
      const opts = q.options as unknown[];
      perms.set(q.id, optionPermutation(studentId, examId, q.id, opts.length));
    }
  }

  return {
    active,
    /** Questions that are being shuffled for this student. */
    size: perms.size,
    permFor(questionId: string): number[] | null {
      return perms.get(questionId) ?? null;
    },
    /** Options in the student's display order (unchanged when not shuffled). */
    display<T>(questionId: string, options: T[] | null): T[] | null {
      const perm = perms.get(questionId);
      if (!perm || !Array.isArray(options)) return options;
      return optionsForDisplay(options, perm);
    },
    /** What the student clicked -> what we store. */
    toOriginal(questionId: string, response: unknown): unknown {
      const perm = perms.get(questionId);
      if (!perm) return response;
      return translateResponse(response, perm, "toOriginal");
    },
    /** What we stored -> what the student's screen expects. */
    toDisplay(questionId: string, response: unknown): unknown {
      const perm = perms.get(questionId);
      if (!perm) return response;
      return translateResponse(response, perm, "toDisplay");
    },
  };
}

export type OptionTranslator = ReturnType<typeof optionTranslator>;

/**
 * Read the client's scheme token off a request (body field or header) and decide
 * whether to translate. Absent/unknown token => the client rendered the original
 * order => no translation.
 */
export function tokenIsCurrent(token: unknown): boolean {
  return typeof token === "string" && token === OPTION_ORDER_TOKEN;
}
