import { z } from 'zod';
import { ApprovalDecision, ApprovalKind } from './approvals.js';
import { FileChangeType } from './result.js';

/**
 * The durable, append-only event log of a task. Every meaningful thing that happens — a status change,
 * a chunk of provider output, a command exit, an approval — is one event. Events carry a per-task
 * monotonically increasing `seq` so clients can page and resume streaming deterministically after a
 * disconnect (`get_events(afterSeq)`).
 */
export const TaskEventEnvelope = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Per-task monotonically increasing sequence number, starting at 1. */
  seq: z.number().int().positive(),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

const noteLevel = z.enum(['info', 'warn', 'error']);

/** The typed payloads, discriminated on `type`. */
export const TaskEventData = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.created'),
    providerId: z.string(),
    mode: z.enum(['read_only', 'write']),
    /** Truncated preview of the prompt (full prompt lives on the task record). */
    promptPreview: z.string(),
  }),
  z.object({
    type: z.literal('status.changed'),
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('provider.message'),
    role: z.enum(['assistant', 'user', 'system']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('provider.reasoning'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('provider.tool_call'),
    name: z.string(),
    callId: z.string().optional(),
    argsSummary: z.string().optional(),
  }),
  z.object({
    type: z.literal('provider.tool_result'),
    name: z.string(),
    callId: z.string().optional(),
    ok: z.boolean(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('command.started'),
    command: z.string(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('command.output'),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal('command.exited'),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    killed: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('file.changed'),
    path: z.string(),
    changeType: FileChangeType,
  }),
  z.object({
    type: z.literal('approval.requested'),
    approvalId: z.string(),
    kind: ApprovalKind,
    summary: z.string(),
  }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: z.string(),
    decision: ApprovalDecision,
  }),
  z.object({
    type: z.literal('steering.sent'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('result.ready'),
    changeConfirmed: z.boolean(),
    summaryPreview: z.string(),
  }),
  z.object({
    type: z.literal('task.error'),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('note'),
    level: noteLevel.default('info'),
    message: z.string(),
  }),
]);
export type TaskEventData = z.infer<typeof TaskEventData>;

export const TaskEventSchema = z.intersection(TaskEventEnvelope, TaskEventData);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export type TaskEventType = TaskEventData['type'];

/** An event ready to be appended — the store assigns `id`, `seq`, and `at`. */
export type NewTaskEvent = TaskEventData;

/** Narrow a {@link TaskEvent} to a specific variant. */
export const isEventType = <T extends TaskEventType>(
  event: TaskEvent,
  type: T,
): event is TaskEvent & { type: T } => event.type === type;
