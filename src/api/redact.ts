/**
 * Response projection: key material never leaves the control service after
 * the one response that creates it.
 */

import type { Member } from "../contracts.ts";
import type { MemberDetail, TeamOverview } from "./control.ts";

export type PublicMember = Omit<Member, "keyHash">;

export function publicMember(member: Member): PublicMember {
  return {
    id: member.id,
    teamId: member.teamId,
    displayName: member.displayName,
    email: member.email,
    role: member.role,
    keyAlias: member.keyAlias,
    blocked: member.blocked,
    blockedReason: member.blockedReason,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

export function publicMembers(members: readonly Member[]): PublicMember[] {
  return members.map(publicMember);
}

export interface PublicTeamOverview extends Omit<TeamOverview, "members"> {
  members: Array<{
    member: PublicMember;
    policy: TeamOverview["members"][number]["policy"];
    spendUsd: number;
  }>;
}

export function publicTeamOverview(overview: TeamOverview): PublicTeamOverview {
  return {
    team: overview.team,
    members: overview.members.map((row) => ({
      member: publicMember(row.member),
      policy: row.policy,
      spendUsd: row.spendUsd,
    })),
    models: overview.models,
    openRequests: overview.openRequests,
    alerts: overview.alerts,
  };
}

export interface PublicMemberDetail extends Omit<MemberDetail, "member" | "grants"> {
  member: PublicMember;
  grants: MemberDetail["grants"];
}

export function publicMemberDetail(detail: MemberDetail): PublicMemberDetail {
  return {
    member: publicMember(detail.member),
    policy: detail.policy,
    limits: detail.limits,
    grants: detail.grants,
    usage: detail.usage,
  };
}
