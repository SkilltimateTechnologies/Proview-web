/**
 * Copy every object from the current storage bucket to a new one, verifying
 * each copy byte-for-byte (MD5) before it counts as migrated.
 *
 * Both buckets are S3-compatible, so this works Tigris -> Tigris, Tigris -> R2,
 * or anything else with an S3 endpoint. It is a COPY, never a move: nothing is
 * deleted from the source, so it is safe to run while production is still
 * serving from the source bucket, and safe to re-run.
 *
 * Re-running skips objects already present at the destination with an identical
 * size and MD5, so the normal flow is: run it early to pre-stage the bulk, then
 * run it again at cutover to sweep up anything written in between.
 *
 * Source      : S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY   (.env)
 * Destination : NEW_S3_ENDPOINT / NEW_S3_BUCKET / NEW_S3_ACCESS_KEY_ID / NEW_S3_SECRET_ACCESS_KEY
 *               (NEW_S3_ENDPOINT defaults to the source endpoint.)
 *
 * Usage:
 *   set -a; source .env; source .tigris-new.env; set +a
 *   bun scripts/migrate-storage.ts --dry-run    # list what would copy
 *   bun scripts/migrate-storage.ts              # copy + verify
 *   bun scripts/migrate-storage.ts --verify-only # re-check an existing copy
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

const DRY = process.argv.includes("--dry-run");
const VERIFY_ONLY = process.argv.includes("--verify-only");

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var ${name}`); process.exit(1); }
  return v;
}

const SRC_BUCKET = required("S3_BUCKET");
const DST_BUCKET = required("NEW_S3_BUCKET");
const SRC_ENDPOINT = required("S3_ENDPOINT");
const DST_ENDPOINT = process.env.NEW_S3_ENDPOINT || SRC_ENDPOINT;

if (SRC_BUCKET === DST_BUCKET && SRC_ENDPOINT === DST_ENDPOINT) {
  console.error("Source and destination are the same bucket. Nothing to do.");
  process.exit(1);
}

const src = new S3Client({
  region: "auto", endpoint: SRC_ENDPOINT,
  credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
});
const dst = new S3Client({
  region: "auto", endpoint: DST_ENDPOINT,
  credentials: { accessKeyId: required("NEW_S3_ACCESS_KEY_ID"), secretAccessKey: required("NEW_S3_SECRET_ACCESS_KEY") },
});

const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

async function listAll(client: S3Client, bucket: string) {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function main() {
  console.log(`source      ${SRC_ENDPOINT} :: ${SRC_BUCKET}`);
  console.log(`destination ${DST_ENDPOINT} :: ${DST_BUCKET}`);
  console.log(DRY ? "mode        dry run (nothing will be written)\n" : VERIFY_ONLY ? "mode        verify only\n" : "mode        copy + verify\n");

  const objects = await listAll(src, SRC_BUCKET);
  const totalBytes = objects.reduce((n, o) => n + o.size, 0);
  console.log(`${objects.length} objects, ${(totalBytes / 1048576).toFixed(2)} MiB\n`);

  let copied = 0, skipped = 0, verified = 0, failed = 0;
  const failures: string[] = [];

  for (const [i, o] of objects.entries()) {
    const tag = `[${i + 1}/${objects.length}] ${o.key}`;

    // Already at the destination with the same size? Verify rather than re-upload.
    let existing: { size: number } | null = null;
    try {
      const h = await dst.send(new HeadObjectCommand({ Bucket: DST_BUCKET, Key: o.key }));
      existing = { size: h.ContentLength ?? -1 };
    } catch { existing = null; }

    if (DRY) {
      console.log(`${tag} — ${existing && existing.size === o.size ? "already present" : "would copy"}`);
      continue;
    }

    const got = await src.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: o.key }));
    const bytes = await got.Body!.transformToByteArray();
    const srcHash = md5(bytes);

    const needsCopy = !existing || existing.size !== o.size;
    if (needsCopy && !VERIFY_ONLY) {
      await dst.send(new PutObjectCommand({
        Bucket: DST_BUCKET, Key: o.key, Body: bytes,
        ContentType: got.ContentType ?? "application/octet-stream",
      }));
      copied++;
    } else {
      skipped++;
    }

    // Read the destination back and compare hashes. Size matching is not proof.
    const back = await dst.send(new GetObjectCommand({ Bucket: DST_BUCKET, Key: o.key }));
    const backBytes = await back.Body!.transformToByteArray();
    if (md5(backBytes) === srcHash) {
      verified++;
      console.log(`${tag} — ${needsCopy && !VERIFY_ONLY ? "copied" : "present"}, md5 match (${bytes.length} b)`);
    } else {
      failed++; failures.push(o.key);
      console.log(`${tag} — MD5 MISMATCH src=${srcHash} dst=${md5(backBytes)}`);
    }
  }

  if (DRY) { console.log("\nDry run complete, nothing written."); return; }

  console.log(`\ncopied=${copied} already-present=${skipped} md5-verified=${verified}/${objects.length} failed=${failed}`);
  if (failures.length) {
    console.log("FAILED KEYS:");
    for (const k of failures) console.log(`  ${k}`);
    process.exit(1);
  }
  console.log("All objects verified byte-identical at the destination.");
  console.log("\nSource bucket untouched. To cut over, update these on Railway and redeploy:");
  console.log(`  S3_ENDPOINT=${DST_ENDPOINT}`);
  console.log(`  S3_BUCKET=${DST_BUCKET}`);
  console.log(`  S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY = the new account's keys`);
  console.log("Then re-run this script to sweep any objects written after the pre-stage.");
}

main().catch((e) => { console.error(e); process.exit(1); });
