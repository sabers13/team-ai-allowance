/**
 * Password hashing with scrypt and a per-user salt.
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt hex>$<derived key hex>`.
 * The clear password never leaves this module and never reaches a log.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

/** Minimum accepted password length, enforced at the boundary as well. */
export const MIN_PASSWORD_LENGTH = 12;

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyBytes, options, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Verify a password against a stored hash. Unknown formats fail closed. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const keyHex = parts[5];
  if (saltHex === undefined || keyHex === undefined) return false;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p))
    return false;
  if (n <= 0 || r <= 0 || p <= 0 || n > 1_048_576) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await deriveKey(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
