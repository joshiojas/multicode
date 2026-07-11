import type { Database } from 'better-sqlite3';

/** A single forward-only migration. Migrations never mutate or delete earlier migrations. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

/**
 * The ordered list of migrations. Append new entries with the next integer version; never edit a
 * released migration. The runner applies each pending migration inside its own transaction and records
 * it in `schema_migrations`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id                   TEXT PRIMARY KEY,
          provider_id          TEXT NOT NULL,
          status               TEXT NOT NULL,
          mode                 TEXT NOT NULL,
          prompt               TEXT NOT NULL,
          title                TEXT NOT NULL,
          policy_json          TEXT NOT NULL,
          workspace_json       TEXT NOT NULL,
          interactive          INTEGER NOT NULL DEFAULT 0,
          provider_session_id  TEXT,
          result_json          TEXT,
          error_json           TEXT,
          metadata_json        TEXT NOT NULL DEFAULT '{}',
          revision             INTEGER NOT NULL DEFAULT 0,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          started_at           TEXT,
          finished_at          TEXT
        ) STRICT;

        CREATE INDEX idx_tasks_status     ON tasks(status);
        CREATE INDEX idx_tasks_provider   ON tasks(provider_id);
        CREATE INDEX idx_tasks_created_at ON tasks(created_at);

        CREATE TABLE task_events (
          id        TEXT PRIMARY KEY,
          task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          seq       INTEGER NOT NULL,
          at        TEXT NOT NULL,
          type      TEXT NOT NULL,
          data_json TEXT NOT NULL,
          UNIQUE(task_id, seq)
        ) STRICT;

        CREATE INDEX idx_events_task_seq ON task_events(task_id, seq);

        CREATE TABLE approvals (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind           TEXT NOT NULL,
          summary        TEXT NOT NULL,
          detail_json    TEXT NOT NULL DEFAULT '{}',
          provider_token TEXT NOT NULL,
          status         TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          resolved_at    TEXT,
          decision       TEXT,
          note           TEXT
        ) STRICT;

        CREATE INDEX idx_approvals_task   ON approvals(task_id);
        CREATE INDEX idx_approvals_status ON approvals(status);

        CREATE TABLE artifacts (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind         TEXT NOT NULL,
          name         TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'text/plain',
          size_bytes   INTEGER NOT NULL DEFAULT 0,
          content      TEXT,
          path         TEXT,
          sha256       TEXT,
          created_at   TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_artifacts_task ON artifacts(task_id);
      `);
    },
  },
];

/** The schema version this build knows how to produce. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Apply all pending migrations. Each runs in its own transaction; a failure rolls back that
 * migration and leaves the database at the last successfully applied version.
 */
export const runMigrations = (db: Database): { from: number; to: number; applied: number[] } => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const currentRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  const from = currentRow.v;

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  for (const migration of ordered) {
    if (migration.version <= from) continue;
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    tx();
    applied.push(migration.version);
  }

  return { from, to: LATEST_VERSION, applied };
};
