import { existsSync } from 'node:fs';
import { asArtifactId, asTaskId, dataPaths, type TaskStatus } from '@multicode/core';
import { SqliteStore, openDatabase } from '@multicode/persistence';
import { loadConfig, type GlobalOptions } from '../config-loader.js';
import { glyph, print, printErr, printJson, table } from '../output.js';

/** Open the store read-only for inspection (never runs migrations, never blocks a running server). */
const openReadStore = (opts: GlobalOptions): SqliteStore | null => {
  const config = loadConfig(opts);
  const dbPath = dataPaths(config.dataDir).database;
  if (!existsSync(dbPath)) return null;
  const db = openDatabase({ path: dbPath, readonly: true });
  return SqliteStore.fromDatabase(db);
};

export interface TaskListOptions extends GlobalOptions {
  status?: string;
  provider?: string;
  limit?: string;
  json?: boolean;
}

export const runTaskList = async (opts: TaskListOptions): Promise<number> => {
  const store = openReadStore(opts);
  if (!store) {
    print('No tasks yet (database not created).');
    return 0;
  }
  const tasks = await store.listTasks({
    ...(opts.status ? { status: [opts.status as TaskStatus] } : {}),
    ...(opts.provider ? { providerId: opts.provider as never } : {}),
    limit: opts.limit ? Number.parseInt(opts.limit, 10) : 50,
  });
  await store.close();
  if (opts.json) {
    printJson({ tasks });
  } else if (tasks.length === 0) {
    print('No tasks.');
  } else {
    const rows = tasks.map((t) => [
      `${glyph(t.status)} ${t.status}`,
      t.id.slice(0, 20),
      t.providerId,
      t.mode,
      t.title.slice(0, 40),
    ]);
    print(table(['STATUS', 'ID', 'PROVIDER', 'MODE', 'TITLE'], rows));
  }
  return 0;
};

export const runTaskGet = async (id: string, opts: GlobalOptions & { json?: boolean }): Promise<number> => {
  const store = openReadStore(opts);
  if (!store) return notFound(id);
  const task = await store.getTask(asTaskId(id));
  await store.close();
  if (!task) return notFound(id);
  printJson({ task });
  return 0;
};

export const runTaskEvents = async (
  id: string,
  opts: GlobalOptions & { after?: string; limit?: string; json?: boolean },
): Promise<number> => {
  const store = openReadStore(opts);
  if (!store) return notFound(id);
  const events = await store.getEvents(asTaskId(id), {
    ...(opts.after ? { afterSeq: Number.parseInt(opts.after, 10) } : {}),
    limit: opts.limit ? Number.parseInt(opts.limit, 10) : 200,
  });
  await store.close();
  if (opts.json) {
    printJson({ events });
  } else {
    for (const e of events) print(`#${String(e.seq).padStart(4)} ${e.at}  ${e.type}`);
  }
  return 0;
};

export const runTaskDiff = async (id: string, opts: GlobalOptions & { json?: boolean }): Promise<number> => {
  const store = openReadStore(opts);
  if (!store) return notFound(id);
  const task = await store.getTask(asTaskId(id));
  if (!task) {
    await store.close();
    return notFound(id);
  }
  const diff = task.result?.verification.diff;
  if (!diff) {
    await store.close();
    print('No verified diff available for this task.');
    return 0;
  }
  let patch: string | undefined;
  if (diff.patchArtifactId) {
    patch = (await store.getArtifact(asArtifactId(diff.patchArtifactId)))?.content;
  }
  await store.close();
  if (opts.json) {
    printJson({ summary: diff, patch });
  } else {
    print(`${diff.filesChanged} file(s) changed, +${diff.insertions} -${diff.deletions} (base ${diff.baseRef.slice(0, 12)})`);
    print('');
    if (patch) print(patch);
  }
  return 0;
};

const notFound = (id: string): number => {
  printErr(`Task ${id} not found.`);
  return 1;
};
