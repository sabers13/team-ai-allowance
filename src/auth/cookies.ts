/**
 * Minimal cookie parsing and serialisation.
 *
 * Session cookies are `httpOnly`, `SameSite=Strict` and `Secure` whenever the
 * public URL is https. No cookie ever carries a key, a password or a token.
 */

export type SameSite = "Strict" | "Lax";

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  path?: string;
  maxAgeSeconds?: number;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length === 0) continue;
    if (cookies[name] === undefined) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  attributes.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSeconds !== undefined) attributes.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly === true) attributes.push("HttpOnly");
  if (options.secure === true) attributes.push("Secure");
  attributes.push(`SameSite=${options.sameSite ?? "Strict"}`);
  return attributes.join("; ");
}

/** A cookie that removes itself. */
export function clearedCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}
