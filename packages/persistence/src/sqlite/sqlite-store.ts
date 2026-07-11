import {
  ApprovalRequest,
  ConflictError,
  NotFoundError,
  TaskEventData,
  assertTransition,
  isActive,
  newEventId,
  systemClock,
  type ApprovalDecision,
  type ApprovalId,
  type Artifact,
  type ArtifactId,
  type Clock,
  type NewTaskEvent,
  type Task,
  type TaskEvent,
  type TaskId,
  type TaskStatus,
} from '@multicode/core';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../migrations/index.js';
import type {
  GetEventsOptions,
  Store,
  TaskFilter,
  TransitionInput,
  TransitionResult,
} from '../store.js';
import { openDatabase, type OpenDatabaseOptions } from './database.js';
import {
  rowToApproval,
  rowToArtifact,
  rowToEvent,
  rowToTask,
  taskToRow,
  type ApprovalRow,
  type ArtifactRow,
  type EventRow,
  type TaskRow,
} from './row-mapping.js';

export interface SqliteStoreOptions extends OpenDatabaseOptions {
  /** Clock used for timestamps; injectable for deterministic tests. */
  clock?: Clock;
}

/**
 * The SQLite-backed {@link Store}. All multi-row mutations run inside better-sqlite3 transactions,
 * which are synchronous and therefore truly atomic. Optimistic concurrency is enforced via the
 * `revision` column so two concurrent transitions can never interleave silently.
 */
export class SqliteStore implements Store {
  readonly #db: Database;
  readonly #clock: Clock;

  private constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Open a store and run migrations. */
  static async open(options: SqliteStoreOptions): Promise<SqliteStore> {
    const db = openDatabase(options);
    const store = new SqliteStore(db, options.clock ?? systemClock);
    await store.migrate();
    return store;
  }

  /** Wrap an already-open database (used by tests that share a connection). */
  static fromDatabase(db: Database, clock: Clock = systemClock): SqliteStore {
    return new SqliteStore(db, clock);
  }

  async migrate(): Promise<void> {
    runMigrations(this.#db);
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async createTask(task: Task): Promise<Task> {
    const row = taskToRow(task);
    this.#db
      .prepare(
        `INSERT INTO tasks (
            id, provider_id, status, mode, prompt, title, policy_json, workspace_json, interactive,
            provider_session_id, result_json, error_json, metadata_json, revision,
            created_at, updated_at, started_at, finished_at
         ) VALUES (
            @id, @provider_id, @status, @mode, @prompt, @title, @policy_json, @workspace_json, @interactive,
            @provider_session_id, @result_json, @error_json, @metadata_json, @revision,
            @created_at, @updated_at, @started_at, @finished_at
         )`,
      )
      .run(row);
    return task;
  }

  async getTask(id: TaskId): Promise<Task | null> {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const { sql, params } = this.#buildTaskQuery('SELECT *', filter, true);
    const rows = this.#db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  async countTasks(filter: TaskFilter = {}): Promise<number> {
    const { sql, params } = this.#buildTaskQuery('SELECT COUNT(*) AS n', filter, false);
    const row = this.#db.prepare(sql).get(...params) as { n: number };
    return row.n;
  }

  async applyTransition(id: TaskId, input: TransitionInput): Promise<TransitionResult> {
    const tx = this.#db.transaction((): TransitionResult => {
      const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
        | TaskRow
        | undefined;
      if (!row) throw new NotFoundError(`Task ${id} not found`, { details: { taskId: id } });

      if (row.revision !== input.expectedRevision) {
        throw new ConflictError(
          `Task ${id} revision mismatch (expected ${input.expectedRevision}, found ${row.revision})`,
          { details: { taskId: id, expected: input.expectedRevision, actual: row.revision } },
        );
      }

      const current = rowToTask(row);
      const patch = input.patch ?? {};

      if (patch.status && patch.status !== current.status) {
        assertTransition(current.status, patch.status);
      }

      const now = this.#clock.isoNow();
      const next: Task = {
        ...current,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.providerSessionId !== undefined
          ? { providerSessionId: patch.providerSessionId }
          : {}),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
        revision: current.revision + 1,
        updatedAt: now,
      };

      const nextRow = taskToRow(next);
      const result = this.#db
        .prepare(
          `UPDATE tasks SET
              status = @status, provider_session_id = @provider_session_id,
              result_json = @result_json, error_json = @error_json, workspace_json = @workspace_json,
              title = @title, metadata_json = @metadata_json, revision = @revision,
              updated_at = @updated_at, started_at = @started_at, finished_at = @finished_at
           WHERE id = @id AND revision = @expected_revision`,
        )
        .run({ ...nextRow, expected_revision: input.expectedRevision });

      if (result.changes !== 1) {
        // Should be unreachable given the revision check above, but guards against races.
        throw new ConflictError(`Task ${id} was modified concurrently`, {
          details: { taskId: id },
        });
      }

      const events = this.#appendEventsInTx(id, input.events ?? []);
      return { task: next, events };
    });

    return tx();
  }

  // ── Events ───────────────────────────────────────────────────────────────

  async appendEvents(id: TaskId, events: NewTaskEvent[]): Promise<TaskEvent[]> {
    if (events.length === 0) return [];
    const tx = this.#db.transaction((): TaskEvent[] => {
      this.#assertTaskExists(id);
      return this.#appendEventsInTx(id, events);
    });
    return tx();
  }

  async getEvents(id: TaskId, opts: GetEventsOptions = {}): Promise<TaskEvent[]> {
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const params: unknown[] = [id];
    let sql = 'SELECT * FROM task_events WHERE task_id = ?';
    if (opts.afterSeq !== undefined) {
      sql += ' AND seq > ?';
      params.push(opts.afterSeq);
    }
    sql += ` ORDER BY seq ${order}`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = this.#db.prepare(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  async latestSeq(id: TaskId): Promise<number> {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events WHERE task_id = ?')
      .get(id) as { seq: number };
    return row.seq;
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  async createApproval(approval: ApprovalRequest): Promise<ApprovalRequest> {
    const parsed = ApprovalRequest.parse(approval);
    this.#assertTaskExists(parsed.taskId as TaskId);
    this.#db
      .prepare(
        `INSERT INTO approvals (
            id, task_id, kind, summary, detail_json, provider_token, status,
            created_at, resolved_at, decision, note
         ) VALUES (@id, @task_id, @kind, @summary, @detail_json, @provider_token, @status,
            @created_at, @resolved_at, @decision, @note)`,
      )
      .run({
        id: parsed.id,
        task_id: parsed.taskId,
        kind: parsed.kind,
        summary: parsed.summary,
        detail_json: JSON.stringify(parsed.detail),
        provider_token: parsed.providerToken,
        status: parsed.status,
        created_at: parsed.createdAt,
        resolved_at: parsed.resolvedAt ?? null,
        decision: parsed.decision ?? null,
        note: parsed.note ?? null,
      });
    return parsed;
  }

  async getApproval(id: ApprovalId): Promise<ApprovalRequest | null> {
    const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row ? rowToApproval(row) : null;
  }

  async listApprovals(
    taskId: TaskId,
    opts: { pendingOnly?: boolean } = {},
  ): Promise<ApprovalRequest[]> {
    const sql = opts.pendingOnly
      ? "SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC"
      : 'SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC';
    const rows = this.#db.prepare(sql).all(taskId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async resolveApproval(
    id: ApprovalId,
    decision: ApprovalDecision,
    opts: { note?: string; at?: string } = {},
  ): Promise<ApprovalRequest> {
    const at = opts.at ?? this.#clock.isoNow();
    const status = decision === 'approved' ? 'approved' : 'denied';
    const result = this.#db
      .prepare(
        `UPDATE approvals SET status = ?, decision = ?, resolved_at = ?, note = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decision, at, opts.note ?? null, id);
    if (result.changes !== 1) {
      const existing = await this.getApproval(id);
      if (!existing) throw new NotFoundError(`Approval ${id} not found`);
      throw new ConflictError(`Approval ${id} is already ${existing.status}`, {
        details: { approvalId: id, status: existing.status },
      });
    }
    const updated = await this.getApproval(id);
    if (!updated) throw new NotFoundError(`Approval ${id} not found`);
    return updated;
  }

  async expireApproval(id: ApprovalId, at?: string): Promise<ApprovalRequest> {
    const when = at ?? this.#clock.isoNow();
    this.#db
      .prepare(
        `UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(when, id);
    const updated = await this.getApproval(id);
    if (!updated) throw new NotFoundError(`Approval ${id} not found`);
    return updated;
  }

  // ── Artifacts ──────────────────────────────────────────────────────────────

  async putArtifact(artifact: Artifact): Promise<Artifact> {
    this.#assertTaskExists(artifact.taskId as TaskId);
    this.#db
      .prepare(
        `INSERT INTO artifacts (
            id, task_id, kind, name, content_type, size_bytes, content, path, sha256, created_at
         ) VALUES (@id, @task_id, @kind, @name, @content_type, @size_bytes, @content, @path, @sha256, @created_at)`,
      )
      .run({
        id: artifact.id,
        task_id: artifact.taskId,
        kind: artifact.kind,
        name: artifact.name,
        content_type: artifact.contentType,
        size_bytes: artifact.sizeBytes,
        content: artifact.content ?? null,
        path: artifact.path ?? null,
        sha256: artifact.sha256 ?? null,
        created_at: artifact.createdAt,
      });
    return artifact;
  }

  async getArtifact(id: ArtifactId): Promise<Artifact | null> {
    const row = this.#db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtifactRow
      | undefined;
    return row ? rowToArtifact(row) : null;
  }

  async listArtifacts(taskId: TaskId): Promise<Artifact[]> {
    const rows = this.#db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  async findActiveTasks(): Promise<Task[]> {
    const active: TaskStatus[] = ['provisioning', 'running', 'awaiting_approval', 'cancelling'];
    const placeholders = active.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...active) as TaskRow[];
    return rows.map(rowToTask).filter((t) => isActive(t.status));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #assertTaskExists(id: TaskId): void {
    const row = this.#db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`Task ${id} not found`, { details: { taskId: id } });
  }

  /** Append events assuming an open transaction; assigns contiguous seq numbers. */
  #appendEventsInTx(id: TaskId, events: NewTaskEvent[]): TaskEvent[] {
    if (events.length === 0) return [];
    const startRow = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events WHERE task_id = ?')
      .get(id) as { seq: number };
    let seq = startRow.seq;
    const at = this.#clock.isoNow();
    const insert = this.#db.prepare(
      `INSERT INTO task_events (id, task_id, seq, at, type, data_json)
       VALUES (@id, @task_id, @seq, @at, @type, @data_json)`,
    );
    const out: TaskEvent[] = [];
    for (const raw of events) {
      const data = TaskEventData.parse(raw);
      seq += 1;
      const eventId = newEventId();
      insert.run({
        id: eventId,
        task_id: id,
        seq,
        at,
        type: data.type,
        data_json: JSON.stringify(data),
      });
      out.push({ id: eventId, taskId: id, seq, at, ...data } as TaskEvent);
    }
    return out;
  }

  #buildTaskQuery(
    select: string,
    filter: TaskFilter,
    withPaging: boolean,
  ): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.status && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.providerId) {
      clauses.push('provider_id = ?');
      params.push(filter.providerId);
    }
    if (filter.titleContains) {
      clauses.push('LOWER(title) LIKE ?');
      params.push(`%${filter.titleContains.toLowerCase()}%`);
    }

    let sql = `${select} FROM tasks`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;

    if (withPaging) {
      const order = filter.order === 'asc' ? 'ASC' : 'DESC';
      sql += ` ORDER BY created_at ${order}, id ${order}`;
      if (filter.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
        if (filter.offset !== undefined) {
          sql += ' OFFSET ?';
          params.push(filter.offset);
        }
      }
    }

    return { sql, params };
  }
}
