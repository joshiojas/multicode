import {
  ApprovalRequest,
  Artifact,
  PersistenceError,
  Task,
  TaskEventSchema,
  asApprovalId,
  asArtifactId,
  asTaskId,
  type TaskEvent,
} from '@multicode/core';

/** Raw column shapes as returned by better-sqlite3. */
export interface TaskRow {
  id: string;
  provider_id: string;
  status: string;
  mode: string;
  prompt: string;
  title: string;
  policy_json: string;
  workspace_json: string;
  interactive: number;
  provider_session_id: string | null;
  result_json: string | null;
  error_json: string | null;
  metadata_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EventRow {
  id: string;
  task_id: string;
  seq: number;
  at: string;
  type: string;
  data_json: string;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  kind: string;
  summary: string;
  detail_json: string;
  provider_token: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  decision: string | null;
  note: string | null;
}

export interface ArtifactRow {
  id: string;
  task_id: string;
  kind: string;
  name: string;
  content_type: string;
  size_bytes: number;
  content: string | null;
  path: string | null;
  sha256: string | null;
  created_at: string;
}

const parseJson = (value: string, context: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new PersistenceError(`Corrupt JSON in ${context}`, { cause });
  }
};

/** Map a task row to a validated domain {@link Task}. Validation guards against corrupted rows. */
export const rowToTask = (row: TaskRow): Task => {
  const candidate = {
    id: row.id,
    providerId: row.provider_id,
    status: row.status,
    mode: row.mode,
    prompt: row.prompt,
    title: row.title,
    policy: parseJson(row.policy_json, 'tasks.policy_json'),
    workspace: parseJson(row.workspace_json, 'tasks.workspace_json'),
    interactive: row.interactive === 1,
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    ...(row.result_json ? { result: parseJson(row.result_json, 'tasks.result_json') } : {}),
    ...(row.error_json ? { error: parseJson(row.error_json, 'tasks.error_json') } : {}),
    metadata: parseJson(row.metadata_json, 'tasks.metadata_json'),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
  const parsed = Task.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistenceError(`Task row ${row.id} failed validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
};

/** Columns to persist for a task (mirrors {@link rowToTask}). */
export const taskToRow = (task: Task): TaskRow => ({
  id: task.id,
  provider_id: task.providerId,
  status: task.status,
  mode: task.mode,
  prompt: task.prompt,
  title: task.title,
  policy_json: JSON.stringify(task.policy),
  workspace_json: JSON.stringify(task.workspace),
  interactive: task.interactive ? 1 : 0,
  provider_session_id: task.providerSessionId ?? null,
  result_json: task.result ? JSON.stringify(task.result) : null,
  error_json: task.error ? JSON.stringify(task.error) : null,
  metadata_json: JSON.stringify(task.metadata ?? {}),
  revision: task.revision,
  created_at: task.createdAt,
  updated_at: task.updatedAt,
  started_at: task.startedAt ?? null,
  finished_at: task.finishedAt ?? null,
});

export const rowToEvent = (row: EventRow): TaskEvent => {
  const data = parseJson(row.data_json, 'task_events.data_json');
  const parsed = TaskEventSchema.safeParse({
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    at: row.at,
    ...(data as object),
  });
  if (!parsed.success) {
    throw new PersistenceError(`Event row ${row.id} failed validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
};

export const rowToApproval = (row: ApprovalRow): ApprovalRequest => {
  const candidate = {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    summary: row.summary,
    detail: parseJson(row.detail_json, 'approvals.detail_json'),
    providerToken: row.provider_token,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
  const parsed = ApprovalRequest.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistenceError(`Approval row ${row.id} failed validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
};

export const rowToArtifact = (row: ArtifactRow): Artifact => {
  const candidate = {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    ...(row.content !== null ? { content: row.content } : {}),
    ...(row.path !== null ? { path: row.path } : {}),
    ...(row.sha256 !== null ? { sha256: row.sha256 } : {}),
    createdAt: row.created_at,
  };
  const parsed = Artifact.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistenceError(`Artifact row ${row.id} failed validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
};

/** Branded-id coercions used by the store when reading user-supplied ids. */
export const ids = { asTaskId, asApprovalId, asArtifactId };
