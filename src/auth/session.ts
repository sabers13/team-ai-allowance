/**
 * Browser sessions: a random session id, a 12-hour lifetime, and a signed
 * cookie value. The cookie is httpOnly and SameSite=Strict; the signature is
 * an HMAC over the id and expiry with `TAA_SESSION_SECRET`.
 */

import type { Clock, IsoDateTime, MemberId, Role, TeamId } from "../contracts.ts";
import { hmacSha256Hex, randomToken, safeEqual } from "./crypto.ts";

export const SESSION_COOKIE = "taa_session";
export const CSRF_COOKIE = "taa_csrf";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  id: string;
  memberId: MemberId;
  teamId: TeamId;
  role: Role;
  /** Random per-session token; forms and API clients echo it back. */
  csrfToken: string;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  /** Epoch milliseconds, used in the signed cookie payload. */
  expiresAtMs: number;
}

export interface CreateSessionInput {
  memberId: MemberId;
  teamId: TeamId;
  role: Role;
  ttlMs?: number;
}

export interface SessionStore {
  create(input: CreateSessionInput): Session;
  get(id: string): Session | null;
  destroy(id: string): void;
}

export function createMemorySessionStore(clock: Clock): SessionStore {
  const sessions = new Map<string, Session>();

  const prune = (nowMs: number): void => {
    for (const [id, session] of sessions) {
      if (session.expiresAtMs <= nowMs) sessions.delete(id);
    }
  };

  return {
    create(input) {
      const now = clock.now();
      const nowMs = now.getTime();
      prune(nowMs);
      const ttlMs = input.ttlMs ?? SESSION_TTL_MS;
      const expiresAtMs = nowMs + ttlMs;
      const session: Session = {
        id: randomToken(18),
        memberId: input.memberId,
        teamId: input.teamId,
        role: input.role,
        csrfToken: randomToken(32),
        createdAt: now.toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      const session = sessions.get(id);
      if (session === undefined) return null;
      if (session.expiresAtMs <= clock.now().getTime()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    destroy(id) {
      sessions.delete(id);
    },
  };
}

/** `<id>.<expiresAtMs>.<hmac>` — all parts URL-safe. */
export function signSessionCookie(session: Session, secret: string): string {
  const payload = `${session.id}.${session.expiresAtMs}`;
  return `${payload}.${hmacSha256Hex(secret, payload)}`;
}

export interface SessionCookiePayload {
  id: string;
  expiresAtMs: number;
}

/** Verify the signature and the expiry. Anything malformed returns null. */
export function verifySessionCookie(
  value: string,
  secret: string,
  nowMs: number,
): SessionCookiePayload | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const id = parts[0];
  const expiresRaw = parts[1];
  const signature = parts[2];
  if (id === undefined || expiresRaw === undefined || signature === undefined) return null;
  if (id.length === 0 || !/^\d+$/.test(expiresRaw)) return null;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  const expected = hmacSha256Hex(secret, `${id}.${expiresRaw}`);
  if (!safeEqual(expected, signature)) return null;
  if (expiresAtMs <= nowMs) return null;
  return { id, expiresAtMs };
}
