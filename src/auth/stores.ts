/**
 * Credential and manager-token stores.
 *
 * Both keep only password hashes and token hashes. The `Store`
 * interface has no credential table, so credentials are an auth-owned port.
 * These in-memory implementations are the
 * reference behaviour for tests and for `taa serve`.
 */

import type { Clock, IsoDateTime, MemberId, Role, TeamId } from "../contracts.ts";
import { randomToken, sha256Hex } from "./crypto.ts";

export interface ManagerCredential {
  memberId: MemberId;
  email: string;
  /** scrypt output, never a clear password. */
  passwordHash: string;
  updatedAt: IsoDateTime;
}

export interface CredentialStore {
  findByEmail(email: string): Promise<ManagerCredential | null>;
  findByMember(memberId: MemberId): Promise<ManagerCredential | null>;
  /** Store an already-hashed password. Callers hash it with `hashPassword`. */
  setPassword(
    memberId: MemberId,
    email: string,
    passwordHash: string,
    at?: IsoDateTime,
  ): Promise<ManagerCredential>;
  delete(memberId: MemberId): Promise<void>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createMemoryCredentialStore(clock: Clock): CredentialStore {
  const byMember = new Map<MemberId, ManagerCredential>();
  return {
    async findByEmail(email) {
      const wanted = normalizeEmail(email);
      for (const credential of byMember.values()) {
        if (credential.email === wanted) return credential;
      }
      return null;
    },
    async findByMember(memberId) {
      return byMember.get(memberId) ?? null;
    },
    async setPassword(memberId, email, passwordHash, at) {
      const credential: ManagerCredential = {
        memberId,
        email: normalizeEmail(email),
        passwordHash,
        updatedAt: at ?? clock.now().toISOString(),
      };
      byMember.set(memberId, credential);
      return credential;
    },
    async delete(memberId) {
      byMember.delete(memberId);
    },
  };
}

export interface ManagerTokenRecord {
  id: string;
  memberId: MemberId;
  teamId: TeamId;
  role: Extract<Role, "manager" | "admin">;
  label: string | null;
  /** sha256 of the token; the token itself is shown once and never stored. */
  tokenHash: string;
  createdAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
}

export interface ManagerTokenStore {
  add(record: ManagerTokenRecord): Promise<ManagerTokenRecord>;
  findByHash(tokenHash: string): Promise<ManagerTokenRecord | null>;
  list(memberId: MemberId): Promise<ManagerTokenRecord[]>;
  revoke(id: string, at: IsoDateTime): Promise<void>;
  revokeAllForMember(memberId: MemberId, at: IsoDateTime): Promise<void>;
}

export function createMemoryManagerTokenStore(): ManagerTokenStore {
  const records = new Map<string, ManagerTokenRecord>();
  return {
    async add(record) {
      records.set(record.id, record);
      return record;
    },
    async findByHash(tokenHash) {
      for (const record of records.values()) {
        if (record.tokenHash === tokenHash) return record;
      }
      return null;
    },
    async list(memberId) {
      return [...records.values()]
        .filter((record) => record.memberId === memberId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async revoke(id, at) {
      const record = records.get(id);
      if (record !== undefined) records.set(id, { ...record, revokedAt: at });
    },
    async revokeAllForMember(memberId, at) {
      for (const [id, record] of records) {
        if (record.memberId === memberId && record.revokedAt === null) {
          records.set(id, { ...record, revokedAt: at });
        }
      }
    },
  };
}

export const MANAGER_TOKEN_PREFIX = "taa_mgr_";

export interface IssueManagerTokenInput {
  memberId: MemberId;
  teamId: TeamId;
  role: Extract<Role, "manager" | "admin">;
  label?: string | null;
}

export interface IssuedManagerToken {
  record: ManagerTokenRecord;
  /** Shown once by the route that created it; never persisted or logged. */
  token: string;
}

/** Mint a manager API token and persist only its hash. */
export async function issueManagerToken(
  store: ManagerTokenStore,
  input: IssueManagerTokenInput,
  clock: Clock,
): Promise<IssuedManagerToken> {
  const token = `${MANAGER_TOKEN_PREFIX}${randomToken(32)}`;
  const record: ManagerTokenRecord = {
    id: `tok_${randomToken(12)}`,
    memberId: input.memberId,
    teamId: input.teamId,
    role: input.role,
    label: input.label ?? null,
    tokenHash: sha256Hex(token),
    createdAt: clock.now().toISOString(),
    revokedAt: null,
  };
  await store.add(record);
  return { record, token };
}
