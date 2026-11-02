/**
 * Public entry point for the SQLite store.
 *
 * Callers import `openSqliteStore` and the `SqliteStore`
 * type here; they never write SQL of their own.
 */

export { DEFAULT_DB_PATH, resolveDbPath } from "./config.ts";
export type { Migration, MigrationResult } from "./migrations.ts";
export { MIGRATIONS, migrate } from "./migrations.ts";
export type { OpenStoreOptions } from "./sqlite.ts";
export { openSqliteStore, SCHEMA_VERSION, SqliteStore } from "./sqlite.ts";
