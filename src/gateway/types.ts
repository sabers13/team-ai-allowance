/**
 * LiteLLM admin API shapes used by the client.
 *
 * These are deliberately loose: LiteLLM returns numbers as numbers or strings
 * depending on the route, and adds fields between minor versions. The client
 * parses defensively and maps to the frozen contract types.
 */

export interface KeyRecord {
  readonly keyAlias: string | null;
  readonly keyHash: string | null;
  readonly teamId: string | null;
  readonly userId: string | null;
  readonly models: readonly string[] | null;
  readonly maxBudgetUsd: number | null;
  readonly budgetDuration: string | null;
  readonly tpmLimit: number | null;
  readonly rpmLimit: number | null;
  readonly blocked: boolean;
  readonly spendUsd: number;
}

export interface TeamRecord {
  readonly teamId: string;
  readonly teamAlias: string | null;
  readonly maxBudgetUsd: number | null;
  readonly budgetDuration: string | null;
  readonly spendUsd: number;
  readonly blocked: boolean;
}

export interface UserRecord {
  readonly userId: string;
  readonly userAlias: string | null;
  readonly userEmail: string | null;
  readonly teams: readonly string[];
}

export interface CreateUserInput {
  readonly userId: string;
  readonly userAlias?: string;
  readonly userEmail?: string;
  readonly teamId?: string;
}

export interface UpdateUserPatch {
  readonly userAlias?: string;
  readonly userEmail?: string;
  readonly maxBudgetUsd?: number;
  readonly budgetDuration?: string;
  readonly models?: readonly string[];
}

export interface TeamMemberPatch {
  readonly role?: "admin" | "user";
  readonly maxBudgetInTeamUsd?: number;
  readonly budgetDuration?: string;
  readonly tpmLimit?: number | null;
  readonly rpmLimit?: number | null;
}

export interface TeamSpendRow {
  readonly userId: string | null;
  readonly spendUsd: number;
}
