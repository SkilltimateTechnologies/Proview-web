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
  const prompt = `You are grading a student's ${isCode ? `code (${language})` : "answer"} for an engineering exam.

QUESTION:
${question}

${rubric ? `RUBRIC / EXPECTED:\n${rubric}\n` : ""}
STUDENT ANSWER:
${studentAnswer}

Max points: ${maxPoints}.
Evaluate correctness, logic, ${isCode ? "edge cases and code quality" : "completeness and clarity"}.
Return ONLY JSON: { "score": <number 0-${maxPoints}>, "notes": "<2-3 sentence feedback>" }.`;

  const { text } = await generateText({ model: gateway(modelFor(provider)), prompt });
  const res = extractJson<{ score: number; notes: string }>(text, { score: 0, notes: "Could not grade automatically." });
  const score = Math.max(0, Math.min(maxPoints, Number(res.score) || 0));
  return { score, notes: res.notes || "" };
}
