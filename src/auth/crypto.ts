/**
 * Small, dependency-free cryptographic helpers.
 *
 * Everything here is deliberately boring: hashes, an HMAC and a constant-time
 * comparison. No credential is ever logged or returned by these helpers.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** sha256 hex, lowercase. Used for member keys and manager API tokens. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** HMAC-SHA256 hex, used to sign session cookies. */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. Unequal lengths are compared against a
 * padded copy so the fast path does not leak the length through timing.
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    const padded = Buffer.alloc(a.length);
    b.copy(padded, 0, 0, Math.min(a.length, b.length));
    timingSafeEqual(a, padded);
    return false;
  }
  return timingSafeEqual(a, b);
}
