/**
 * Grade identical answers once.
 *
 * WHY: after the bell the queue sends every subjective/coding answer to the AI
 * separately. Identical answers to the same question (short factual answers,
 * shared starter code left unchanged, copied solutions) were each graded, billed
 * and waited for on their own — and could come back with DIFFERENT scores, since
 * a model is not deterministic. Reusing the first grade for an identical answer
 * saves the call and makes the marking consistent.
 *
 * The key covers everything the grade depends on: provider, question id, the
 * question text and rubric (so an edited question is graded afresh), the maximum
 * score and the exact answer text. Only real grades are kept: a thrown error is
 * never cached, and neither is the parser's "Could not grade automatically"
 * fallback, so a bad reply is retried for the next identical answer instead of
 * being copied to it. Concurrent identical requests share one call. In memory,
 * per process, bounded and expiring.
 */
import { createHash } from "node:crypto";

export type GradeResult = { score: number; notes: string };
export type GradeInput = {
  provider: string | null | undefined;
  questionId: string;
  question: string;
  rubric?: string;
  maxPoints: number;
  studentAnswer: string;
  isCode?: boolean;
  language?: string;
};

export const UNGRADED_NOTE = "Could not grade automatically.";
const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 20_000;

export class GradeCache {
  private readonly done = new Map<string, { at: number; value: GradeResult }>();
  private readonly inFlight = new Map<string, Promise<GradeResult>>();
  hits = 0;
  misses = 0;

  constructor(private readonly now: () => number = Date.now) {}

  static keyOf(i: GradeInput): string {
    const h = createHash("sha256");
    for (const part of [i.provider ?? "", i.questionId, i.question, i.rubric ?? "", String(i.maxPoints), i.isCode ? "code" : "text", i.language ?? "", i.studentAnswer]) {
      h.update(part);
      h.update("\u0000");
    }
    return h.digest("hex");
  }

  async grade(input: GradeInput, call: () => Promise<GradeResult>): Promise<GradeResult> {
    const key = GradeCache.keyOf(input);
    const hit = this.done.get(key);
    if (hit && this.now() - hit.at < TTL_MS) {
      this.hits += 1;
      return { ...hit.value };
    }
    const running = this.inFlight.get(key);
    if (running) {
      this.hits += 1;
      return { ...(await running) };
    }
    this.misses += 1;
    const p = (async () => {
      try {
        const value = await call();
        if (value.notes !== UNGRADED_NOTE) {
          if (this.done.size >= MAX_ENTRIES) this.done.clear();
          this.done.set(key, { at: this.now(), value: { ...value } });
        }
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return { ...(await p) };
  }
}

export const gradeCache = new GradeCache();
