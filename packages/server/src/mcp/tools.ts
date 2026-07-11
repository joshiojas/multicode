import {
  ApprovalDecision,
  type ExecutionLimits,
  NetworkPolicy,
  SandboxLevel,
  TaskMode,
  asApprovalId,
  asTaskId,
  type ExecutionPolicy,
  type Task,
} from '@multicode/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { guard, type ToolResult } from './errors.js';

/** Compact projection of a task for list/summary responses. */
const summarizeTask = (task: Task) => ({
  id: task.id,
  providerId: task.providerId,
  status: task.status,
  mode: task.mode,
  title: task.title,
  interactive: task.interactive,
  revision: task.revision,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
  hasResult: task.result !== undefined,
  changeConfirmed: task.result?.verification.changeConfirmed,
  error: task.error,
});

/**
 * Register the provider-neutral Multicode tool surface on an MCP server. Every input is validated by
 * Zod; every handler funnels through {@link guard} so failures become structured, safe tool errors
 * rather than protocol crashes. No tool branches on provider identity — capability negotiation happens
 * inside the orchestrator.
 */
export const registerTools = (server: McpServer, orchestrator: Orchestrator): void => {
  server.registerTool(
    'multicode_list_providers',
    {
      title: 'List providers',
      description:
        'List configured coding-agent providers and their negotiated capabilities and load status.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => guard(async () => ({ providers: orchestrator.listProviders() })),
  );

  server.registerTool(
    'multicode_start_task',
    {
      title: 'Start a coding task',
      description:
        'Delegate a software-engineering task to a provider. Read-only by default; write tasks run in an isolated Git worktree. Returns immediately with the task in a running state; poll multicode_get_task / multicode_get_events for progress.',
      inputSchema: {
        providerId: z.string().describe('Configured provider id, e.g. "codex".'),
        prompt: z.string().min(1).describe('The instruction for the agent.'),
        workspaceRoot: z.string().describe('Absolute path to an approved workspace root.'),
        mode: TaskMode.default('read_only').describe('read_only (default) or write.'),
        subdir: z.string().optional().describe('Optional sub-directory within the root to focus on.'),
        title: z.string().optional(),
        interactive: z
          .boolean()
          .default(false)
          .describe('Keep the session alive for continue/steer after the first turn.'),
        model: z.string().optional().describe('Requested model, if the provider advertises models.'),
        sandbox: SandboxLevel.optional().describe('Override the sandbox level.'),
        network: NetworkPolicy.optional().describe('Override the network policy.'),
        approvals: z
          .enum(['never', 'on_request', 'on_failure', 'auto'])
          .optional()
          .describe('Override the approval policy.'),
        timeoutMs: z.number().int().positive().optional().describe('Override the per-turn timeout.'),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const policy = buildPolicyOverride(orchestrator, args);
        const task = await orchestrator.startTask({
          providerId: args.providerId,
          prompt: args.prompt,
          workspaceRoot: args.workspaceRoot,
          mode: args.mode,
          interactive: args.interactive,
          ...(args.subdir ? { subdir: args.subdir } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(policy ? { policy } : {}),
          ...(args.metadata ? { metadata: args.metadata } : {}),
        });
        return { task: summarizeTask(task) };
      }),
  );

  server.registerTool(
    'multicode_get_task',
    {
      title: 'Get a task',
      description: 'Fetch a task with its full status, policy, workspace binding, and verified result.',
      inputSchema: { taskId: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => ({ task: await orchestrator.getTask(asTaskId(args.taskId)) })),
  );

  server.registerTool(
    'multicode_list_tasks',
    {
      title: 'List tasks',
      description: 'List and filter tasks (compact summaries).',
      inputSchema: {
        status: z.array(z.string()).optional(),
        providerId: z.string().optional(),
        titleContains: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const tasks = await orchestrator.listTasks({
          ...(args.status ? { status: args.status as Task['status'][] } : {}),
          ...(args.providerId ? { providerId: args.providerId as never } : {}),
          ...(args.titleContains ? { titleContains: args.titleContains } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.offset ? { offset: args.offset } : {}),
          ...(args.order ? { order: args.order } : {}),
        });
        return { tasks: tasks.map(summarizeTask), count: tasks.length };
      }),
  );

  server.registerTool(
    'multicode_get_events',
    {
      title: 'Get task events',
      description:
        'Page through a task\'s durable event log (streamed output, approvals, transitions). Use nextCursor to resume streaming after a disconnect.',
      inputSchema: {
        taskId: z.string(),
        afterSeq: z.number().int().nonnegative().optional().describe('Return events after this seq.'),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const events = await orchestrator.getEvents(asTaskId(args.taskId), {
          ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });
        const nextCursor = events.length > 0 ? events[events.length - 1]!.seq : (args.afterSeq ?? 0);
        return { events, nextCursor };
      }),
  );

  server.registerTool(
    'multicode_continue_task',
    {
      title: 'Continue a task',
      description: 'Send a follow-up message to a resumable, interactive task that is awaiting input.',
      inputSchema: { taskId: z.string(), prompt: z.string().min(1), model: z.string().optional() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const task = await orchestrator.continueTask(asTaskId(args.taskId), args.prompt, args.model);
        return { task: summarizeTask(task) };
      }),
  );

  server.registerTool(
    'multicode_steer_task',
    {
      title: 'Steer a task',
      description: 'Inject mid-flight guidance into a running task without restarting it.',
      inputSchema: { taskId: z.string(), message: z.string().min(1) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        await orchestrator.steerTask(asTaskId(args.taskId), args.message);
        return { ok: true };
      }),
  );

  server.registerTool(
    'multicode_respond_approval',
    {
      title: 'Respond to an approval',
      description: 'Approve or deny a pending provider approval request.',
      inputSchema: {
        approvalId: z.string(),
        decision: ApprovalDecision,
        note: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const approval = await orchestrator.respondApproval(
          asApprovalId(args.approvalId),
          args.decision,
          args.note,
        );
        return { approval };
      }),
  );

  server.registerTool(
    'multicode_cancel_task',
    {
      title: 'Cancel a task',
      description: 'Cooperatively cancel a task, hard-stopping after the configured grace period.',
      inputSchema: { taskId: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const task = await orchestrator.cancelTask(asTaskId(args.taskId));
        return { task: summarizeTask(task) };
      }),
  );

  server.registerTool(
    'multicode_get_diff',
    {
      title: 'Get a verified diff',
      description:
        "Return the ground-truth Git diff and change summary for a write task (derived by Multicode, not the agent's own claims).",
      inputSchema: { taskId: z.string(), includePatch: z.boolean().default(true) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const diff = await orchestrator.getDiff(asTaskId(args.taskId));
        if (!diff) return { diff: null };
        return args.includePatch ? diff : { summary: diff.summary };
      }),
  );

  server.registerTool(
    'multicode_get_artifacts',
    {
      title: 'Get task artifacts',
      description: 'List artifacts a task produced (diffs, logs, reports).',
      inputSchema: { taskId: z.string(), includeContent: z.boolean().default(false) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const artifacts = await orchestrator.getArtifacts(asTaskId(args.taskId));
        const projected = args.includeContent
          ? artifacts
          : artifacts.map(({ content: _content, ...rest }) => rest);
        return { artifacts: projected };
      }),
  );
};

/** Build an ExecutionPolicy override from the friendly, flat tool inputs (only if any are set). */
const buildPolicyOverride = (
  orchestrator: Orchestrator,
  args: {
    sandbox?: SandboxLevel | undefined;
    network?: NetworkPolicy | undefined;
    approvals?: ExecutionPolicy['approvals'] | undefined;
    timeoutMs?: number | undefined;
  },
): Partial<ExecutionPolicy> | undefined => {
  if (
    args.sandbox === undefined &&
    args.network === undefined &&
    args.approvals === undefined &&
    args.timeoutMs === undefined
  ) {
    return undefined;
  }
  const limits: ExecutionLimits | undefined =
    args.timeoutMs !== undefined
      ? { ...orchestrator.policyDefaults.limits, timeoutMs: args.timeoutMs }
      : undefined;
  return {
    ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
    ...(args.network !== undefined ? { network: args.network } : {}),
    ...(args.approvals !== undefined ? { approvals: args.approvals } : {}),
    ...(limits ? { limits } : {}),
  };
};
