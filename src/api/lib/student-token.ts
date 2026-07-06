// Lightweight signed tokens for the Phase 2 desktop student client.
// Students are NOT Better Auth users, so we mint a small HMAC-signed token
// (studentId + issued-at) using BETTER_AUTH_SECRET. Stateless + tamper-proof.

const enc = new TextEncoder();

function secret(): string {
  return process.env.BETTER_AUTH_SECRET || "examly-dev-secret-please-change";
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
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
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sigB64), payloadBytes);
    if (!ok) return null;
    const payload = new TextDecoder().decode(payloadBytes);
    const [studentId] = payload.split(".");
    return studentId || null;
  } catch {
    return null;
  }
}
