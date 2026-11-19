/**
 * The part of a question's meta that question LISTS carry. Rubrics, reference
 * solutions and test cases stay out (they can be tens of KB each and the exam
 * builder loads every question visible to a college); the editor loads them with
 * GET /questions/:id. Counts tell the list what is there without shipping it.
 */
export function listMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["language", "languageId", "languageLabel", "starter", "explanation", "timeLimitSec"]) {
    if (m[k] !== undefined) out[k] = m[k];
  }
  if (Array.isArray(m.tests)) out.testCount = m.tests.length;
  if (typeof m.rubric === "string" && m.rubric.trim()) out.hasRubric = true;
  return out;
}
