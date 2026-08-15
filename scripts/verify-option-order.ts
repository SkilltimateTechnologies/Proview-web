/**
 * End-to-end proof that per-student option shuffling never costs a student a mark.
 *
 *   bun scripts/verify-option-order.ts                        # against localhost:3000
 *   bun scripts/verify-option-order.ts --base <url>           # against a deployed server
 *   bun scripts/verify-option-order.ts --roll DEMO001 --password Welcome@123
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A UNIT TEST
 * --------------------------------------------
 * Options are permuted for display only: the client sends the index it DISPLAYED
 * and the server maps it back to the ORIGINAL index before storing, so
 * `answers.response` keeps the exact same meaning it has always had and every
 * already-graded attempt is untouched. That mapping has to be applied in five
 * separate places (bundle, autosave, submit, resume prefill, review) and in the
 * RIGHT DIRECTION in each. A unit test on the permutation helper proves the maths;
 * it cannot prove the wiring. Getting one direction backwards is invisible in
 * tests and catastrophic in production: every student clicks the right answer and
 * scores zero.
 *
 * So this drives the real HTTP endpoints as a real student and asserts against the
 * database: it creates a throwaway exam out of existing MCQs, answers every
 * question by TEXT (never by index), and requires a 100% score plus a
 * self-consistent review screen. It also asserts the untranslated path — a client
 * on a bundle cached before this feature shipped sends no scheme token and its
 * indices must be stored verbatim.
 *
 * Everything it creates (exam, roster row, attempt, answers) is deleted in a
 * finally block, including on failure.
 *
 * Exits non-zero on any violation so it can gate a deploy.
 */
import { createClient } from "@libsql/client";

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const BASE = arg("--base", "http://localhost:3000").replace(/\/$/, "");
const ROLL = arg("--roll", "DEMO001");
const PASSWORD = arg("--password", "Welcome@123");
const QCOUNT = Number(arg("--questions", "6"));

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
const q = async (sql: string, args: any[] = []) => (await db.execute({ sql, args })).rows as any[];

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

const jparse = (v: unknown) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

const rid = (p: string) => `${p}_verify${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- resolve the student -----------------------------------------------------
const [stu] = await q("select id, tenant_id, name, roll_no from students where upper(trim(roll_no)) = ? limit 1", [ROLL.toUpperCase().trim()]);
if (!stu) throw new Error(`student ${ROLL} not found`);
console.log(`student: ${stu.name} (${stu.roll_no})  base: ${BASE}\n`);

// ---- pick real MCQs ----------------------------------------------------------
// Real bank questions, not fixtures: the point is to exercise the same rows the
// exam server will actually serve, including their authored option text.
const picked = (await q(
  `select id, options, correct, points from questions
    where tenant_id = ? and type = 'mcq' and options is not null and correct is not null
    order by id limit ?`,
  [stu.tenant_id, QCOUNT],
)).filter((r) => Array.isArray(jparse(r.options)) && (jparse(r.options) as string[]).length >= 3);
if (picked.length < 2) throw new Error("need at least 2 usable mcq questions in this tenant");

type Q = { id: string; options: string[]; correct: number; points: number };
const qs: Q[] = picked.map((r) => ({
  id: r.id as string,
  options: jparse(r.options) as string[],
  correct: Number(jparse(r.correct)),
  points: Number(r.points) || 1,
}));
const byId = new Map(qs.map((x) => [x.id, x]));
const totalPoints = qs.reduce((s, x) => s + x.points, 0);

const examId = rid("ex");
const now = Date.now();

try {
  // ---- throwaway exam, visible ONLY to this one student ----------------------
  await q(
    `insert into exams (id, tenant_id, title, class_id, section_ids, assign_mode, status, start_at, end_at, duration_min, total_points, hold_ms, extra_min, created_at)
     values (?, ?, ?, null, null, 'students', 'live', ?, ?, 60, ?, 0, 0, ?)`,
    [examId, stu.tenant_id, `SELF-CHECK option order ${new Date(now).toISOString()}`, now - 60_000, now + 3_600_000, totalPoints, now],
  );
  for (let i = 0; i < qs.length; i++) {
    await q("insert into exam_questions (id, exam_id, question_id, `order`, points) values (?, ?, ?, ?, ?)", [rid("eq"), examId, qs[i]!.id, i, qs[i]!.points]);
  }
  await q("insert into exam_roster (id, exam_id, student_id, mode, created_at) values (?, ?, ?, 'add', ?)", [rid("er"), examId, stu.id, now]);

  // ---- log in as the student ------------------------------------------------
  const loginRes = await fetch(`${BASE}/api/students/verify-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: ROLL, password: PASSWORD }),
  });
  const login = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !login.token) throw new Error(`student login failed (${loginRes.status}) ${JSON.stringify(login).slice(0, 200)}`);
  const H = { "Content-Type": "application/json", "X-Student-Token": login.token as string };
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}/api${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body: body as any };
  };

  // ---- 1. bundle: shuffled, stable, complete --------------------------------
  const b1 = await api(`/student/exams/${examId}/bundle`);
  if (b1.status !== 200) throw new Error(`bundle failed (${b1.status}) ${JSON.stringify(b1.body).slice(0, 200)}`);
  const token: string | undefined = b1.body.optionOrder;
  check("bundle carries an option-order scheme token", typeof token === "string" && token.length > 0, String(token));

  const shown = new Map<string, string[]>();
  for (const bq of b1.body.questions as { id: string; options: string[] }[]) shown.set(bq.id, bq.options);
  check("bundle returns every question", shown.size === qs.length, `${shown.size}/${qs.length}`);

  // Same multiset of option text, so nothing was dropped, duplicated or rewritten.
  const sameSet = qs.every((x) => {
    const s = shown.get(x.id) ?? [];
    return s.length === x.options.length && [...s].sort().join("\u0000") === [...x.options].sort().join("\u0000");
  });
  check("displayed options are a permutation of the authored options", sameSet);

  // At least one question must actually be reordered, otherwise the whole feature
  // is silently inert and every assertion below would pass on an identity mapping.
  const reordered = qs.filter((x) => (shown.get(x.id) ?? []).join("\u0000") !== x.options.join("\u0000")).length;
  check("at least one question is genuinely reordered", reordered > 0, `${reordered}/${qs.length} reordered`);

  // A refetch must be identical — the student may reload mid-exam, and an unstable
  // order would repoint every answer they had already given.
  const b2 = await api(`/student/exams/${examId}/bundle`);
  const stable = (b2.body.questions as { id: string; options: string[] }[]).every((bq) => (shown.get(bq.id) ?? []).join("\u0000") === bq.options.join("\u0000"));
  check("option order is stable across refetches", stable);

  // ---- 2. start: attempt stamped with the scheme ----------------------------
  const start = await api(`/student/attempts/${examId}/start`, { method: "POST", body: JSON.stringify({ optionOrder: token }) });
  if (start.status !== 200 || !start.body.attemptId) throw new Error(`start failed (${start.status}) ${JSON.stringify(start.body).slice(0, 200)}`);
  const attemptId = start.body.attemptId as string;
  const [attRow] = await q("select option_order from attempts where id = ?", [attemptId]);
  check("attempt records the option-order scheme", attRow?.option_order === token, `option_order=${String(attRow?.option_order)}`);

  // ---- 3. a client with NO token is stored verbatim -------------------------
  // This is the offline-cached-bundle case: that client is looking at the original
  // authored order, so translating its indices would corrupt a correct answer.
  const probeQ = qs[0]!;
  const probeVal = (probeQ.correct + 1) % probeQ.options.length;
  await api(`/student/attempts/${attemptId}/answers`, { method: "POST", body: JSON.stringify({ answers: [{ questionId: probeQ.id, response: probeVal }] }) });
  const [probeRow] = await q("select response from answers where attempt_id = ? and question_id = ?", [attemptId, probeQ.id]);
  check("untranslated client (no token): index stored verbatim", Number(jparse(probeRow?.response)) === probeVal, `sent ${probeVal}, stored ${String(jparse(probeRow?.response))}`);

  const untranslatedStatus = await api(`/student/attempts/${examId}/status`);
  check("untranslated client (no token): resume returns the raw stored index", Number(untranslatedStatus.body.answers?.[probeQ.id]) === probeVal, `got ${String(untranslatedStatus.body.answers?.[probeQ.id])}`);

  // A stale/unknown token must be treated as "do not translate", never as current.
  const bogus = await api(`/student/attempts/${examId}/status?optionOrder=v0-bogus`);
  check("unknown scheme token is inert (not translated)", Number(bogus.body.answers?.[probeQ.id]) === probeVal, `got ${String(bogus.body.answers?.[probeQ.id])}`);

  // ---- 4. answer every question by TEXT ------------------------------------
  // The whole point: the student clicks the option that READS correct. What index
  // that happens to be on their screen is the machine's problem, not theirs.
  const clicked = new Map<string, number>();
  for (const x of qs) {
    const s = shown.get(x.id)!;
    const correctText = x.options[x.correct]!;
    const displayIdx = s.indexOf(correctText);
    if (displayIdx < 0) { check(`correct text present for ${x.id}`, false, correctText); continue; }
    clicked.set(x.id, displayIdx);
    const r = await api(`/student/attempts/${attemptId}/answers`, {
      method: "POST",
      body: JSON.stringify({ answers: [{ questionId: x.id, response: displayIdx }], optionOrder: token }),
    });
    if (r.status !== 200) check(`autosave accepted for ${x.id}`, false, `status ${r.status}`);
  }

  const stored = await q("select question_id, response from answers where attempt_id = ?", [attemptId]);
  const storedMap = new Map(stored.map((r) => [r.question_id as string, Number(jparse(r.response))]));
  const allOriginal = qs.every((x) => storedMap.get(x.id) === x.correct);
  check(
    "autosave stores the ORIGINAL correct index for every question",
    allOriginal,
    qs.map((x) => `${x.id.slice(-6)}:clicked ${clicked.get(x.id)}→stored ${storedMap.get(x.id)} (correct ${x.correct})`).join(", "),
  );

  // ---- 5. resume prefill comes back in the student's own order --------------
  const st = await api(`/student/attempts/${examId}/status?optionOrder=${encodeURIComponent(token!)}`);
  const resumeOk = qs.every((x) => Number(st.body.answers?.[x.id]) === clicked.get(x.id));
  check("resume (/status) returns the indices the student actually clicked", resumeOk);

  const st2 = await api(`/student/attempts/${examId}/start`, { method: "POST", body: JSON.stringify({ optionOrder: token }) });
  const resumeOk2 = qs.every((x) => Number(st2.body.answers?.[x.id]) === clicked.get(x.id));
  check("resume (/start) returns the indices the student actually clicked", resumeOk2);

  // ---- 6. submit and grade -------------------------------------------------
  const sub = await api(`/student/attempts/${attemptId}/submit`, {
    method: "POST",
    body: JSON.stringify({
      answers: qs.map((x) => ({ questionId: x.id, response: clicked.get(x.id) })),
      integrityEvents: [],
      optionOrder: token,
    }),
  });
  check("submit accepted", sub.status === 200, `status ${sub.status}`);
  check("every correct click scores full marks (100%)", Number(sub.body.score) === 100, `score ${String(sub.body.score)}`);

  const graded = await q("select question_id, score, max_score from answers where attempt_id = ?", [attemptId]);
  const perQ = graded.every((r) => Number(r.score) === Number(r.max_score) && Number(r.max_score) > 0);
  check("per-question scores equal per-question max", perQ, graded.map((r) => `${String(r.question_id).slice(-6)}:${r.score}/${r.max_score}`).join(", "));

  // Stored responses must STILL be original indices after submit — history and
  // every report read this column and must not have been rewritten.
  const afterSubmit = await q("select question_id, response from answers where attempt_id = ?", [attemptId]);
  const stillOriginal = afterSubmit.every((r) => Number(jparse(r.response)) === byId.get(r.question_id as string)!.correct);
  check("submit leaves ORIGINAL indices in answers.response", stillOriginal);

  // ---- 7. review matches what the student saw ------------------------------
  await q("update exams set status = 'finished' where id = ?", [examId]);
  const rev = await api(`/student/attempts/${attemptId}/review`);
  check("review accessible once the exam closes", rev.status === 200, `status ${rev.status}`);
  const revQs = (rev.body.questions ?? []) as { id: string; options: string[]; correct: unknown; response: unknown }[];
  const revOrderOk = revQs.every((r) => (shown.get(r.id) ?? []).join("\u0000") === (r.options ?? []).join("\u0000"));
  check("review shows options in the SAME order the student sat", revOrderOk);
  const revPickOk = revQs.every((r) => Number(r.response) === clicked.get(r.id) && Number(r.correct) === clicked.get(r.id));
  check("review marks the student's own click as the correct one", revPickOk);

  // ---- 8. attempts sat BEFORE this feature render untouched ----------------
  // Simulated by clearing the scheme stamp: option_order NULL is exactly what every
  // pre-deploy attempt has, and those students saw the authored order.
  await q("update attempts set option_order = null where id = ?", [attemptId]);
  const revOld = await api(`/student/attempts/${attemptId}/review`);
  const revOldQs = (revOld.body.questions ?? []) as { id: string; options: string[]; correct: unknown }[];
  const authoredOk = revOldQs.every((r) => byId.get(r.id)!.options.join("\u0000") === (r.options ?? []).join("\u0000"));
  const authoredCorrectOk = revOldQs.every((r) => Number(r.correct) === byId.get(r.id)!.correct);
  check("unstamped (pre-feature) attempt reviews in the AUTHORED order", authoredOk);
  check("unstamped attempt's correct answer is the authored index", authoredCorrectOk);
} finally {
  // ---- cleanup: leave the database exactly as it was ------------------------
  const atts = await q("select id from attempts where exam_id = ?", [examId]);
  for (const a of atts) {
    await q("delete from answers where attempt_id = ?", [a.id]);
    await q("delete from integrity_events where attempt_id = ?", [a.id]);
  }
  await q("delete from attempts where exam_id = ?", [examId]);
  await q("delete from exam_roster where exam_id = ?", [examId]);
  await q("delete from exam_questions where exam_id = ?", [examId]);
  await q("delete from exams where id = ?", [examId]);
  const [left] = await q("select count(*) as c from exams where id = ?", [examId]);
  console.log(`\ncleanup: exam ${examId} removed (${Number(left?.c ?? 0) === 0 ? "verified gone" : "STILL PRESENT — delete manually"})`);
}

console.log(`\n${failures === 0 ? "OPTION ORDER VERIFIED END TO END" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
