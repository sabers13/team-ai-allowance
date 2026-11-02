import type {
  DesiredKeyState,
  Grant,
  GrantId,
  IsoDateTime,
  KeyAlias,
  MemberId,
  ModelEntry,
  Rule,
  Store,
} from "../contracts.ts";

/**
 * The extra persistence operations the core needs beyond the frozen `Store`
 * interface. `SqliteStore` satisfies this shape; it is declared here so the
 * core never imports the SQLite adapter.
 */
export interface CoreStore extends Store {
  /** Run a unit of work atomically. The callback must not await real I/O. */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;

  getGrant(id: GrantId): Promise<Grant | null>;
  /** Grants whose `expiresAt` has passed and that have not been logged yet. */
  listExpiredGrants(at: IsoDateTime): Promise<Grant[]>;
  markGrantExpired(id: GrantId, at: IsoDateTime): Promise<void>;

  listModels(): Promise<ModelEntry[]>;
  upsertModel(model: ModelEntry): Promise<ModelEntry>;
  deleteModel(id: string): Promise<void>;

  getRule(id: string): Promise<Rule | null>;

  /** The gateway's id for a control team, persisted so a restart does not split it. */
  getGatewayTeamId(teamId: string): Promise<string | null>;
  setGatewayTeamId(teamId: string, gatewayTeamId: string | null): Promise<void>;

  getMemberModels(memberId: MemberId): Promise<string[]>;
  setMemberModels(memberId: MemberId, modelIds: string[], at: IsoDateTime): Promise<string[]>;

  getKeyState(keyAlias: KeyAlias): Promise<DesiredKeyState | null>;
  listKeyStates(): Promise<DesiredKeyState[]>;
  setKeyState(state: DesiredKeyState, at: IsoDateTime): Promise<void>;
}
