import {
  PROVIDER_SDK_CONTRACT_VERSION,
  type Logger,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type TokenUsage,
} from '@multicode/core';
import type {
  AuthStatus,
  ProviderAdapter,
  ProviderContinueInput,
  ProviderRunContext,
  ProviderStartInput,
  ProviderTurnResult,
} from '@multicode/provider-sdk';
import { authStatusFromFilesystem } from './auth.js';
import { mapV2Notification, V2_NOTIFICATION_METHODS } from './events-v2.js';
import { JsonRpcEndpoint } from './json-rpc.js';
import { mapApprovalPolicy, mapSandbox } from './provider.js';
import {
  AccountReadResult,
  METHODS_V2,
  SERVER_REQUESTS_V2,
  ThreadStartResult,
  TurnStartResult,
  V2_DECISIONS,
} from './protocol-v2.js';
import { createCodexTransport, type CodexConnectionOptions } from './transport.js';

export interface CodexV2Options extends CodexConnectionOptions {
  readonly config?: Record<string, unknown>;
}

interface V2Turn {
  readonly ctx: ProviderRunContext;
  readonly threadId: string;
  turnId: string | undefined;
  resolve: (result: ProviderTurnResult) => void;
  settled: boolean;
  lastMessage: string | undefined;
  tokenUsage: TokenUsage | undefined;
  onAbort: () => void;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' ? (o[k] as string) : undefined;
const textInput = (text: string) => [{ type: 'text', text, textElements: [] }];
const describeCommand = (command: unknown): string =>
  typeof command === 'string' ? command : Array.isArray(command) ? command.join(' ') : '(command)';

/**
 * The Codex provider over the **v2 "thread / turn / item" App Server protocol** (current Codex). A
 * thread is the session; each `turn/start` runs a turn whose items stream as notifications. Starting a
 * thread auto-subscribes this connection (no explicit listener call). Unlike v1, v2 supports mid-turn
 * **steering** (`turn/steer`).
 */
export class CodexV2Provider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'codex',
    displayName: 'OpenAI Codex',
    version: '0.1.0',
    protocolVersion: 'app-server-2',
    sdkVersion: PROVIDER_SDK_CONTRACT_VERSION,
  };

  readonly #options: CodexV2Options;
  readonly #logger: Logger;
  readonly #turns = new Map<string, V2Turn>();
  readonly #activeTurns = new Map<string, string>();
  readonly #threads = new Set<string>();
  #endpoint: JsonRpcEndpoint | undefined;
  #connecting: Promise<JsonRpcEndpoint> | undefined;

  constructor(options: CodexV2Options) {
    this.#options = options;
    this.#logger = options.logger;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const models = Array.isArray(this.#options.config?.['models'])
      ? (this.#options.config!['models'] as string[])
      : [];
    return {
      streaming: true,
      resume: true,
      steering: true, // v2 supports turn/steer
      approvals: true,
      cancellation: true,
      writeMode: true,
      readOnlyMode: true,
      artifacts: false,
      providerDiff: false,
      structuredResult: false,
      sandboxLevels: ['read_only', 'workspace_write', 'danger_full_access'],
      networkControl: true,
      models,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    if (this.#endpoint) {
      try {
        const raw = await this.#endpoint.request(METHODS_V2.accountRead, { refreshToken: false });
        return normalizeAccount(raw);
      } catch (err) {
        this.#logger.debug({ err: String(err) }, 'account/read failed; falling back to filesystem');
      }
    }
    return authStatusFromFilesystem();
  }

  async startTask(input: ProviderStartInput, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled' };
    const endpoint = await this.#ensureConnected();

    const result = await endpoint.request(METHODS_V2.threadStart, this.#threadConfig(input, ctx));
    const { thread } = ThreadStartResult.parse(result);
    this.#threads.add(thread.id);
    ctx.emit({ type: 'session', sessionId: thread.id });

    return this.#runTurn(endpoint, thread.id, input.prompt, ctx, input.model);
  }

  async continueTask(
    input: ProviderContinueInput,
    ctx: ProviderRunContext,
  ): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled', sessionId: input.sessionId };
    const endpoint = await this.#ensureConnected();
    ctx.emit({ type: 'session', sessionId: input.sessionId });
    return this.#runTurn(endpoint, input.sessionId, input.prompt, ctx, input.model);
  }

  async steerTask(sessionId: string, message: string): Promise<void> {
    const endpoint = this.#endpoint;
    const turnId = this.#activeTurns.get(sessionId);
    // Steering is best-effort: it only applies while a turn is active. No active turn → no-op.
    if (!endpoint || !turnId) return;
    await endpoint.request(METHODS_V2.turnSteer, {
      threadId: sessionId,
      input: textInput(message),
      expectedTurnId: turnId,
    });
  }

  async dispose(): Promise<void> {
    const endpoint = this.#endpoint;
    if (endpoint) {
      for (const threadId of this.#threads) {
        try {
          await endpoint.request(METHODS_V2.threadUnsubscribe, { threadId });
        } catch {
          /* best-effort */
        }
      }
    }
    this.#threads.clear();
    this.#activeTurns.clear();
    endpoint?.close();
    this.#endpoint = undefined;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #threadConfig(input: ProviderStartInput, ctx: ProviderRunContext): Record<string, unknown> {
    return {
      cwd: ctx.workspace.cwd,
      approvalPolicy: mapApprovalPolicy(ctx.policy.approvals),
      sandbox: mapSandbox(ctx.policy.sandbox),
      ...(input.model ? { model: input.model } : {}),
    };
  }

  async #ensureConnected(): Promise<JsonRpcEndpoint> {
    if (this.#endpoint) return this.#endpoint;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try {
      this.#endpoint = await this.#connecting;
      return this.#endpoint;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(): Promise<JsonRpcEndpoint> {
    const transport = createCodexTransport(this.#options);
    const endpoint = new JsonRpcEndpoint(transport);

    for (const method of V2_NOTIFICATION_METHODS) {
      endpoint.onNotification(method, (params) => this.#onNotification(method, params));
    }
    endpoint.onRequest(SERVER_REQUESTS_V2.execApproval, (params) =>
      this.#onApproval('exec_command', params),
    );
    endpoint.onRequest(SERVER_REQUESTS_V2.fileChangeApproval, (params) =>
      this.#onApproval('apply_patch', params),
    );
    transport.onClose(() => this.#onDisconnect());

    await endpoint.request(METHODS_V2.initialize, {
      clientInfo: { name: 'multicode', title: 'Multicode', version: this.descriptor.version },
    });
    endpoint.notify(METHODS_V2.initialized);
    return endpoint;
  }

  #onDisconnect(): void {
    this.#endpoint = undefined;
    this.#threads.clear();
    this.#activeTurns.clear();
    for (const turn of [...this.#turns.values()]) {
      this.#settle(turn, {
        status: 'failed',
        sessionId: turn.threadId,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Codex App Server disconnected' },
      });
    }
  }

  #runTurn(
    endpoint: JsonRpcEndpoint,
    threadId: string,
    prompt: string,
    ctx: ProviderRunContext,
    model?: string,
  ): Promise<ProviderTurnResult> {
    return new Promise<ProviderTurnResult>((resolve) => {
      const turn: V2Turn = {
        ctx,
        threadId,
        turnId: undefined,
        resolve,
        settled: false,
        lastMessage: undefined,
        tokenUsage: undefined,
        onAbort: () => {},
      };
      turn.onAbort = () => {
        const turnId = this.#activeTurns.get(threadId) ?? turn.turnId;
        if (turnId) {
          void endpoint.request(METHODS_V2.turnInterrupt, { threadId, turnId }).catch(() => {});
        }
        this.#settle(turn, { status: 'cancelled', sessionId: threadId });
      };
      ctx.signal.addEventListener('abort', turn.onAbort, { once: true });
      // Register BEFORE turn/start so early notifications (routed by threadId) are not dropped.
      this.#turns.set(threadId, turn);

      endpoint
        .request(METHODS_V2.turnStart, {
          threadId,
          input: textInput(prompt),
          ...(model ? { model } : {}),
        })
        .then((res) => {
          const parsed = TurnStartResult.parse(res);
          turn.turnId = parsed.turn.id;
          this.#activeTurns.set(threadId, parsed.turn.id);
        })
        .catch((err) => {
          this.#settle(turn, {
            status: 'failed',
            sessionId: threadId,
            error: { code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) },
          });
        });
    });
  }

  #onNotification(method: string, params: unknown): void {
    const p = rec(params);
    const threadId = str(p, 'threadId');
    const turn = threadId ? this.#turns.get(threadId) : this.#singleTurn();
    if (!turn) return;

    if (method === 'turn/started') {
      const id = str(rec(p['turn']), 'id');
      if (id) {
        turn.turnId = id;
        this.#activeTurns.set(turn.threadId, id);
      }
    }

    const interp = mapV2Notification(method, params);
    for (const event of interp.events) turn.ctx.emit(event);
    if (interp.lastMessage) turn.lastMessage = interp.lastMessage;
    if (interp.tokenUsage) turn.tokenUsage = interp.tokenUsage;

    if (interp.control?.type === 'complete') {
      this.#settle(turn, {
        status: 'completed',
        sessionId: turn.threadId,
        ...(turn.lastMessage ? { summary: turn.lastMessage } : {}),
        ...(turn.tokenUsage ? { tokenUsage: turn.tokenUsage } : {}),
      });
    } else if (interp.control?.type === 'cancelled') {
      this.#settle(turn, { status: 'cancelled', sessionId: turn.threadId });
    } else if (interp.control?.type === 'error') {
      this.#settle(turn, {
        status: 'failed',
        sessionId: turn.threadId,
        error: { code: 'PROVIDER_ERROR', message: interp.control.message },
      });
    }
  }

  async #onApproval(
    kind: 'exec_command' | 'apply_patch',
    params: unknown,
  ): Promise<{ decision: string }> {
    const p = rec(params);
    const threadId = str(p, 'threadId');
    const turn = threadId ? this.#turns.get(threadId) : this.#singleTurn();
    if (!turn) return { decision: V2_DECISIONS.denied };

    const token = str(p, 'itemId') ?? str(p, 'approvalId') ?? 'approval';
    const summary =
      kind === 'exec_command'
        ? `Run command: ${describeCommand(p['command'])}`
        : 'Apply a file patch';
    const outcome = await turn.ctx.requestApproval({ kind, summary, detail: p, providerToken: token });
    return {
      decision: outcome.decision === 'approved' ? V2_DECISIONS.approved : V2_DECISIONS.denied,
    };
  }

  #singleTurn(): V2Turn | undefined {
    return this.#turns.size === 1 ? [...this.#turns.values()][0] : undefined;
  }

  #settle(turn: V2Turn, result: ProviderTurnResult): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.ctx.signal.removeEventListener('abort', turn.onAbort);
    this.#turns.delete(turn.threadId);
    this.#activeTurns.delete(turn.threadId);
    turn.resolve(result);
  }
}

const normalizeAccount = (raw: unknown): AuthStatus => {
  const parsed = AccountReadResult.safeParse(raw);
  if (!parsed.success) return { authenticated: false, detail: 'Unrecognized account status.' };
  const account = parsed.data.account;
  if (!account) return { authenticated: false, detail: 'Not signed in to Codex.' };
  return {
    authenticated: true,
    method: account.type,
    ...(account.email ? { account: account.email } : {}),
  };
};
