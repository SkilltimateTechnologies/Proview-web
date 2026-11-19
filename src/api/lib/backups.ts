/**
 * Exam-anchored database backups, as designed in memory.md §7.
 *
 * WHY: Turso's point-in-time restore was the only copy of the data. It protects
 * against Turso losing data, not against the realistic disaster: an admin action
 * that deletes a conducted exam's attempts, answers and evidence, which a synced
 * copy would replicate within seconds. A backup has to be frozen in time and
 * stored where the same mistake cannot reach it.
 *
 * WHAT: 12 hours after an exam closes (results released, grading settled), take a
 * full SQL dump of the database (Turso's `/dump` endpoint), gzip it and put it in
 * the existing storage bucket at `backups/<examId>/<timestamp>.sql.gz`. Kept
 * forever; ~7 MB each.
 *
 * RULES (all from the design):
 *  - Never while any exam is live: a dump reads every row and must never land on
 *    exam-day load. Deferred to the next tick instead.
 *  - One dump per tick, oldest due exam first, only exams that closed in the last
 *    `LOOKBACK_MS` (so the first deploy does not dump once per historical exam).
 *  - No schema change: "has this exam been backed up?" is a bucket listing.
 *  - Fail soft: a local `file:` database has no /dump endpoint and S3 errors are
 *    logged — nothing here ever throws into the server.
 *  - Runs only where background work runs (ROLE-gated in server.ts), so two web
 *    replicas never both dump.
 *  - Status is advisory on /api/health; it can never turn health red.
 *  - Kill switch: BACKUPS=off.
 */
import { closesAtMs, examEffStatus, type StatusExam } from "./exam-status";

export const BACKUP_DELAY_MS = 12 * 60 * 60_000;
export const LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const STALE_AFTER_MS = 48 * 60 * 60_000;
export const BACKUP_PREFIX = "backups/";

export type BackupExam = StatusExam & { id: string };

/** Exams whose backup is due, oldest first. Pure, for tests. */
export function dueExams(exams: BackupExam[], backedUp: ReadonlySet<string>, now: number): BackupExam[] {
  return exams
    .map((e) => ({ e, closes: closesAtMs(e) }))
    .filter(({ e, closes }) => closes !== null && !e.heldAt && now >= closes + BACKUP_DELAY_MS && now - closes <= LOOKBACK_MS && !backedUp.has(e.id))
    .sort((a, b) => (a.closes as number) - (b.closes as number))
    .map(({ e }) => e);
}

/** True while any exam is running. Pure, for tests. */
export function anyExamLive(exams: StatusExam[], now: number): boolean {
  return exams.some((e) => examEffStatus(e, now) === "live");
}

/** Turso's dump endpoint for a libsql/https database URL, or null for a local file. */
export function dumpUrlFor(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  const m = databaseUrl.match(/^(?:libsql|https|wss|http|ws):\/\/([^/?#]+)/i);
  if (!m) return null;
  const scheme = /^(http|ws):/i.test(databaseUrl) ? "http" : "https";
  return `${scheme}://${m[1]}/dump`;
}

export type BackupDeps = {
  listExams: () => Promise<BackupExam[]>;
  /** examIds that already have at least one object under backups/<examId>/. */
  listBackedUp: () => Promise<Set<string>>;
  fetchDump: () => Promise<Uint8Array>;
  upload: (key: string, gz: Uint8Array) => Promise<void>;
  gzip: (raw: Uint8Array) => Uint8Array;
  now?: () => number;
  log?: (msg: string) => void;
};

export type BackupStatus = {
  enabled: boolean;
  lastOkAt: string | null;
  lastExamId: string | null;
  lastBytes: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSkip: string | null;
  backupsThisProcess: number;
  /** Advisory only: the newest backup is older than 48h while backups are due. */
  stale: boolean;
};

export class BackupScheduler {
  private state: BackupStatus = {
    enabled: true, lastOkAt: null, lastExamId: null, lastBytes: null, lastError: null,
    lastErrorAt: null, lastSkip: null, backupsThisProcess: 0, stale: false,
  };
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BackupDeps | null, reasonDisabled?: string) {
    if (!deps) {
      this.state.enabled = false;
      this.state.lastSkip = reasonDisabled ?? "disabled";
    }
  }

  status(): BackupStatus {
    return { ...this.state };
  }

  /** One pass. Returns what it did, for tests and logs. Never throws. */
  async tick(): Promise<"disabled" | "busy" | "live" | "nothing-due" | "ok" | "error"> {
    const d = this.deps;
    if (!d) return "disabled";
    if (this.running) return "busy";
    this.running = true;
    const now = (d.now ?? Date.now)();
    const log = d.log ?? ((m: string) => console.log(m));
    try {
      const exams = await d.listExams();
      if (anyExamLive(exams, now)) {
        this.state.lastSkip = `exam live at ${new Date(now).toISOString()}`;
        return "live";
      }
      const due = dueExams(exams, await d.listBackedUp(), now);
      this.state.stale = due.some((e) => now - ((closesAtMs(e) ?? now) + BACKUP_DELAY_MS) > STALE_AFTER_MS);
      if (!due.length) return "nothing-due";
      const exam = due[0];
      const raw = await d.fetchDump();
      if (raw.byteLength < 100) throw new Error(`dump was only ${raw.byteLength} bytes`);
      const gz = d.gzip(raw);
      const key = `${BACKUP_PREFIX}${exam.id}/${new Date(now).toISOString().replace(/[:.]/g, "-")}.sql.gz`;
      await d.upload(key, gz);
      this.state = { ...this.state, lastOkAt: new Date(now).toISOString(), lastExamId: exam.id, lastBytes: gz.byteLength, backupsThisProcess: this.state.backupsThisProcess + 1, stale: due.length > 1 && this.state.stale };
      log(`[backup] exam ${exam.id}: ${raw.byteLength} bytes dumped, ${gz.byteLength} gzipped -> ${key}`);
      return "ok";
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.state.lastErrorAt = new Date(now).toISOString();
      console.error("[backup] failed (will retry next tick):", this.state.lastError);
      return "error";
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 30 * 60_000, firstDelayMs = 5 * 60_000): void {
    if (!this.deps || this.timer) return;
    const first = setTimeout(() => void this.tick(), firstDelayMs);
    (first as unknown as { unref?: () => void }).unref?.();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
