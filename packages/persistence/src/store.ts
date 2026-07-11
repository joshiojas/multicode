import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  Artifact,
  ArtifactId,
  NewTaskEvent,
  ProviderId,
  Task,
  TaskEvent,
  TaskId,
  TaskResult,
  TaskStatus,
  WorkspaceBinding,
} from '@multicode/core';

/**
 * The durable persistence contract for Multicode.
 *
 * The interface is intentionally async so that a future non-embedded backend (e.g. PostgreSQL) can
 * satisfy it without changing callers. It deliberately exposes *atomic domain operations* rather than
 * a generic `transaction(fn)` escape hatch — the latter cannot be made both async-friendly and
 * atomic. Every method that mutates more than one row (`applyTransition`, `appendEvents`,
 * `createTask`) is atomic within the implementation.
 */
export interface Store {
  /** Apply all pending migrations. Safe to call repeatedly. */
  migrate(): Promise<void>;
  /** Release resources. */
  close(): Promise<void>;

  // ── Tasks ────────────────────────────────────────────────────────────────
  createTask(task: Task): Promise<Task>;
  getTask(id: TaskId): Promise<Task | null>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  countTasks(filter?: TaskFilter): Promise<number>;

  /**
   * Atomically transition a task: verify the optimistic-concurrency `expectedRevision`, validate the
   * state-machine edge (when a status change is requested), apply the field patch, bump the revision,
   * and append any events — all in one transaction. Throws {@link ConflictError} on revision mismatch
   * and {@link StateTransitionError} on an illegal edge.
   */
  applyTransition(id: TaskId, input: TransitionInput): Promise<TransitionResult>;

  // ── Events ───────────────────────────────────────────────────────────────
  /** Append events, assigning contiguous per-task sequence numbers atomically. */
  appendEvents(id: TaskId, events: NewTaskEvent[]): Promise<TaskEvent[]>;
  /** Read events in ascending `seq` order, optionally after a cursor and/or limited. */
  getEvents(id: TaskId, opts?: GetEventsOptions): Promise<TaskEvent[]>;
  /** The highest `seq` persisted for a task (0 if none). */
  latestSeq(id: TaskId): Promise<number>;

  // ── Approvals ──────────────────────────────────────────────────────────────
  createApproval(approval: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(id: ApprovalId): Promise<ApprovalRequest | null>;
  listApprovals(taskId: TaskId, opts?: { pendingOnly?: boolean }): Promise<ApprovalRequest[]>;
  /** Atomically resolve a pending approval; throws {@link ConflictError} if already resolved. */
  resolveApproval(
    id: ApprovalId,
    decision: ApprovalDecision,
    opts?: { note?: string; at?: string },
  ): Promise<ApprovalRequest>;
  /** Mark a pending approval expired (used by recovery / timeout). */
  expireApproval(id: ApprovalId, at?: string): Promise<ApprovalRequest>;

  // ── Artifacts ──────────────────────────────────────────────────────────────
  putArtifact(artifact: Artifact): Promise<Artifact>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  listArtifacts(taskId: TaskId): Promise<Artifact[]>;

  // ── Recovery ───────────────────────────────────────────────────────────────
  /** Tasks found in an active (process-live) state — candidates for boot-time reconciliation. */
  findActiveTasks(): Promise<Task[]>;
}

export interface TaskFilter {
  status?: readonly TaskStatus[];
  providerId?: ProviderId;
  /** Substring match against the task title (case-insensitive). */
  titleContains?: string;
  limit?: number;
  offset?: number;
  /** Order by creation time. Defaults to `desc` (newest first). */
  order?: 'asc' | 'desc';
}

export interface GetEventsOptions {
  /** Return only events with `seq` strictly greater than this cursor. */
  afterSeq?: number;
  /** Maximum number of events to return. */
  limit?: number;
  /** `asc` (default) for streaming forward; `desc` for most-recent-first. */
  order?: 'asc' | 'desc';
}

/** Fields that a transition may update. Omitted fields are left unchanged. */
export interface TaskPatch {
  status?: TaskStatus;
  providerSessionId?: string;
  result?: TaskResult;
  error?: { code: string; message: string; retriable: boolean };
  workspace?: WorkspaceBinding;
  title?: string;
  metadata?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

export interface TransitionInput {
  /** The revision the caller last observed; the write fails if the row has since changed. */
  expectedRevision: number;
  patch?: TaskPatch;
  events?: NewTaskEvent[];
}

export interface TransitionResult {
  task: Task;
  /** The events appended as part of this transition (with assigned seq/id/at). */
  events: TaskEvent[];
}
