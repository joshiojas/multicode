import {
  CancelledError,
  ConflictError,
  NotFoundError,
  ProviderError,
  StartTaskInput,
  ValidationError,
  asArtifactId,
  asTaskId,
  isTerminal,
  newApprovalId,
  newArtifactId,
  newTaskId,
  reconcileOnRecovery,
  systemClock,
  titleFromPrompt,
  toMulticodeError,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type Artifact,
  type Clock,
  type DiffSummary,
  type Logger,
  type MulticodeConfig,
  type NewTaskEvent,
  type Task,
  type TaskEvent,
  type TaskId,
  type TaskResult,
  type TaskStatus,
  type TokenUsage,
} from '@multicode/core';
import type { GetEventsOptions, Store, TaskFilter, TaskPatch } from '@multicode/persistence';
import {
  type WorkspaceGuard,
  type WorktreeManager,
  isGitRepo,
  headCommit,
  sha256,
  type WorktreeHandle,
} from '@multicode/security';
import { resolveExecutionPolicy, assertPolicyEnforceable } from '@multicode/security';
import {
  type ProviderRegistry,
  negotiateContinue,
  negotiateStart,
  negotiateSteer,
  providerEventToTaskEvent,
  type ApprovalOutcome,
  type ProviderApprovalRequest,
  type ProviderInfo,
  type ProviderRunContext,
  type ProviderTurnResult,
} from '@multicode/provider-sdk';
import { ApprovalCoordinator } from './approvals.js';
import { RunManager } from './run-manager.js';
import { buildVerification } from './verification.js';

export interface OrchestratorDeps {
  readonly store: Store;
  readonly registry: ProviderRegistry;
  readonly guard: WorkspaceGuard;
  readonly worktrees: WorktreeManager;
  readonly config: MulticodeConfig;
  readonly clock?: Clock;
  readonly logger: Logger;
}

/**
 * The provider-neutral engine that turns MCP requests into durable, verified task runs. It owns the
 * state machine transitions, event streaming, approval routing, cancellation/timeout, Git-based
 * verification, and worktree lifecycle — while delegating all provider-specific behavior to adapters
 * negotiated purely on declared capabilities.
 */
export class Orchestrator {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #guard: WorkspaceGuard;
  readonly #worktrees: WorktreeManager;
  readonly #config: MulticodeConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;

  readonly #runs = new RunManager();
  readonly #approvals = new ApprovalCoordinator();
  readonly #runPromises = new Map<TaskId, Promise<void>>();
  readonly #emitQueues = new Map<TaskId, Promise<void>>();
  readonly #activeApprovalCount = new Map<TaskId, number>();

  constructor(deps: OrchestratorDeps) {
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#guard = deps.guard;
    this.#worktrees = deps.worktrees;
    this.#config = deps.config;
    this.#clock = deps.clock ?? systemClock;
    this.#logger = deps.logger;
  }

  // ── Read APIs ──────────────────────────────────────────────────────────────

  /** The configured default execution limits/policy, exposed so callers can build partial overrides. */
  get policyDefaults(): MulticodeConfig['defaults'] {
    return this.#config.defaults;
  }

  listProviders(): ProviderInfo[] {
    return this.#registry.list();
  }

  async getTask(id: TaskId): Promise<Task> {
    const task = await this.#store.getTask(id);
    if (!task) throw new NotFoundError(`Task ${id} not found`, { details: { taskId: id } });
    return task;
  }

  listTasks(filter?: TaskFilter): Promise<Task[]> {
    return this.#store.listTasks(filter);
  }

  getEvents(id: TaskId, opts?: GetEventsOptions): Promise<TaskEvent[]> {
    return this.#store.getEvents(id, opts);
  }

  listApprovals(id: TaskId, pendingOnly = false): Promise<ApprovalRequest[]> {
    return this.#store.listApprovals(id, { pendingOnly });
  }

  getArtifacts(id: TaskId): Promise<Artifact[]> {
    return this.#store.listArtifacts(id);
  }

  /** Return the verified diff for a write task from its stored result (or recompute if worktree alive). */
  async getDiff(id: TaskId): Promise<{ summary: DiffSummary; patch?: string } | null> {
    const task = await this.getTask(id);
    if (task.mode !== 'write') return null;
    // Prefer the stored, tamper-evident diff.
    const stored = task.result?.verification.diff;
    if (stored) {
      const patchArtifactId = stored.patchArtifactId;
      let patch: string | undefined;
      if (patchArtifactId) {
        const artifact = await this.#store.getArtifact(asArtifactId(patchArtifactId));
        patch = artifact?.content;
      }
      return patch !== undefined ? { summary: stored, patch } : { summary: stored };
    }
    // Otherwise recompute live if the worktree still exists (interactive session mid-flight).
    if (task.workspace.worktreePath && task.workspace.baseRef) {
      const handle: WorktreeHandle = {
        path: task.workspace.worktreePath,
        branch: task.workspace.worktreeBranch ?? `multicode/${id}`,
        baseRef: task.workspace.baseRef,
      };
      const { summary, patch } = await this.#worktrees.diff(handle, {
        maxPatchBytes: task.policy.limits.maxOutputBytes,
      });
      return { summary, patch };
    }
    return null;
  }

  /** Await the in-flight run of a task, if any (used by tests and graceful shutdown). */
  async awaitTask(id: TaskId): Promise<Task> {
    const p = this.#runPromises.get(id);
    if (p) await p;
    return this.getTask(id);
  }

  // ── Lifecycle APIs ───────────────────────────────────────────────────────────

  async startTask(rawInput: unknown): Promise<Task> {
    const input = StartTaskInput.parse(rawInput);
    const caps = this.#registry.capabilitiesOf(input.providerId);

    // Capability + policy negotiation (no hardcoded provider checks).
    const effectiveApprovals = input.policy?.approvals ?? this.#config.defaults.approvals;
    const requireApprovals = effectiveApprovals === 'on_request' || effectiveApprovals === 'on_failure';
    negotiateStart(caps, { mode: input.mode, requireApprovals }, input.providerId);

    const root = this.#guard.resolveRoot(input.workspaceRoot);
    const policy = resolveExecutionPolicy({
      defaults: this.#config.defaults,
      override: input.policy,
      mode: input.mode,
    });
    assertPolicyEnforceable(policy, caps, input.providerId);

    const gitRepo = await isGitRepo(root);
    if (input.mode === 'write' && !gitRepo) {
      throw new ValidationError('Write tasks require the workspace root to be a Git repository', {
        details: { workspaceRoot: root },
      });
    }

    const now = this.#clock.isoNow();
    const id = newTaskId();
    const task: Task = {
      id,
      providerId: input.providerId,
      status: 'pending',
      mode: input.mode,
      prompt: input.prompt,
      title: input.title ?? titleFromPrompt(input.prompt),
      policy,
      workspace: {
        root,
        ...(input.subdir ? { subdir: input.subdir } : {}),
        isGitRepo: gitRepo,
      },
      interactive: input.interactive,
      metadata: input.metadata ?? {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.#store.createTask(task);
    await this.#store.appendEvents(id, [
      {
        type: 'task.created',
        providerId: input.providerId,
        mode: input.mode,
        promptPreview: input.prompt.slice(0, 200),
      },
    ]);

    // Provision: transition to provisioning and, for write tasks, create the isolated worktree.
    await this.#transition(id, 'provisioning', {
      events: [{ type: 'status.changed', from: 'pending', to: 'provisioning' }],
    });

    let workspacePatch: TaskPatch['workspace'] | undefined;
    if (input.mode === 'write') {
      try {
        const baseRef = await headCommit(root);
        const handle = await this.#worktrees.create({ repoRoot: root, taskId: id, baseRef });
        workspacePatch = {
          ...task.workspace,
          worktreePath: handle.path,
          worktreeBranch: handle.branch,
          baseRef: handle.baseRef,
        };
      } catch (err) {
        await this.#fail(id, err);
        return this.getTask(id);
      }
    }

    // Enter running and launch the turn in the background.
    const model = input.model;
    await this.#transition(id, 'running', {
      patch: {
        startedAt: this.#clock.isoNow(),
        ...(workspacePatch ? { workspace: workspacePatch } : {}),
      },
      events: [{ type: 'status.changed', from: 'provisioning', to: 'running' }],
    });

    this.#launch(id, { kind: 'start', prompt: input.prompt, model });
    return this.getTask(id);
  }

  async continueTask(id: TaskId, prompt: string, model?: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== 'awaiting_input') {
      throw new ConflictError(`Task ${id} is not awaiting input (status: ${task.status})`, {
        details: { taskId: id, status: task.status },
      });
    }
    negotiateContinue(this.#registry.capabilitiesOf(task.providerId), task.providerId);
    if (!task.providerSessionId) {
      throw new ValidationError(`Task ${id} has no provider session to continue`);
    }
    await this.#transition(id, 'running', {
      patch: { startedAt: this.#clock.isoNow() },
      events: [
        { type: 'status.changed', from: 'awaiting_input', to: 'running' },
        { type: 'provider.message', role: 'user', text: prompt },
      ],
    });
    this.#launch(id, { kind: 'continue', prompt, sessionId: task.providerSessionId, model });
    return this.getTask(id);
  }

  async steerTask(id: TaskId, message: string): Promise<void> {
    const task = await this.getTask(id);
    negotiateSteer(this.#registry.capabilitiesOf(task.providerId), task.providerId);
    if (task.status !== 'running') {
      throw new ConflictError(`Can only steer a running task (status: ${task.status})`);
    }
    const adapter = this.#registry.get(task.providerId);
    if (!adapter.steerTask || !task.providerSessionId) {
      throw new ValidationError(`Task ${id} cannot be steered right now`);
    }
    await adapter.steerTask(task.providerSessionId, message);
    await this.#store.appendEvents(id, [{ type: 'steering.sent', text: message }]);
  }

  async respondApproval(
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    note?: string,
  ): Promise<ApprovalRequest> {
    const approval = await this.#store.getApproval(approvalId);
    if (!approval) throw new NotFoundError(`Approval ${approvalId} not found`);
    const resolved = await this.#store.resolveApproval(approvalId, decision, note ? { note } : {});
    await this.#store.appendEvents(approval.taskId as TaskId, [
      { type: 'approval.resolved', approvalId, decision },
    ]);
    // Unblock the waiting adapter, if this process owns the run.
    this.#approvals.resolve(approvalId, { decision, ...(note ? { note } : {}) });
    return resolved;
  }

  async cancelTask(id: TaskId): Promise<Task> {
    const task = await this.getTask(id);
    if (isTerminal(task.status)) return task;

    if (task.status === 'awaiting_input') {
      // Finalize an idle interactive session.
      await this.#transition(id, 'cancelled', {
        patch: { finishedAt: this.#clock.isoNow() },
        events: [
          { type: 'status.changed', from: task.status, to: 'cancelled', reason: 'cancelled by user' },
        ],
      });
      await this.#cleanupWorktree(id);
      return this.getTask(id);
    }

    // Mark cancelling; the running turn observes the aborted signal and finalizes.
    await this.#transition(id, 'cancelling', {
      requireFrom: ['running', 'awaiting_approval', 'provisioning', 'pending'],
      events: [{ type: 'status.changed', from: task.status, to: 'cancelling', reason: 'cancel requested' }],
    });
    this.#approvals.rejectByTask(id, 'task cancelled');
    const wasRunning = this.#runs.cancel(id);
    if (!wasRunning) {
      // No in-flight run in this process (e.g. after restart) — finalize directly.
      await this.#transition(id, 'cancelled', {
        requireFrom: ['cancelling'],
        patch: { finishedAt: this.#clock.isoNow() },
        events: [{ type: 'status.changed', from: 'cancelling', to: 'cancelled' }],
      });
      await this.#cleanupWorktree(id);
    }
    return this.getTask(id);
  }

  /** Abort all in-flight runs and release resources (graceful shutdown). */
  async shutdown(): Promise<void> {
    this.#runs.cancelAll();
    await Promise.allSettled([...this.#runPromises.values()]);
    await this.#registry.dispose();
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  /** Reconcile tasks left active by a previous Multicode instance. See {@link RecoverySummary}. */
  async recover(): Promise<RecoverySummary> {
    const active = await this.#store.findActiveTasks();
    const summary: RecoverySummary = { inspected: active.length, recovered: [] };
    for (const task of active) {
      const taskId = asTaskId(task.id);
      const canResume =
        this.#registry.has(task.providerId) &&
        this.#registry.capabilitiesOf(task.providerId).resume &&
        Boolean(task.providerSessionId);
      const decision = reconcileOnRecovery(task.status, canResume);
      if (!decision) continue;
      const terminal = isTerminal(decision.to);
      await this.#transition(taskId, decision.to, {
        requireFrom: [task.status],
        patch: terminal ? { finishedAt: this.#clock.isoNow() } : {},
        events: [
          { type: 'note', level: 'warn', message: decision.reason },
          { type: 'status.changed', from: task.status, to: decision.to, reason: decision.reason },
        ],
      });
      if (terminal) await this.#cleanupWorktree(taskId);
      summary.recovered.push({ taskId, from: task.status, to: decision.to });
    }
    this.#logger.info({ recovery: summary }, 'recovery complete');
    return summary;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #launch(id: TaskId, turn: TurnInput): void {
    const promise = this.#runTurn(id, turn).finally(() => {
      this.#runPromises.delete(id);
    });
    this.#runPromises.set(id, promise);
  }

  async #runTurn(id: TaskId, turn: TurnInput): Promise<void> {
    const startSeq = await this.#store.latestSeq(id);
    let task: Task;
    try {
      task = await this.getTask(id);
    } catch (err) {
      this.#logger.error({ taskId: id, err: String(err) }, 'run: task vanished');
      return;
    }

    const adapter = this.#registry.get(task.providerId);
    const cwd = task.workspace.worktreePath ?? task.workspace.root;
    const signal = this.#runs.start(id, task.policy.limits.timeoutMs);

    let sessionId: string | undefined = task.providerSessionId;
    let tokenUsage: TokenUsage | undefined;

    const ctx: ProviderRunContext = {
      taskId: id,
      workspace: { root: task.workspace.root, cwd, isGitRepo: task.workspace.isGitRepo },
      policy: task.policy,
      signal,
      logger: this.#logger.child({ taskId: id }),
      emit: (event) => {
        if (event.type === 'session') sessionId = event.sessionId;
        if (event.type === 'token_usage') tokenUsage = event.usage;
        const te = providerEventToTaskEvent(event);
        if (te) this.#enqueueEvent(id, te);
      },
      requestApproval: (req) => this.#handleApproval(id, task.policy.approvals, req),
    };

    let result: ProviderTurnResult;
    try {
      result =
        turn.kind === 'start'
          ? await adapter.startTask({ prompt: turn.prompt, mode: task.mode, ...(turn.model ? { model: turn.model } : {}) }, ctx)
          : await adapter.continueTask!(
              { sessionId: turn.sessionId, prompt: turn.prompt, ...(turn.model ? { model: turn.model } : {}) },
              ctx,
            );
    } catch (err) {
      await this.#drainEvents(id);
      this.#runs.finish(id);
      const reason = this.#runs.abortReason(id);
      if (err instanceof CancelledError || reason) {
        await this.#finalizeCancelled(id, reason === 'timeout' ? 'timed_out' : 'cancelled');
      } else {
        await this.#fail(id, err);
      }
      return;
    }

    await this.#drainEvents(id);
    const reason = this.#runs.abortReason(id);
    this.#runs.finish(id);

    if (result.sessionId) sessionId = result.sessionId;
    if (result.tokenUsage) tokenUsage = result.tokenUsage;

    if (reason === 'timeout') {
      await this.#finalizeCancelled(id, 'timed_out');
      return;
    }
    if (reason === 'cancel' || result.status === 'cancelled') {
      await this.#finalizeCancelled(id, 'cancelled');
      return;
    }
    if (result.status === 'failed') {
      // The provider returns a structured { code, message }; preserve its message (a plain object
      // would otherwise be mangled into "Unknown error" by toMulticodeError).
      await this.#fail(id, new ProviderError(result.error?.message ?? 'provider failed'), sessionId);
      return;
    }

    await this.#finalizeSuccess(id, startSeq, result, sessionId, tokenUsage);
  }

  async #finalizeSuccess(
    id: TaskId,
    startSeq: number,
    result: ProviderTurnResult,
    sessionId: string | undefined,
    tokenUsage: TokenUsage | undefined,
  ): Promise<void> {
    const task = await this.getTask(id);
    const events = await this.#store.getEvents(id, { afterSeq: startSeq });

    let diff: DiffSummary | undefined;
    const artifactIds: string[] = [];
    if (task.mode === 'write' && task.workspace.worktreePath && task.workspace.baseRef) {
      try {
        const handle: WorktreeHandle = {
          path: task.workspace.worktreePath,
          branch: task.workspace.worktreeBranch ?? `multicode/${id}`,
          baseRef: task.workspace.baseRef,
        };
        const computed = await this.#worktrees.diff(handle, {
          maxPatchBytes: task.policy.limits.maxOutputBytes,
        });
        diff = computed.summary;
        if (computed.patch.length > 0) {
          const artifact = await this.#storePatchArtifact(id, computed.patch);
          artifactIds.push(artifact.id);
          diff = { ...computed.summary, patchArtifactId: artifact.id };
        }
      } catch (err) {
        this.#logger.warn({ taskId: id, err: String(err) }, 'diff computation failed');
      }
    }

    const verification = buildVerification({ diff, events, artifactIds });
    const taskResult: TaskResult = {
      summary: result.summary ?? '',
      verification,
      ...(result.structuredOutput ? { structuredOutput: result.structuredOutput } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(sessionId ? { providerSessionId: sessionId } : {}),
    };

    const canResume =
      task.interactive && this.#registry.capabilitiesOf(task.providerId).resume && Boolean(sessionId);
    const to: TaskStatus = canResume ? 'awaiting_input' : 'succeeded';
    const terminal = isTerminal(to);

    await this.#transition(id, to, {
      requireFrom: ['running'],
      patch: {
        result: taskResult,
        ...(sessionId ? { providerSessionId: sessionId } : {}),
        ...(terminal ? { finishedAt: this.#clock.isoNow() } : {}),
      },
      events: [
        {
          type: 'result.ready',
          changeConfirmed: verification.changeConfirmed,
          summaryPreview: (result.summary ?? '').slice(0, 200),
        },
        { type: 'status.changed', from: 'running', to },
      ],
    });

    if (terminal) await this.#cleanupWorktree(id);
  }

  async #finalizeCancelled(id: TaskId, to: 'cancelled' | 'timed_out'): Promise<void> {
    const task = await this.#store.getTask(id);
    if (!task || isTerminal(task.status)) return;
    await this.#transition(id, to, {
      requireFrom: ['running', 'cancelling', 'awaiting_approval'],
      patch: {
        finishedAt: this.#clock.isoNow(),
        ...(to === 'timed_out'
          ? { error: { code: 'TIMEOUT', message: 'task exceeded its timeout', retriable: true } }
          : {}),
      },
      events: [{ type: 'status.changed', from: task.status, to }],
    });
    await this.#cleanupWorktree(id);
  }

  async #fail(id: TaskId, err: unknown, sessionId?: string): Promise<void> {
    const error = toMulticodeError(err);
    const task = await this.#store.getTask(id);
    if (!task || isTerminal(task.status)) return;
    await this.#transition(id, 'failed', {
      requireFrom: ['running', 'provisioning', 'pending', 'cancelling', 'awaiting_approval'],
      patch: {
        finishedAt: this.#clock.isoNow(),
        error: { code: error.code, message: error.message, retriable: error.retriable },
        ...(sessionId ? { providerSessionId: sessionId } : {}),
      },
      events: [
        { type: 'task.error', code: error.code, message: error.message },
        { type: 'status.changed', from: task.status, to: 'failed', reason: error.message },
      ],
    });
    await this.#cleanupWorktree(id);
  }

  async #handleApproval(
    id: TaskId,
    policy: Task['policy']['approvals'],
    req: ProviderApprovalRequest,
  ): Promise<ApprovalOutcome> {
    if (policy === 'never') {
      await this.#recordApproval(id, req, 'denied');
      return { decision: 'denied', note: 'approval policy is "never"' };
    }
    if (policy === 'auto') {
      await this.#recordApproval(id, req, 'approved');
      return { decision: 'approved', note: 'auto-approved by policy' };
    }

    // on_request / on_failure: persist pending, park the task, and await a decision.
    const approvalId = newApprovalId();
    const now = this.#clock.isoNow();
    await this.#store.createApproval({
      id: approvalId,
      taskId: id,
      kind: req.kind,
      summary: req.summary,
      detail: req.detail ?? {},
      providerToken: req.providerToken,
      status: 'pending',
      createdAt: now,
    });
    await this.#store.appendEvents(id, [
      { type: 'approval.requested', approvalId, kind: req.kind, summary: req.summary },
    ]);

    const count = (this.#activeApprovalCount.get(id) ?? 0) + 1;
    this.#activeApprovalCount.set(id, count);
    if (count === 1) {
      await this.#transition(id, 'awaiting_approval', {
        requireFrom: ['running'],
        events: [{ type: 'status.changed', from: 'running', to: 'awaiting_approval' }],
      });
    }

    const promise = this.#approvals.register(approvalId, id);
    try {
      return await this.#awaitApproval(approvalId, promise);
    } finally {
      const remaining = (this.#activeApprovalCount.get(id) ?? 1) - 1;
      this.#activeApprovalCount.set(id, Math.max(0, remaining));
      if (remaining <= 0) {
        await this.#transition(id, 'running', {
          requireFrom: ['awaiting_approval'],
          events: [{ type: 'status.changed', from: 'awaiting_approval', to: 'running' }],
        }).catch(() => {
          /* task may be cancelling; leave the transition to the cancel path */
        });
      }
    }
  }

  /**
   * Await an approval decision from either the in-process coordinator (the MCP `respond_approval`
   * tool) or an out-of-band store update (the `multicode approve` CLI, possibly a different process).
   * Racing both lets approvals be resolved through whichever surface the operator uses.
   */
  async #awaitApproval(
    approvalId: ApprovalId,
    coordinatorPromise: Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const polled = new Promise<ApprovalOutcome>((resolve) => {
      timer = setInterval(() => {
        void this.#store
          .getApproval(approvalId)
          .then((a) => {
            if (a && a.status !== 'pending') {
              resolve({ decision: a.decision ?? 'denied', ...(a.note ? { note: a.note } : {}) });
            }
          })
          .catch(() => undefined);
      }, 750);
      timer.unref?.();
    });
    try {
      return await Promise.race([coordinatorPromise, polled]);
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  async #recordApproval(
    id: TaskId,
    req: ProviderApprovalRequest,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approvalId = newApprovalId();
    const now = this.#clock.isoNow();
    await this.#store.createApproval({
      id: approvalId,
      taskId: id,
      kind: req.kind,
      summary: req.summary,
      detail: req.detail ?? {},
      providerToken: req.providerToken,
      status: decision,
      createdAt: now,
      resolvedAt: now,
      decision,
    });
    await this.#store.appendEvents(id, [
      { type: 'approval.requested', approvalId, kind: req.kind, summary: req.summary },
      { type: 'approval.resolved', approvalId, decision },
    ]);
  }

  async #storePatchArtifact(id: TaskId, patch: string): Promise<Artifact> {
    const artifact: Artifact = {
      id: newArtifactId(),
      taskId: id,
      kind: 'diff',
      name: 'changes.diff',
      contentType: 'text/x-diff',
      sizeBytes: Buffer.byteLength(patch, 'utf8'),
      content: patch,
      sha256: sha256(patch),
      createdAt: this.#clock.isoNow(),
    };
    return this.#store.putArtifact(artifact);
  }

  async #cleanupWorktree(id: TaskId): Promise<void> {
    const task = await this.#store.getTask(id);
    if (!task || task.mode !== 'write' || !task.workspace.worktreePath) return;
    try {
      await this.#worktrees.remove(task.workspace.root, {
        path: task.workspace.worktreePath,
        branch: task.workspace.worktreeBranch ?? `multicode/${id}`,
        baseRef: task.workspace.baseRef ?? 'HEAD',
      });
    } catch (err) {
      this.#logger.warn({ taskId: id, err: String(err) }, 'worktree cleanup failed');
    }
  }

  #enqueueEvent(id: TaskId, event: NewTaskEvent): void {
    const prev = this.#emitQueues.get(id) ?? Promise.resolve();
    const next = prev
      .then(() => this.#store.appendEvents(id, [event]))
      .then(() => undefined)
      .catch((err) => {
        this.#logger.error({ taskId: id, err: String(err) }, 'event append failed');
      });
    this.#emitQueues.set(id, next);
  }

  async #drainEvents(id: TaskId): Promise<void> {
    const q = this.#emitQueues.get(id);
    if (q) await q;
    this.#emitQueues.delete(id);
  }

  /** Transition helper with optimistic-concurrency retry and optional source-state guard. */
  async #transition(
    id: TaskId,
    to: TaskStatus,
    opts: { patch?: TaskPatch; events?: NewTaskEvent[]; requireFrom?: readonly TaskStatus[] } = {},
  ): Promise<Task> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getTask(id);
      if (opts.requireFrom && !opts.requireFrom.includes(current.status)) {
        return current; // no-op: state moved on (e.g. a race with cancel)
      }
      if (current.status === to && !opts.patch && !opts.events) return current;
      try {
        const { task } = await this.#store.applyTransition(id, {
          expectedRevision: current.revision,
          patch: { status: to, ...(opts.patch ?? {}) },
          ...(opts.events ? { events: opts.events } : {}),
        });
        return task;
      } catch (err) {
        if (err instanceof ConflictError && attempt < 2) continue;
        throw err;
      }
    }
    return this.getTask(id);
  }
}

type TurnInput =
  | { kind: 'start'; prompt: string; model?: string | undefined }
  | { kind: 'continue'; prompt: string; sessionId: string; model?: string | undefined };

export interface RecoverySummary {
  inspected: number;
  recovered: Array<{ taskId: TaskId; from: TaskStatus; to: TaskStatus }>;
}
