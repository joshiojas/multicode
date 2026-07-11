import { z } from 'zod';

/** The kind of elevated action a provider is asking permission for. */
export const ApprovalKind = z.enum([
  'exec_command',
  'file_write',
  'network_access',
  'apply_patch',
  'other',
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalDecision = z.enum(['approved', 'denied']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/**
 * A provider's request to perform an action that policy does not auto-allow. Multicode surfaces this
 * to the MCP client and blocks the task until it is resolved (or expires).
 */
export const ApprovalRequest = z
  .object({
    id: z.string(),
    taskId: z.string(),
    kind: ApprovalKind,
    /** Human-readable summary of what is being requested. */
    summary: z.string(),
    /** Structured, provider-supplied detail (e.g. the exact command and cwd). Never contains secrets. */
    detail: z.record(z.unknown()).default({}),
    /** Opaque token the adapter uses to correlate the response back to the provider. */
    providerToken: z.string(),
    status: ApprovalStatus.default('pending'),
    createdAt: z.string(),
    resolvedAt: z.string().optional(),
    decision: ApprovalDecision.optional(),
    /** Optional operator-supplied note recorded with the decision. */
    note: z.string().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const isResolved = (a: Pick<ApprovalRequest, 'status'>): boolean =>
  a.status !== 'pending';
