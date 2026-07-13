import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export * from "./auth-schema";

const now = () => new Date();

/** Colleges / organizations. Single multi-tenant deployment. */
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(), // logo chip e.g. "GR"
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#1e3a5f"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

/** Domain profile attached to a Better Auth user. */
export const profiles = sqliteTable(
  "profiles",
  {
    userId: text("user_id").primaryKey(), // == auth user.id
    tenantId: text("tenant_id"),          // null for platform super admin
    role: text("role").notNull(),         // super_admin | tpo | student
    displayId: text("display_id").notNull(), // USR-0007
    phone: text("phone"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // TPO module permissions JSON: { dashboard, liveMonitor, reports, questionBank, exams, users, branding, settings }
    permissions: text("permissions", { mode: "json" }).$type<Record<string, boolean>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("profiles_tenant_idx").on(t.tenantId)],
);

/** Class = Branch + Batch start year + Section. */
export const classes = sqliteTable(
  "classes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    branch: text("branch").notNull(),        // CSE, ECE, MECH
    batchStartYear: integer("batch_start_year").notNull(), // 2021
    section: text("section").notNull(),      // A, B
    code: text("code").notNull(),            // CSE-A (display)
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("classes_tenant_idx").on(t.tenantId)],
);

/** Student records (Phase 2 desktop login; managed here in Phase 1). */
export const students = sqliteTable(
  "students",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    classId: text("class_id"),
    rollNo: text("roll_no").notNull(),   // STU-21CS102
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    gender: text("gender"),              // male | female
    // Phase 1 stores a login password for the Phase 2 desktop student client.
    password: text("password").notNull().default("Welcome@123"),
    // Force a password change on first login with the issued password.
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("students_tenant_idx").on(t.tenantId), index("students_class_idx").on(t.classId)],
);

/** Question bank. */
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("#1e3a5f"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("categories_tenant_idx").on(t.tenantId)],
);

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    categoryId: text("category_id"),
    type: text("type").notNull(), // mcq | multi | truefalse | fillblank | short | essay | coding
    prompt: text("prompt").notNull(),
    // options: string[] for mcq/multi/fillblank; empty for others
    options: text("options", { mode: "json" }).$type<string[]>(),
    // correct: for objective types (indices / value / boolean). null for AI-graded.
    correct: text("correct", { mode: "json" }).$type<unknown>(),
    // coding: language + starter + reference solution + testcases
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    points: integer("points").notNull().default(1),
    difficulty: text("difficulty").notNull().default("medium"), // easy | medium | hard
    topic: text("topic"),
    // Global questions are visible to (and reusable by) every college. College-specific = own tenant only.
    isGlobal: integer("is_global", { mode: "boolean" }).notNull().default(true),
    aiGenerated: integer("ai_generated", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("questions_tenant_idx").on(t.tenantId)],
);

/** Exams / assessments. */
export const exams = sqliteTable(
  "exams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    title: text("title").notNull(),
    classId: text("class_id"),
    // sectionIds: null/empty = all sections; otherwise a subset of class ids
    sectionIds: text("section_ids", { mode: "json" }).$type<string[]>(),
    // assignMode: "cohort" = target sections (sectionIds); "students" = only the
    // explicitly picked students (roster "add" list), no cohort match at all.
    assignMode: text("assign_mode").notNull().default("cohort"),
    status: text("status").notNull().default("draft"), // draft | scheduled | live | finished
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    durationMin: integer("duration_min").notNull().default(60),
    totalPoints: integer("total_points").notNull().default(0),
    // Admin global hold (outage). heldAt set = currently held; holdMs = total ms already held.
    heldAt: integer("held_at", { mode: "timestamp_ms" }),
    holdMs: integer("hold_ms").notNull().default(0),
    // Extra minutes granted by admin for the whole exam.
    extraMin: integer("extra_min").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("exams_tenant_idx").on(t.tenantId)],
);

export const examQuestions = sqliteTable(
  "exam_questions",
  {
    id: text("id").primaryKey(),
    examId: text("exam_id").notNull(),
    questionId: text("question_id").notNull(),
    order: integer("order").notNull().default(0),
    points: integer("points").notNull().default(1),
  },
  (t) => [index("exam_questions_exam_idx").on(t.examId)],
);

/**
 * Ad-hoc roster overrides for an exam. Base eligibility is cohort-based
 * (class + optional sections). These rows let an admin explicitly add a
 * student who isn't in the cohort, or remove a student who is — e.g. when
 * merging students from another batch onto spare machines.
 *   mode "add"    -> student is eligible regardless of cohort
 *   mode "remove" -> student is excluded even if the cohort matches
 * An "add" always wins over a "remove".
 */
export const examRoster = sqliteTable(
  "exam_roster",
  {
    id: text("id").primaryKey(),
    examId: text("exam_id").notNull(),
    studentId: text("student_id").notNull(),
    mode: text("mode").notNull(), // add | remove
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("exam_roster_exam_idx").on(t.examId)],
);

/** A student's attempt at an exam. */
export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    examId: text("exam_id").notNull(),
    studentId: text("student_id").notNull(),
    status: text("status").notNull().default("not_started"), // not_started | in_progress | submitted | graded
    score: real("score"),          // percentage 0-100
    integrityScore: real("integrity_score"), // 0-100 clean
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    // Total ms the exam was paused (e.g. internet loss). Added to the deadline so
    // the student is not penalised for a network drop — timer freezes while paused.
    pausedMs: integer("paused_ms").notNull().default(0),
    lastPausedAt: integer("last_paused_at", { mode: "timestamp_ms" }),
    // Last heartbeat from the student client — drives Live Monitor online/offline.
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    // Number of questions with a synced (server-received) answer. Kept current by
    // the per-answer autosave endpoint + finalizeAttempt, so reports can show
    // "answered N/total" even for attempts that never reached a normal submit.
    answeredCount: integer("answered_count").notNull().default(0),
    // True when the attempt was force-finalized by the server-side sweep because
    // the student started but never submitted (lost connection through the
    // cutoff). Lets reports show a distinct "Disconnected" status vs true Absent.
    disconnected: integer("disconnected", { mode: "boolean" }).notNull().default(false),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("attempts_exam_idx").on(t.examId), index("attempts_student_idx").on(t.studentId)],
);

export const answers = sqliteTable(
  "answers",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    questionId: text("question_id").notNull(),
    response: text("response", { mode: "json" }).$type<unknown>(),
    score: real("score"),
    maxScore: real("max_score"),
    aiNotes: text("ai_notes"),
    autoGraded: integer("auto_graded", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("answers_attempt_idx").on(t.attemptId)],
);

export const integrityEvents = sqliteTable(
  "integrity_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    type: text("type").notNull(), // gaze | phone | multi_face | no_face | tab_switch | fullscreen_exit | paste
    detail: text("detail"),
    photoUrl: text("photo_url"), // webcam snapshot captured at the moment of the event
    at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("integrity_attempt_idx").on(t.attemptId)],
);

/** Platform-global settings: API keys + usage limits (single row, id = "global"). */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey().default("global"),
  judge0Key: text("judge0_key"),
  aiProvider: text("ai_provider").notNull().default("anthropic"), // anthropic | google | openai
  claudeKey: text("claude_key"),
  geminiKey: text("gemini_key"),
  openaiKey: text("openai_key"),
  judge0Limit: integer("judge0_limit").notNull().default(1000),
  judge0Used: integer("judge0_used").notNull().default(0),
  aiLimit: integer("ai_limit").notNull().default(1000),
  aiUsed: integer("ai_used").notNull().default(0),
  // Global proctoring rules enforced by the desktop student client. See ProctorConfig.
  proctoring: text("proctoring", { mode: "json" }).$type<ProctorConfig>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

/** Global proctoring configuration enforced by the desktop student client. */
export type ProctorConfig = {
  requireWebcam: boolean;          // block exam start until webcam is active
  requireInternet: boolean;        // block exam start until internet is present (after download)
  blockOnCameraLoss: boolean;      // lock the exam if the camera is closed/disabled mid-exam
  cameraLossLockSeconds: number;   // how long to lock after camera loss
  fullscreenRequired: boolean;     // enforce fullscreen lockdown
  blockCopyPaste: boolean;         // disable copy/paste/cut + right-click
  flagTabSwitch: boolean;          // record tab/window switches
  maxTabSwitches: number;          // auto-submit after this many switches (0 = never)
  webcamSnapshots: boolean;        // periodically capture webcam snapshots
  snapshotIntervalSec: number;     // snapshot cadence
  requireSingleScreen: boolean;    // block exam if more than one display is connected
  blockScreenshots: boolean;       // trap PrintScreen / Win+Shift+S screenshot shortcuts
  autoSubmitOnTimeout: boolean;    // force-submit the moment the exam timer reaches 0
};

export const DEFAULT_PROCTORING: ProctorConfig = {
  requireWebcam: true,
  requireInternet: true,
  blockOnCameraLoss: true,
  cameraLossLockSeconds: 120,
  fullscreenRequired: true,
  blockCopyPaste: true,
  flagTabSwitch: true,
  maxTabSwitches: 0,
  webcamSnapshots: false,
  snapshotIntervalSec: 30,
  requireSingleScreen: true,
  blockScreenshots: true,
  autoSubmitOnTimeout: true,
};
