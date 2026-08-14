/**
 * Regression guard for the duplicate-row score corruption.
 *
 *   bun scripts/verify-invariants.ts                 # audit the database only
 *   bun scripts/verify-invariants.ts --race <url>    # audit + hammer a live server
 *
 * Run this after any change to answer persistence, the grading queue, or the
 * schema — and after provisioning or restoring any database.
 *
 * Background: a student was shown 103/100 because two `answers` rows existed for
 * one question and the grader summed both. A second student scored 0 on a full
 * paper because two overlapping finalizes wrote blank rows over real work. Both
 * came from select-then-insert races that only appear under concurrency, which is
 * exactly what a normal test run never produces — hence the --race mode, which
 * fires genuinely simultaneous writes at a real server.
 *
 * Exits non-zero on any violation so it can gate a deploy.
 */
import { createClient } from "@libsql/client";

const RACE_URL = process.argv.includes("--race")
  ? process.argv[process.argv.indexOf("--race") + 1]
  : null;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
const q = async (sql: string, args: any[] = []) => (await db.execute({ sql, args })).rows;

let failures = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

console.log("=== database invariants ===");

const REQUIRED = [
  { name: "answers_attempt_question_uq", table: "answers", cols: ["attempt_id", "question_id"] },
  { name: "attempts_exam_student_uq", table: "attempts", cols: ["exam_id", "student_id"] },
];

for (const idx of REQUIRED) {
  const present = (await q("select name from sqlite_master where type='index' and name=?", [idx.name])).length > 0;
  check(`unique index ${idx.name} exists`, present, present ? "" : "MISSING — duplicates can reappear");

  const dupes = Number(
    (await q(`select count(*) c from (select 1 from ${idx.table} group by ${idx.cols.join(",")} having count(*) > 1)`))[0]
      ?.c ?? 0,
  );
  check(`no duplicate ${idx.cols.join("+")} in ${idx.table}`, dupes === 0, `${dupes} duplicate group(s)`);
}

const impossible = Number((await q("select count(*) c from attempts where score > 100 or score < 0"))[0]?.c ?? 0);
check("no attempt scores outside 0..100", impossible === 0, `${impossible} attempt(s)`);

const denom = Number(
  (await q(`select count(*) c from attempts a join exams e on e.id = a.exam_id
            where a.status in ('graded','submitted')
              and (select coalesce(sum(coalesce(x.max_score,0)),0) from answers x where x.attempt_id = a.id) <> e.total_points`))[0]
    ?.c ?? 0,
);
check("every graded attempt's denominator equals its paper total", denom === 0, `${denom} mismatch(es)`);

const lostAll = Number(
  (await q(`select count(*) c from attempts a
            where a.status in ('graded','submitted') and a.answered_count > 0
              and not exists (select 1 from answers x where x.attempt_id = a.id
                                and x.response is not null and length(trim(x.response)) > 0)`))[0]?.c ?? 0,
);
check("no attempt reports answers but has none stored", lostAll === 0, `${lostAll} attempt(s)`);

// ---- concurrency proof against a real server ----
if (RACE_URL) {
  console.log(`\n=== race conditions vs ${RACE_URL} ===`);
  const { signStudentToken } = await import("../src/api/lib/student-token");
  const [stu] = await q("select id, tenant_id, class_id from students where roll_no='DEMO001'");
  if (!stu) throw new Error("DEMO001 student not found — cannot run race tests");
  const TEN = (stu as any).tenant_id, STU = (stu as any).id, CLS = (stu as any).class_id;
  const EX = "ex_ZZinv_race", AT = "att_ZZinv_race";

  const cleanup = async () => {
    await q("delete from answers where attempt_id=?", [AT]);
    await q("delete from attempts where id=?", [AT]);
    await q("delete from exam_questions where exam_id=?", [EX]);
    await q("delete from exams where id=?", [EX]);
  };

  try {
    await cleanup();
    const qs = await q("select id from questions where tenant_id=? and type='mcq' limit 2", [TEN]);
    if (qs.length < 2) throw new Error("need 2 mcq questions in this tenant");
    const now = Date.now();
    await q(
      `insert into exams (id,tenant_id,title,class_id,section_ids,status,start_at,end_at,duration_min,total_points,created_by,created_at,assign_mode)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [EX, TEN, "ZZ INVARIANT RACE TEST (auto-deleted)", CLS, "[]", "live", now - 60000, now + 3600000, 60, 2, "system", now, "class"],
    );
    for (let i = 0; i < 2; i++) {
      await q('insert into exam_questions (id,exam_id,question_id,"order",points) values (?,?,?,?,?)', [
        `eq_ZZinv_${i}`, EX, (qs[i] as any).id, i, 1,
      ]);
    }
    await q(
      `insert into attempts (id,exam_id,student_id,status,started_at,created_at,answered_count,paused_ms,disconnected)
       values (?,?,?,?,?,?,?,?,?)`,
      [AT, EX, STU, "in_progress", now, now, 0, 0, 0],
    );

    const token = await signStudentToken(STU);
    const [q1, q2] = [(qs[0] as any).id, (qs[1] as any).id];
    const post = (path: string, body: unknown) =>
      fetch(`${RACE_URL}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-student-token": token },
        body: JSON.stringify(body),
      });

    // 1. Many simultaneous autosaves for the SAME question (the original bug).
    const r1 = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post(`/student/attempts/${AT}/answers`, { questionId: q1, response: `race-${i}` }).then((r) => r.status)),
    );
    const n1 = Number((await q("select count(*) c from answers where attempt_id=? and question_id=?", [AT, q1]))[0]?.c ?? 0);
    check("12 concurrent autosaves on one question -> exactly 1 row", n1 === 1, `${n1} row(s), codes ${[...new Set(r1)].join("/")}`);
    check("no 5xx from concurrent autosaves", r1.every((s) => s === 200), `codes ${[...new Set(r1)].join("/")}`);

    // 2. Simultaneous batch autosaves across both questions.
    const r2 = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(`/student/attempts/${AT}/answers`, { answers: [{ questionId: q1, response: `b-${i}` }, { questionId: q2, response: `b2-${i}` }] }).then((r) => r.status),
      ),
    );
    const n2 = await q("select question_id, count(*) c from answers where attempt_id=? group by 1", [AT]);
    check("12 concurrent batch autosaves -> 1 row per question", n2.every((r: any) => Number(r.c) === 1), `rows ${n2.map((r: any) => r.c).join(",")}`);
    check("no 5xx from concurrent batch autosaves", r2.every((s) => s === 200), `codes ${[...new Set(r2)].join("/")}`);

    // 3. Simultaneous submits — the path that used to blank real answers.
    const r3 = await Promise.all(
      Array.from({ length: 3 }, () =>
        post(`/student/attempts/${AT}/submit`, { answers: [{ questionId: q1, response: "final" }, { questionId: q2, response: "final2" }], events: [] }).then((r) => r.status),
      ),
    );
    await new Promise((r) => setTimeout(r, 8000));
    const n3 = await q(
      `select count(*) c, sum(case when response is not null and length(trim(response))>0 then 1 else 0 end) wc
       from answers where attempt_id=? group by question_id`,
      [AT],
    );
    check("3 concurrent submits -> 1 row per question", n3.every((r: any) => Number(r.c) === 1), `rows ${n3.map((r: any) => r.c).join(",")}`);
    check("3 concurrent submits preserve answer content", n3.every((r: any) => Number(r.wc) === 1), `withContent ${n3.map((r: any) => r.wc).join(",")}`);
    check("no 5xx from concurrent submits", r3.every((s) => s === 200), `codes ${[...new Set(r3)].join("/")}`);

    const [att] = await q("select status, score from attempts where id=?", [AT]);
    const sc = Number((att as any)?.score ?? -1);
    check("racing attempt scored within 0..100", sc >= 0 && sc <= 100, `score ${sc}, status ${(att as any)?.status}`);
  } finally {
    await cleanup();
    const [left] = await q(
      "select (select count(*) from exams where id=?) e, (select count(*) from attempts where id=?) a, (select count(*) from answers where attempt_id=?) ans",
      [EX, AT, AT],
    );
    const clean = Object.values(left as any).every((v) => Number(v) === 0);
    check("race fixture fully cleaned up", clean, JSON.stringify(left));
  }
}

console.log(`\n${failures === 0 ? "ALL INVARIANTS HOLD" : `${failures} INVARIANT FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
