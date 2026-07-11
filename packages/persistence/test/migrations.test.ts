import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_VERSION, SqliteStore, openDatabase, runMigrations } from '@multicode/persistence';
import { makeClock, makeTask } from './helpers.js';

describe('migrations & durability', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'multicode-persist-'));
    dbPath = join(dir, 'multicode.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations once and is idempotent', () => {
    const db = openDatabase({ path: dbPath });
    const first = runMigrations(db);
    expect(first.applied).toEqual([1]);
    expect(first.to).toBe(LATEST_VERSION);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    const version = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(version.v).toBe(LATEST_VERSION);
    db.close();
  });

  it('persists tasks and events across a reopen (survives restart)', async () => {
    const clock = makeClock();
    const store = await SqliteStore.open({ path: dbPath, clock });
    const task = makeTask({ status: 'running' });
    await store.createTask(task);
    await store.appendEvents(task.id, [{ type: 'note', message: 'before restart' }]);
    await store.applyTransition(task.id, {
      expectedRevision: 0,
      patch: { providerSessionId: 'sess_1' },
    });
    await store.close();

    // Simulate a Multicode restart: a brand-new store over the same file.
    const reopened = await SqliteStore.open({ path: dbPath, clock });
    const loaded = await reopened.getTask(task.id);
    expect(loaded?.providerSessionId).toBe('sess_1');
    expect(loaded?.revision).toBe(1);
    const events = await reopened.getEvents(task.id);
    expect(events).toHaveLength(1);
    // The interrupted running task is still discoverable for recovery.
    const active = await reopened.findActiveTasks();
    expect(active.map((t) => t.id)).toContain(task.id);
    await reopened.close();
  });
});
