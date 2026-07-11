/**
 * `@multicode/persistence` — durable, transactional storage behind a backend-agnostic {@link Store}
 * interface. Ships a SQLite implementation; a future PostgreSQL backend can satisfy the same contract
 * without touching callers.
 */
export type {
  Store,
  TaskFilter,
  TaskPatch,
  TransitionInput,
  TransitionResult,
  GetEventsOptions,
} from './store.js';

export { SqliteStore, type SqliteStoreOptions } from './sqlite/sqlite-store.js';
export { openDatabase, type OpenDatabaseOptions, type Database } from './sqlite/database.js';
export { MIGRATIONS, LATEST_VERSION, runMigrations, type Migration } from './migrations/index.js';
