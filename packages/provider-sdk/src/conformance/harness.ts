import {
  DEFAULT_POLICY,
  asTaskId,
  noopLogger,
  type ApprovalDecision,
  type ExecutionPolicy,
  type Logger,
} from '@multicode/core';
import type {
  ApprovalOutcome,
  ProviderApprovalRequest,
  ProviderRunContext,
} from '../adapter.js';
import type { ProviderEvent } from '../events.js';

export interface HarnessContext {
  readonly ctx: ProviderRunContext;
  readonly events: ProviderEvent[];
  readonly approvalRequests: ProviderApprovalRequest[];
  readonly controller: AbortController;
}

export interface HarnessOptions {
  readonly cwd: string;
  readonly root?: string;
  readonly policy?: Partial<ExecutionPolicy>;
  /** Decision returned for any approval the adapter requests. */
  readonly approvalDecision?: ApprovalDecision;
  /** Start with an already-aborted signal (for cancellation checks). */
  readonly preAborted?: boolean;
  readonly isGitRepo?: boolean;
  readonly logger?: Logger;
}

/** Build an in-memory {@link ProviderRunContext} that records everything an adapter does. */
export const makeRunContext = (options: HarnessOptions): HarnessContext => {
  const events: ProviderEvent[] = [];
  const approvalRequests: ProviderApprovalRequest[] = [];
  const controller = new AbortController();
  if (options.preAborted) controller.abort();

  const policy: ExecutionPolicy = { ...DEFAULT_POLICY, ...options.policy };

  const ctx: ProviderRunContext = {
    taskId: asTaskId('task_conformance'),
    workspace: {
      root: options.root ?? options.cwd,
      cwd: options.cwd,
      isGitRepo: options.isGitRepo ?? false,
    },
    policy,
    signal: controller.signal,
    logger: options.logger ?? noopLogger,
    emit: (event) => {
      events.push(event);
    },
    requestApproval: async (request): Promise<ApprovalOutcome> => {
      approvalRequests.push(request);
      return { decision: options.approvalDecision ?? 'approved' };
    },
  };

  return { ctx, events, approvalRequests, controller };
};
