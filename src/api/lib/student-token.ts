// Lightweight signed tokens for the Phase 2 desktop student client.
// Students are NOT Better Auth users, so we mint a small HMAC-signed token
// (studentId + issued-at) using BETTER_AUTH_SECRET. Stateless + tamper-proof.

const enc = new TextEncoder();

function secret(): string {
  return process.env.BETTER_AUTH_SECRET || "examly-dev-secret-please-change";
}

// Every single student request verifies a token, so importing the key each time
// is pure repeated work: at 1000 students the exam client sends hundreds of
// requests a second and the key never changes for the life of the process. Keyed
// by the secret so a changed BETTER_AUTH_SECRET (tests, a rotated env) is picked
// up instead of silently verifying against the old one.
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(): Promise<CryptoKey> {
  const current = secret();
  if (cachedKey && cachedKey.secret === current) return cachedKey.key;
  const key = crypto.subtle.importKey(
    "raw",
    enc.encode(current),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  // Cache the promise, not the awaited key: concurrent verifications during boot
  // then share one import instead of racing several.
  cachedKey = { secret: current, key };
  key.catch(() => {
    // A failed import must not be cached forever.
    if (cachedKey?.key === key) cachedKey = null;
  });
  return key;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function signStudentToken(studentId: string): Promise<string> {
  const payload = `${studentId}.${Date.now()}`;
  const key = await hmacKey();
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verifyStudentToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;
    const payloadBytes = fromB64url(payloadB64);
    const key = await hmacKey();
    // Casts: TS models Uint8Array<ArrayBufferLike> as incompatible with BufferSource
    // (which requires an ArrayBuffer-backed view). Runtime-identical.
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sigB64) as unknown as BufferSource, payloadBytes as unknown as BufferSource);
    if (!ok) return null;
    const payload = new TextDecoder().decode(payloadBytes);
    const [studentId] = payload.split(".");
    return studentId || null;
  } catch {
    return null;
  }
}
