import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database (tests). */
  readonly path: string;
  /** Open read-only (used by CLI inspection so it never blocks a running server). */
  readonly readonly?: boolean;
  /** Busy timeout in ms before a locked write gives up. */
  readonly busyTimeoutMs?: number;
}

/**
 * Open a SQLite database with the pragmas Multicode relies on:
 * - WAL journaling for concurrent readers alongside a single writer,
 * - `foreign_keys` ON so cascading deletes and referential integrity hold,
 * - `busy_timeout` so brief lock contention retries instead of erroring,
 * - `synchronous = NORMAL` (safe with WAL) for durability without excessive fsync cost.
 */
export const openDatabase = (options: OpenDatabaseOptions): Database => {
  const { path, readonly = false, busyTimeoutMs = 5_000 } = options;

  if (path !== ':memory:' && !readonly) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new BetterSqlite3(path, { readonly, fileMustExist: readonly && path !== ':memory:' });

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('synchronous = NORMAL');

  return db;
};

export type { Database };
