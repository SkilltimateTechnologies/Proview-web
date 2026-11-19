/**
 * Wires the backup scheduler (lib/backups.ts) to the real database and bucket.
 * Kept apart from backups.ts so the scheduling rules stay pure and testable.
 */
import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { BACKUP_PREFIX, BackupScheduler, dumpUrlFor, type BackupDeps } from "./backups";
import { BUCKET, s3 } from "./s3";

function build(): BackupScheduler {
  if ((process.env.BACKUPS ?? "on").toLowerCase() === "off") return new BackupScheduler(null, "BACKUPS=off");
  const dumpUrl = dumpUrlFor(process.env.DATABASE_URL);
  if (!dumpUrl) return new BackupScheduler(null, "database has no remote /dump endpoint (local file)");
  if (!process.env.S3_BUCKET || !process.env.S3_ENDPOINT) return new BackupScheduler(null, "storage bucket not configured");

  let backedUpCache: { at: number; ids: Set<string> } | null = null;
  const deps: BackupDeps = {
    listExams: async () =>
      db
        .select({
          id: schema.exams.id,
          status: schema.exams.status,
          startAt: schema.exams.startAt,
          endAt: schema.exams.endAt,
          extraMin: schema.exams.extraMin,
          holdMs: schema.exams.holdMs,
          heldAt: schema.exams.heldAt,
        })
        .from(schema.exams)
        .where(inArray(schema.exams.status, ["scheduled", "live", "finished"])),
    listBackedUp: async () => {
      // The bucket listing IS the state (no schema change). Cached 10 minutes, and
      // refreshed after every upload by the scheduler's next tick.
      if (backedUpCache && Date.now() - backedUpCache.at < 10 * 60_000) return backedUpCache.ids;
      const ids = new Set<string>();
      let token: string | undefined;
      do {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: BACKUP_PREFIX, ContinuationToken: token }));
        for (const o of out.Contents ?? []) {
          const examId = (o.Key ?? "").slice(BACKUP_PREFIX.length).split("/")[0];
          if (examId) ids.add(examId);
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      backedUpCache = { at: Date.now(), ids };
      return ids;
    },
    fetchDump: async () => {
      const res = await fetch(dumpUrl, {
        headers: process.env.DATABASE_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.DATABASE_AUTH_TOKEN}` } : {},
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok) throw new Error(`dump endpoint answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    upload: async (key, gz) => {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: gz, ContentType: "application/gzip" }));
      backedUpCache = null;
    },
    gzip: (raw) => Bun.gzipSync(raw as Uint8Array<ArrayBuffer>),
  };
  return new BackupScheduler(deps);
}

export const backups = build();
