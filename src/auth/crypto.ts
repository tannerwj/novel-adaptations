// src/auth/crypto.ts — token generation, hashing, constant-time comparison.
// Uses the Web Crypto API (available in Cloudflare Workers and Node 18+).

const HEX_PAD = '00';

/** 32 random bytes → 64 hex chars, via WebCrypto. For magic links + sessions. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += (HEX_PAD + b.toString(16)).slice(-2);
  return hex;
}

/** SHA-256 of a UTF-8 string, lowercase hex. Only hashes hit the database. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += (HEX_PAD + b.toString(16)).slice(-2);
  return hex;
}

/** Constant-time comparison so token/hash lookups don't leak via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
