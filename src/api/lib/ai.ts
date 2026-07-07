import { generateText } from "ai";
import { gateway, modelFor } from "./gateway";

function extractJson<T>(text: string, fallback: T): T {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;
    const start = raw.indexOf("{");
    const startArr = raw.indexOf("[");
    const s = startArr !== -1 && (startArr < start || start === -1) ? startArr : start;
    if (s === -1) return fallback;
    const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    return JSON.parse(raw.slice(s, end + 1)) as T;
  } catch {
    return fallback;
  }
}

export type GeneratedQuestion = {
  type: "mcq" | "multi" | "truefalse" | "fillblank" | "short" | "essay" | "coding";
  prompt: string;
  options?: string[];
  correct?: unknown;
  points?: number;
  difficulty?: "easy" | "medium" | "hard";
  meta?: Record<string, unknown>;
};

export async function generateQuestions(opts: {
  topic: string;
  type: GeneratedQuestion["type"];
  count: number;
  difficulty: string;
  provider?: string | null;
}): Promise<GeneratedQuestion[]> {
  const { topic, type, count, difficulty, provider } = opts;
  const prompt = `You are an exam question writer for engineering college assessments.
Generate exactly ${count} ${difficulty} difficulty "${type}" questions on the topic: "${topic}".

Rules by type:
- mcq: 4 options, "correct" is the index (0-3) of the single correct option.
- multi: 4-5 options, "correct" is an array of correct indices.
- truefalse: no options, "correct" is a boolean.
- fillblank: use ____ in the prompt, "options" is a list of dropdown choices (4), "correct" is the index of the right choice.
- short: no options, no correct (AI-graded). Include a "meta.rubric" string.
- essay: no options, no correct (AI-graded). Include a "meta.rubric" string.
- coding: no options, no correct. Include meta.language, meta.starter, meta.solution, meta.tests (array of {input, expected}).

Return ONLY a JSON array. Each item: { "type", "prompt", "options"?, "correct"?, "points", "difficulty", "meta"? }.`;

  const { text } = await generateText({ model: gateway(modelFor(provider)), prompt });
  const items = extractJson<GeneratedQuestion[]>(text, []);
  return Array.isArray(items) ? items.slice(0, count) : [];
}

export async function gradeSubjective(opts: {
  question: string;
  rubric?: string;
  studentAnswer: string;
  maxPoints: number;
  isCode?: boolean;
  language?: string;
  provider?: string | null;
}): Promise<{ score: number; notes: string }> {
  const { question, rubric, studentAnswer, maxPoints, isCode, language, provider } = opts;

  const prompt = isCode
    ? `You are grading a student's code (${language || "unknown language"}) written in a browser-based exam IDE.

READ THIS GRADING CONTEXT CAREFULLY — IT OVERRIDES YOUR DEFAULT INSTINCTS:
- The exam IDE has NO standard input (stdin). Students are REQUIRED to hardcode / declare their own sample values (e.g. n = 121) to demonstrate their logic. This is correct, expected exam practice.
  * NEVER deduct marks for hardcoded values, a declared variable instead of input(), or "not taking user input / not being general / reusability". Treat a hardcoded value EXACTLY as if it were valid user input.
- Grade ONLY on whether the core algorithm / logic is CORRECT and would produce the right result for the problem.
- If the logic correctly solves what the question asks, award FULL marks (${maxPoints} out of ${maxPoints}) — even if it does not handle uncommon edge cases (negative numbers, empty input, zero, very large values, etc.). Do NOT invent edge-case requirements. Only require an edge case if the QUESTION TEXT explicitly demands it.
- Do NOT deduct for style, variable naming, missing comments, missing error handling, print wording, or "could be cleaner".
- Deduct marks ONLY for genuine defects: incorrect logic, wrong output, or code that fails to run / does not address what the question actually asks.

QUESTION:
${question}
${rubric ? `\nREFERENCE SOLUTION / RUBRIC (guidance only, student's approach may differ and still be fully correct):\n${rubric}\n` : ""}
STUDENT CODE:
${studentAnswer}

Scoring guide:
- Correct working logic that solves the problem => FULL ${maxPoints}.
- Correct approach with one real logical flaw => partial.
- Wrong approach / does not solve the problem / does not run => low or 0.

Feedback rules for "notes": 2-3 sentences. If you award full marks, simply confirm what is correct — do NOT list any "however"/"but" shortcomings. NEVER mention hardcoding, user input, input(), reusability, or a missing edge case as a negative unless it actually caused a deduction that the QUESTION explicitly required.

Return ONLY JSON: { "score": <number 0-${maxPoints}>, "notes": "<feedback>" }.`
    : `You are grading a student's answer for an engineering exam.

QUESTION:
${question}
${rubric ? `\nRUBRIC / EXPECTED:\n${rubric}\n` : ""}
STUDENT ANSWER:
${studentAnswer}

Max points: ${maxPoints}.
Evaluate correctness, completeness and clarity. If the answer is correct and complete, award full marks. Deduct only for genuine errors or missing required content — not for phrasing or brevity.
Return ONLY JSON: { "score": <number 0-${maxPoints}>, "notes": "<2-3 sentence feedback>" }.`;

  const { text } = await generateText({ model: gateway(modelFor(provider)), prompt });
  const res = extractJson<{ score: number; notes: string }>(text, { score: 0, notes: "Could not grade automatically." });
  const score = Math.max(0, Math.min(maxPoints, Number(res.score) || 0));
  return { score, notes: res.notes || "" };
}
