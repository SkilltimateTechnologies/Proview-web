/**
 * Exam-anchored backups. What must hold: a dump never runs while an exam is live,
 * each exam is backed up once, only after its window + 12h, failures never throw,
 * and a local database simply reports "disabled".
 */
import { describe, expect, it } from "bun:test";
import { BACKUP_DELAY_MS, BackupScheduler, LOOKBACK_MS, anyExamLive, dueExams, dumpUrlFor, type BackupDeps, type BackupExam } from "./backups";

const H = 60 * 60_000;
const now = Date.UTC(2026, 10, 20, 12, 0, 0);
const exam = (id: string, endAgoMs: number, extra: Partial<BackupExam> = {}): BackupExam => ({
  id, status: "scheduled", startAt: now - endAgoMs - 90 * 60_000, endAt: now - endAgoMs, ...extra,
});

function deps(exams: BackupExam[], backedUp: string[] = [], over: Partial<BackupDeps> = {}) {
  const uploads: string[] = [];
  const d: BackupDeps = {
    listExams: async () => exams,
    listBackedUp: async () => new Set(backedUp),
    fetchDump: async () => new TextEncoder().encode("CREATE TABLE x(a);\n".repeat(20)),
    upload: async (key) => { uploads.push(key); },
    gzip: (b) => Bun.gzipSync(b as Uint8Array<ArrayBuffer>),
    now: () => now,
    log: () => {},
    ...over,
  };
  return { d, uploads };
}

describe("which exams are due", () => {
  it("only after the window closes plus 12 hours, oldest first, not twice", () => {
    const list = [exam("recent", 11 * H), exam("old", 30 * H), exam("older", 40 * H), exam("done", 50 * H)];
    expect(dueExams(list, new Set(["done"]), now).map((e) => e.id)).toEqual(["older", "old"]);
  });
  it("counts extra time and holds in the window", () => {
    expect(dueExams([exam("x", BACKUP_DELAY_MS - 30 * 60_000, { extraMin: 0 })], new Set(), now)).toHaveLength(0);
    expect(dueExams([exam("x", BACKUP_DELAY_MS + 30 * 60_000, { extraMin: 60 })], new Set(), now)).toHaveLength(0);
    expect(dueExams([exam("x", 20 * H, { heldAt: now - H })], new Set(), now)).toHaveLength(0);
  });
  it("ignores exams beyond the lookback so a first deploy does not dump per old exam", () => {
    expect(dueExams([exam("ancient", LOOKBACK_MS + H)], new Set(), now)).toHaveLength(0);
  });
});

describe("live detection", () => {
  it("a started, unclosed exam is live; a closed one is not", () => {
    expect(anyExamLive([exam("a", -30 * 60_000)], now)).toBe(true);
    expect(anyExamLive([exam("b", 5 * H)], now)).toBe(false);
  });
});

describe("dump URL", () => {
  it("maps Turso URLs to their /dump endpoint and refuses local files", () => {
    expect(dumpUrlFor("libsql://proview-x.turso.io")).toBe("https://proview-x.turso.io/dump");
    expect(dumpUrlFor("https://proview-x.turso.io?tls=1")).toBe("https://proview-x.turso.io/dump");
    expect(dumpUrlFor("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/dump");
    expect(dumpUrlFor("file:/tmp/x.db")).toBeNull();
    expect(dumpUrlFor(undefined)).toBeNull();
  });
});

describe("BackupScheduler", () => {
  it("backs up one due exam per tick into backups/<examId>/", async () => {
    const { d, uploads } = deps([exam("e1", 20 * H), exam("e2", 30 * H)]);
    const s = new BackupScheduler(d);
    expect(await s.tick()).toBe("ok");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/^backups\/e2\/.+\.sql\.gz$/);
    expect(s.status().lastExamId).toBe("e2");
    expect(s.status().lastBytes).toBeGreaterThan(0);
  });
  it("never dumps while an exam is live", async () => {
    const { d, uploads } = deps([exam("due", 20 * H), exam("running", -10 * 60_000)]);
    const s = new BackupScheduler(d);
    expect(await s.tick()).toBe("live");
    expect(uploads).toHaveLength(0);
  });
  it("does nothing when everything is backed up", async () => {
    const { d, uploads } = deps([exam("e1", 20 * H)], ["e1"]);
    expect(await new BackupScheduler(d).tick()).toBe("nothing-due");
    expect(uploads).toHaveLength(0);
  });
  it("a failed dump or upload is recorded, never thrown", async () => {
    const { d } = deps([exam("e1", 20 * H)], [], { fetchDump: async () => { throw new Error("dump endpoint answered 503"); } });
    const s = new BackupScheduler(d);
    expect(await s.tick()).toBe("error");
    expect(s.status().lastError).toContain("503");
    const { d: d2 } = deps([exam("e1", 20 * H)], [], { fetchDump: async () => new Uint8Array(5) });
    expect(await new BackupScheduler(d2).tick()).toBe("error");
  });
  it("disabled (local database or BACKUPS=off) reports why and does nothing", async () => {
    const s = new BackupScheduler(null, "local file");
    expect(await s.tick()).toBe("disabled");
    expect(s.status()).toMatchObject({ enabled: false, lastSkip: "local file" });
  });
});
