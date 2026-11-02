/**
 * Resolving an HTTP request to a principal.
 *
 * Three credentials exist and they never blur together:
 *
 * 1. A member gateway key (`Authorization: Bearer <key>`) — always the
 *    `member` role, even when the person also manages a team.
 * 2. A manager API token (`Authorization: Bearer taa_mgr_...`) — manager or
 *    admin, for MCP servers and scripts. No CSRF applies to it.
 * 3. A browser session cookie — manager or admin after a password login, or a
 *    member after a key login. CSRF applies to it.
 *
 * Member keys are matched by sha256 with a constant-time comparison.
 */

import type { Clock, KeyHash, Member, MemberId, Role } from "../contracts.ts";
import { parseCookieHeader } from "./cookies.ts";
import { safeEqual, sha256Hex } from "./crypto.ts";
import { SESSION_COOKIE, type SessionStore, verifySessionCookie } from "./session.ts";
import { MANAGER_TOKEN_PREFIX, type ManagerTokenStore } from "./stores.ts";

export interface AuthMemberSource {
  getMember(id: MemberId): Promise<Member | null>;
  getMemberByKeyHash(hash: KeyHash): Promise<Member | null>;
}

export type Principal =
  | { kind: "member_key"; member: Member; role: "member" }
  | {
      kind: "manager_token";
      member: Member;
      role: Extract<Role, "manager" | "admin">;
      tokenId: string;
    }
  | { kind: "session"; member: Member; role: Role; sessionId: string; csrfToken: string };

export interface AuthenticateRequest {
  authorization: string | undefined;
  cookie: string | undefined;
}

export interface AuthenticatorOptions {
  members: AuthMemberSource;
  tokens: ManagerTokenStore;
  sessions: SessionStore;
  sessionSecret: string;
  clock: Clock;
}

export interface Authenticator {
  authenticate(request: AuthenticateRequest): Promise<Principal | null>;
}

/** Parse `Bearer <token>`; the scheme is case-insensitive and required. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = match[1]?.trim();
  if (token === undefined || token.length === 0) return null;
  return token;
}

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const { members, tokens, sessions, sessionSecret, clock } = options;

  const memberFromKey = async (key: string): Promise<Principal | null> => {
    const hash = sha256Hex(key);
    const member = await members.getMemberByKeyHash(hash);
    if (member === null || member.keyHash === null) return null;
    if (!safeEqual(member.keyHash, hash)) return null;
    return { kind: "member_key", member, role: "member" };
  };

  const principalFromToken = async (token: string): Promise<Principal | null> => {
    const record = await tokens.findByHash(sha256Hex(token));
    if (record === null || record.revokedAt !== null) return null;
    const member = await members.getMember(record.memberId);
    if (member === null) return null;
    return {
      kind: "manager_token",
      member,
      role: record.role,
      tokenId: record.id,
    };
  };

  const principalFromCookie = async (
    cookieHeader: string | undefined,
  ): Promise<Principal | null> => {
    const cookies = parseCookieHeader(cookieHeader);
    const raw = cookies[SESSION_COOKIE];
    if (raw === undefined) return null;
    const payload = verifySessionCookie(raw, sessionSecret, clock.now().getTime());
    if (payload === null) return null;
    const session = sessions.get(payload.id);
    if (session === null) return null;
    const member = await members.getMember(session.memberId);
    if (member === null) return null;
    return {
      kind: "session",
      member,
      role: member.role,
      sessionId: session.id,
      csrfToken: session.csrfToken,
    };
  };

  return {
    async authenticate(request) {
      const token = bearerToken(request.authorization);
      if (token !== null) {
        if (token.startsWith(MANAGER_TOKEN_PREFIX)) return principalFromToken(token);
        return memberFromKey(token);
      }
      return principalFromCookie(request.cookie);
    },
  };
}
