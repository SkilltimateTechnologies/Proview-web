/**
 * Seed real demo data. Run: cd packages/web && bun run seed
 *
 * Keeps the admin/TPO logins, wipes ALL student-facing data (students, questions,
 * exams, attempts, answers, integrity events) and rebuilds a realistic dataset:
 *   - exactly 2 students (each with finished-exam reports)
 *   - a real question bank (28 questions, mixed types)
 *   - one LIVE exam (mixed 15 questions, linked) the desktop client can take
 *   - one SCHEDULED exam (future)
 *   - two FINISHED exams with graded attempts for the 2 students
 */
import { eq, inArray } from "drizzle-orm";
import { auth } from "./auth";
import { hashPassword } from "better-auth/crypto";
import { db } from "./database";
import * as schema from "./database/schema";
import { id, displayId } from "./lib/util";

async function ensureUser(email: string, password: string, name: string): Promise<string> {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (existing) return existing.id;
  const res = await auth.api.signUpEmail({ body: { email, password, name } });
  const uid = (res as { user?: { id: string } }).user?.id;
  if (!uid) throw new Error(`failed to create ${email}`);
  return uid;
}

async function main() {
  console.log("Seeding real dataset…");

  // ---- Tenant ----
  const slug = "grce";
  let [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!tenant) {
    [tenant] = await db
      .insert(schema.tenants)
      .values({ id: id("ten"), name: "GR College of Engineering", shortName: "GR", slug, primaryColor: "#1e3a5f" })
      .returning();
  }
  const tid = tenant.id;
  await db.insert(schema.settings).values({ id: "global", judge0Used: 0, judge0Limit: 1000, aiUsed: 0, aiLimit: 1000 }).onConflictDoUpdate({
    target: schema.settings.id,
    set: { judge0Used: 0, judge0Limit: 1000, aiUsed: 0, aiLimit: 1000 },
  });

  // ---- Users (kept: super admin, college admin, tenant admin, 2 TPOs) ----
  let n = (await db.select().from(schema.profiles)).length;
  const upsertProfile = async (uid: string, role: string, perms: Record<string, boolean> | null, tenantId: string | null, phone?: string) => {
    const [ex] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid));
    if (ex) return;
    n += 1;
    await db.insert(schema.profiles).values({ userId: uid, tenantId, role, displayId: displayId("USR", n), permissions: perms, phone: phone ?? null });
  };

  const superId = await ensureUser("admin@skilltimate.com", "Admin@123", "Skilltimate Admin");
  await upsertProfile(superId, "super_admin", null, null);

  const adminId = await ensureUser("meera@grce.edu", "Admin@123", "Dr. Meera Krishnan");
  await upsertProfile(adminId, "tpo", { dashboard: true, liveMonitor: true, reports: true, questionBank: true, exams: true, users: true, branding: true }, tid, "+91 90000 11111");

  const collegeAdminId = await ensureUser("principal@grce.edu", "Admin@123", "Prof. Ravi Shankar");
  await upsertProfile(collegeAdminId, "college_admin", null, tid, "+91 90000 44444");

  const tpo1 = await ensureUser("suresh@grce.edu", "Tpo@1234", "Suresh Babu");
  await upsertProfile(tpo1, "tpo", { dashboard: true, liveMonitor: true, reports: true }, tid, "+91 90000 22222");

  const tpo2 = await ensureUser("lakshmi@grce.edu", "Tpo@1234", "Lakshmi Devi");
  await upsertProfile(tpo2, "tpo", { dashboard: true, liveMonitor: true, reports: true, questionBank: true }, tid, "+91 90000 33333");

  // ---- WIPE all student-facing data for this tenant ----
  const oldExams = await db.select().from(schema.exams).where(eq(schema.exams.tenantId, tid));
  const oldExamIds = oldExams.map((e) => e.id);
  const oldAttempts = oldExamIds.length ? await db.select().from(schema.attempts).where(inArray(schema.attempts.examId, oldExamIds)) : [];
  const oldAttemptIds = oldAttempts.map((a) => a.id);
  if (oldAttemptIds.length) {
    await db.delete(schema.answers).where(inArray(schema.answers.attemptId, oldAttemptIds));
    await db.delete(schema.integrityEvents).where(inArray(schema.integrityEvents.attemptId, oldAttemptIds));
  }
  if (oldExamIds.length) {
    await db.delete(schema.attempts).where(inArray(schema.attempts.examId, oldExamIds));
    await db.delete(schema.examQuestions).where(inArray(schema.examQuestions.examId, oldExamIds));
  }
  await db.delete(schema.exams).where(eq(schema.exams.tenantId, tid));
  await db.delete(schema.questions).where(eq(schema.questions.tenantId, tid));
  await db.delete(schema.students).where(eq(schema.students.tenantId, tid));
  console.log(`Wiped: ${oldExams.length} exams, ${oldAttempts.length} attempts, questions + students.`);

  // ---- Classes (kept / ensured) ----
  const classDefs = [
    { branch: "CSE", section: "A", batchStartYear: 2021 },
    { branch: "CSE", section: "B", batchStartYear: 2021 },
    { branch: "ECE", section: "A", batchStartYear: 2022 },
    { branch: "MECH", section: "A", batchStartYear: 2022 },
  ];
  const existingClasses = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
  const classIds: Record<string, string> = {};
  for (const cd of classDefs) {
    const code = `${cd.branch}-${cd.section}`;
    let cl = existingClasses.find((x) => x.code === code);
    if (!cl) {
      [cl] = await db.insert(schema.classes).values({ id: id("cls"), tenantId: tid, ...cd, code }).returning();
    }
    classIds[code] = cl.id;
  }

  // ---- Categories (kept / ensured) ----
  const existingCats = await db.select().from(schema.categories).where(eq(schema.categories.tenantId, tid));
  const catIds: Record<string, string> = {};
  const CAT_NAMES = ["Data Structures & Algorithms", "Databases", "Computer Networks", "Operating Systems", "OOP Concepts", "Aptitude & Reasoning"];
  for (const name of CAT_NAMES) {
    const found = existingCats.find((c) => c.name === name);
    if (found) { catIds[name] = found.id; continue; }
    const [row] = await db.insert(schema.categories).values({ id: id("cat"), tenantId: tid, name }).returning();
    catIds[name] = row.id;
  }

  // ---- 2 Students ----
  const seededHash = await hashPassword("Welcome@123");
  const studentDefs = [
    { name: "Priya Nair", rollNo: "STU-21CS102", email: "priya.nair@grce.edu", code: "CSE-A" },
    { name: "Rohan Verma", rollNo: "STU-21CS044", email: "rohan.verma@grce.edu", code: "CSE-A" },
  ];
  const studentIds: Record<string, string> = {};
  for (const sd of studentDefs) {
    const [s] = await db.insert(schema.students).values({
      id: id("stu"), tenantId: tid, classId: classIds[sd.code], rollNo: sd.rollNo, name: sd.name, email: sd.email, password: seededHash,
    }).returning();
    studentIds[sd.rollNo] = s.id;
  }

  // ---- Question bank (28, mixed types) ----
  const C = catIds;
  type QDef = { type: string; prompt: string; options?: string[]; correct?: unknown; meta?: Record<string, unknown>; points: number; difficulty: string; topic: string; cat: string };
  const bank: QDef[] = [
    // DSA
    { type: "mcq", prompt: "What is the time complexity of binary search on a sorted array of n elements?", options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"], correct: 1, points: 2, difficulty: "easy", topic: "Searching", cat: "Data Structures & Algorithms" },
    { type: "mcq", prompt: "Which data structure uses FIFO (First-In-First-Out) ordering?", options: ["Stack", "Queue", "Tree", "Graph"], correct: 1, points: 1, difficulty: "easy", topic: "Data Structures", cat: "Data Structures & Algorithms" },
    { type: "mcq", prompt: "The worst-case time complexity of QuickSort is:", options: ["O(n)", "O(n log n)", "O(n²)", "O(log n)"], correct: 2, points: 2, difficulty: "medium", topic: "Sorting", cat: "Data Structures & Algorithms" },
    { type: "multi", prompt: "Which of the following are stable sorting algorithms?", options: ["Merge Sort", "Quick Sort", "Insertion Sort", "Heap Sort"], correct: [0, 2], points: 3, difficulty: "medium", topic: "Sorting", cat: "Data Structures & Algorithms" },
    { type: "truefalse", prompt: "A hash table provides O(1) average-case lookup time.", correct: true, points: 1, difficulty: "easy", topic: "Hashing", cat: "Data Structures & Algorithms" },
    { type: "fillblank", prompt: "A ____ traversal of a binary search tree visits nodes in sorted order.", options: ["Pre-order", "In-order", "Post-order", "Level-order"], correct: 1, points: 2, difficulty: "medium", topic: "Trees", cat: "Data Structures & Algorithms" },
    { type: "coding", prompt: "Write a function `fib(n)` that returns the nth Fibonacci number (0-indexed, fib(0)=0, fib(1)=1).", meta: { language: "python", starter: "def fib(n):\n    # your code here\n    pass", solution: "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a", tests: [{ input: "5", expected: "5" }, { input: "10", expected: "55" }] }, points: 10, difficulty: "medium", topic: "Dynamic Programming", cat: "Data Structures & Algorithms" },
    { type: "coding", prompt: "Write a function `reverse_string(s)` that returns the reversed string without using slicing.", meta: { language: "python", starter: "def reverse_string(s):\n    # your code here\n    pass", solution: "def reverse_string(s):\n    out = ''\n    for ch in s:\n        out = ch + out\n    return out", tests: [{ input: "abc", expected: "cba" }] }, points: 5, difficulty: "easy", topic: "Strings", cat: "Data Structures & Algorithms" },
    // Databases
    { type: "mcq", prompt: "Which SQL clause is used to filter rows returned by a query?", options: ["ORDER BY", "GROUP BY", "WHERE", "HAVING"], correct: 2, points: 1, difficulty: "easy", topic: "SQL", cat: "Databases" },
    { type: "multi", prompt: "Which of the following are NoSQL databases?", options: ["MongoDB", "PostgreSQL", "Redis", "Cassandra"], correct: [0, 2, 3], points: 3, difficulty: "medium", topic: "NoSQL", cat: "Databases" },
    { type: "truefalse", prompt: "A primary key column can contain NULL values.", correct: false, points: 1, difficulty: "easy", topic: "Keys", cat: "Databases" },
    { type: "mcq", prompt: "Which normal form eliminates transitive dependencies?", options: ["1NF", "2NF", "3NF", "BCNF"], correct: 2, points: 2, difficulty: "medium", topic: "Normalization", cat: "Databases" },
    { type: "short", prompt: "Explain the difference between the DELETE and TRUNCATE commands in SQL.", meta: { rubric: "DELETE removes rows one by one (can use WHERE, logged, rollback-able, fires triggers). TRUNCATE removes all rows at once (no WHERE, minimal logging, faster, resets identity, cannot rollback in most DBs)." }, points: 5, difficulty: "medium", topic: "SQL", cat: "Databases" },
    // Networks
    { type: "truefalse", prompt: "TCP is a connectionless protocol.", correct: false, points: 1, difficulty: "easy", topic: "Transport Layer", cat: "Computer Networks" },
    { type: "mcq", prompt: "Which layer of the OSI model is responsible for routing packets across networks?", options: ["Data Link", "Network", "Transport", "Session"], correct: 1, points: 2, difficulty: "medium", topic: "OSI Model", cat: "Computer Networks" },
    { type: "mcq", prompt: "What is the default port number for HTTPS?", options: ["21", "80", "443", "8080"], correct: 2, points: 1, difficulty: "easy", topic: "Protocols", cat: "Computer Networks" },
    { type: "multi", prompt: "Which of the following protocols operate at the application layer?", options: ["HTTP", "TCP", "DNS", "IP"], correct: [0, 2], points: 3, difficulty: "medium", topic: "Protocols", cat: "Computer Networks" },
    { type: "short", prompt: "Describe the three-way handshake used to establish a TCP connection.", meta: { rubric: "Client sends SYN → server replies SYN-ACK → client sends ACK. Mention sequence numbers and connection establishment." }, points: 5, difficulty: "medium", topic: "Transport Layer", cat: "Computer Networks" },
    // Operating Systems
    { type: "mcq", prompt: "Which scheduling algorithm can cause starvation of low-priority processes?", options: ["Round Robin", "FCFS", "Priority Scheduling", "SJF (non-preemptive)"], correct: 2, points: 2, difficulty: "medium", topic: "Scheduling", cat: "Operating Systems" },
    { type: "truefalse", prompt: "A deadlock requires the 'circular wait' condition to hold.", correct: true, points: 1, difficulty: "medium", topic: "Deadlock", cat: "Operating Systems" },
    { type: "mcq", prompt: "In paging, the memory is divided into fixed-size blocks called:", options: ["Segments", "Frames", "Pages", "Sectors"], correct: 1, points: 2, difficulty: "medium", topic: "Memory", cat: "Operating Systems" },
    { type: "short", prompt: "Explain the difference between a process and a thread.", meta: { rubric: "Process = independent memory space, heavier, isolated. Thread = lightweight unit within a process, shares memory/resources. Mention scheduling, isolation, context-switch cost." }, points: 5, difficulty: "medium", topic: "Concurrency", cat: "Operating Systems" },
    // OOP
    { type: "fillblank", prompt: "In OOP, ____ allows a subclass to provide a specific implementation of a method already defined in its superclass.", options: ["Encapsulation", "Overriding", "Overloading", "Abstraction"], correct: 1, points: 2, difficulty: "medium", topic: "Polymorphism", cat: "OOP Concepts" },
    { type: "mcq", prompt: "Which OOP principle is achieved by hiding internal state and requiring all interaction through methods?", options: ["Inheritance", "Polymorphism", "Encapsulation", "Abstraction"], correct: 2, points: 2, difficulty: "easy", topic: "Encapsulation", cat: "OOP Concepts" },
    { type: "truefalse", prompt: "A class in Java can inherit from multiple classes directly.", correct: false, points: 1, difficulty: "medium", topic: "Inheritance", cat: "OOP Concepts" },
    // Aptitude
    { type: "mcq", prompt: "If a train travels 360 km in 4 hours, what is its average speed?", options: ["80 km/h", "90 km/h", "100 km/h", "120 km/h"], correct: 1, points: 1, difficulty: "easy", topic: "Speed & Distance", cat: "Aptitude & Reasoning" },
    { type: "mcq", prompt: "Find the next number in the series: 2, 6, 12, 20, 30, ?", options: ["36", "40", "42", "48"], correct: 2, points: 2, difficulty: "medium", topic: "Number Series", cat: "Aptitude & Reasoning" },
    { type: "mcq", prompt: "A shopkeeper marks an item 40% above cost and gives a 10% discount. His profit percentage is:", options: ["24%", "26%", "30%", "36%"], correct: 1, points: 2, difficulty: "hard", topic: "Profit & Loss", cat: "Aptitude & Reasoning" },
  ];

  const qRows = bank.map((q) => ({
    id: id("q"), tenantId: tid, categoryId: C[q.cat], type: q.type, prompt: q.prompt,
    options: q.options ?? null, correct: q.correct ?? null, meta: q.meta ?? null,
    points: q.points, difficulty: q.difficulty, topic: q.topic, createdBy: adminId,
  }));
  await db.insert(schema.questions).values(qRows);
  console.log(`Inserted ${qRows.length} questions.`);

  const linkQuestions = async (examId: string, qids: string[]) => {
    let order = 0, total = 0;
    for (const qid of qids) {
      const q = qRows.find((r) => r.id === qid)!;
      await db.insert(schema.examQuestions).values({ id: id("eq"), examId, questionId: qid, order: order++, points: q.points });
      total += q.points;
    }
    await db.update(schema.exams).set({ totalPoints: total }).where(eq(schema.exams.id, examId));
    return total;
  };

  // Helper: pick question ids by index
  const q = (i: number) => qRows[i].id;

  // ---- LIVE exam: "Placement Aptitude & CS Fundamentals" (15 mixed Qs) ----
  const liveId = id("ex");
  await db.insert(schema.exams).values({
    id: liveId, tenantId: tid, title: "Placement Aptitude & CS Fundamentals", status: "live",
    durationMin: 60, totalPoints: 0, createdBy: adminId, classId: classIds["CSE-A"],
    startAt: new Date(Date.now() - 10 * 60000), endAt: new Date(Date.now() + 3 * 3600000),
  });
  // A mix: mcq, multi, truefalse, fillblank, short, coding — across topics
  const liveQs = [0, 1, 8, 9, 13, 14, 18, 22, 25, 26, 12, 21, 6, 7, 27].map(q);
  const liveTotal = await linkQuestions(liveId, liveQs);
  console.log(`LIVE exam "${"Placement Aptitude & CS Fundamentals"}" linked ${liveQs.length} Qs, ${liveTotal} pts.`);

  // ---- SCHEDULED exam (future): "Data Structures Unit Test" ----
  const schedId = id("ex");
  await db.insert(schema.exams).values({
    id: schedId, tenantId: tid, title: "Data Structures Unit Test", status: "scheduled",
    durationMin: 45, totalPoints: 0, createdBy: adminId, classId: classIds["CSE-A"],
    startAt: new Date(Date.now() + 26 * 3600000),
  });
  const schedQs = [0, 1, 2, 3, 4, 5, 6, 7].map(q);
  await linkQuestions(schedId, schedQs);

  // ---- FINISHED exams with graded reports for the 2 students ----
  const finishedDefs = [
    { title: "Weekly Quiz 1 — DBMS", qIdx: [8, 9, 10, 11, 12], dur: 30, daysAgo: 14 },
    { title: "Mid-Sem — Operating Systems", qIdx: [18, 19, 20, 21], dur: 60, daysAgo: 6 },
  ];
  const scoreByStudent: Record<string, number[]> = {
    "STU-21CS102": [92, 88],
    "STU-21CS044": [74, 81],
  };
  const integrityByStudent: Record<string, number[]> = {
    "STU-21CS102": [100, 96],
    "STU-21CS044": [90, 85],
  };
  let fi = 0;
  for (const fd of finishedDefs) {
    const eid = id("ex");
    await db.insert(schema.exams).values({
      id: eid, tenantId: tid, title: fd.title, status: "finished",
      durationMin: fd.dur, totalPoints: 0, createdBy: adminId, classId: classIds["CSE-A"],
      startAt: new Date(Date.now() - fd.daysAgo * 24 * 3600000),
      endAt: new Date(Date.now() - fd.daysAgo * 24 * 3600000 + fd.dur * 60000),
    });
    await linkQuestions(eid, fd.qIdx.map(q));
    for (const sd of studentDefs) {
      const sidv = studentIds[sd.rollNo];
      const submittedAt = new Date(Date.now() - fd.daysAgo * 24 * 3600000 + fd.dur * 60000);
      await db.insert(schema.attempts).values({
        id: id("att"), examId: eid, studentId: sidv, status: "graded",
        score: scoreByStudent[sd.rollNo][fi], integrityScore: integrityByStudent[sd.rollNo][fi],
        startedAt: new Date(Date.now() - fd.daysAgo * 24 * 3600000), submittedAt,
      });
    }
    fi += 1;
  }
  console.log(`Created ${finishedDefs.length} finished exams with graded reports for 2 students.`);

  console.log("\nSeed complete.");
  console.log("Super admin:      admin@skilltimate.com / Admin@123");
  console.log("College admin:    principal@grce.edu / Admin@123");
  console.log("Tenant admin:     meera@grce.edu / Admin@123");
  console.log("TPO (read-only):  suresh@grce.edu / Tpo@1234");
  console.log("TPO (+bank):      lakshmi@grce.edu / Tpo@1234");
  console.log("Student 1:        STU-21CS102 (Priya Nair) / Welcome@123");
  console.log("Student 2:        STU-21CS044 (Rohan Verma) / Welcome@123");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
