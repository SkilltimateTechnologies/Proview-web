import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

export const BUCKET = process.env.S3_BUCKET!;

export async function presignPut(key: string, contentType: string) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), {
    expiresIn: 3600,
  });
}

const GET_TTL_SEC = 3600 * 24;

export async function presignGet(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: GET_TTL_SEC });
}

/**
 * Presigned GET with an in-process cache.
 *
 * WHY: the Live Monitor re-signs the newest snapshot for EVERY student on EVERY
 * poll (5s). On a 268-student exam that is 268 signings every 5 seconds, and the
 * URL it produces is valid for 24h anyway — so all but the first are pure waste.
 * Signing is local (no network), but at that volume it still dominated the
 * endpoint's CPU time and helped push a poll past its own 5s interval, stacking
 * requests until the page froze.
 *
 * Cached for half the URL's lifetime, so a handed-out URL is never close to
 * expiry. Bounded so a long-running server cannot grow this map without limit.
 */
const getUrlCache = new Map<string, { url: string; expiresAtMs: number }>();
const GET_CACHE_MAX = 5000;
const GET_CACHE_TTL_MS = (GET_TTL_SEC / 2) * 1000;

export async function presignGetCached(key: string): Promise<string> {
  const hit = getUrlCache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAtMs > now) return hit.url;

  const url = await presignGet(key);
  // Cheap eviction: the map is insertion-ordered, so drop the oldest entries.
  if (getUrlCache.size >= GET_CACHE_MAX) {
    let toDrop = Math.ceil(GET_CACHE_MAX * 0.2);
    for (const k of getUrlCache.keys()) {
      getUrlCache.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  getUrlCache.set(key, { url, expiresAtMs: now + GET_CACHE_TTL_MS });
  return url;
}

export async function getObject(key: string) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return out;
}
