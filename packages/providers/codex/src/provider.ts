import {
  PROVIDER_SDK_CONTRACT_VERSION,
  type ApprovalDecision,
  type ApprovalKind,
  type Logger,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type SandboxLevel,
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
import { authStatusFromFilesystem, normalizeAuthStatus } from './auth.js';
import { mapCodexMsg } from './events.js';
import { JsonRpcEndpoint, type MessageTransport } from './json-rpc.js';
import { createCodexTransport } from './transport.js';
import {
  AddListenerResult,
  CodexEventNotification,
  EVENT_NOTIFICATION_PREFIX,
  METHODS,
  NewConversationResult,
  SERVER_REQUESTS,
} from './protocol.js';

export interface CodexProviderOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly config?: Record<string, unknown>;
  readonly logger: Logger;
  /** Injected transport (tests). Defaults to spawning the Codex App Server process. */
  readonly transportFactory?: () => MessageTransport;
}

interface Turn {
  readonly ctx: ProviderRunContext;
  readonly conversationId: string;
  resolve: (result: ProviderTurnResult) => void;
  settled: boolean;
  lastMessage: string | undefined;
  tokenUsage: TokenUsage | undefined;
  onAbort: () => void;
}

/**
 * The Codex provider adapter. Integrates with Codex through its official **App Server** (JSON-RPC over
 * stdio) — never terminal scraping or `codex exec`. It negotiates capabilities honestly, streams Codex
 * events into the neutral event model, routes approval requests back through the run context, maps
 * cancellation to `interruptConversation`, and reports auth status without ever reading the token.
 */
export class CodexProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'codex',
    displayName: 'OpenAI Codex',
    version: '0.1.0',
    protocolVersion: 'app-server-1',
    sdkVersion: PROVIDER_SDK_CONTRACT_VERSION,
  };

  readonly #options: CodexProviderOptions;
  readonly #logger: Logger;
  readonly #turns = new Map<string, Turn>();
  /** conversationId → subscriptionId from addConversationListener (required to receive events). */
  readonly #subscriptions = new Map<string, string>();
  #endpoint: JsonRpcEndpoint | undefined;
  #connecting: Promise<JsonRpcEndpoint> | undefined;

  constructor(options: CodexProviderOptions) {
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
      steering: false,
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
    // Prefer a live query if already connected; otherwise a cheap, token-free filesystem check.
    if (this.#endpoint) {
      try {
        const raw = await this.#endpoint.request(METHODS.getAuthStatus);
        return normalizeAuthStatus(raw);
      } catch (err) {
        this.#logger.debug({ err: String(err) }, 'getAuthStatus failed; falling back to filesystem');
      }
    }
    return authStatusFromFilesystem();
  }

  async startTask(input: ProviderStartInput, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled' };
    const endpoint = await this.#ensureConnected();

    const result = await endpoint.request(
      METHODS.newConversation,
      this.#sessionConfig(input, ctx),
    );
    const { conversationId } = NewConversationResult.parse(result);
    ctx.emit({ type: 'session', sessionId: conversationId });

    // REQUIRED: newConversation does NOT auto-subscribe — without this we receive zero events.
    await this.#ensureSubscribed(endpoint, conversationId);

    return this.#runTurn(endpoint, conversationId, input.prompt, ctx);
  }

  async continueTask(
    input: ProviderContinueInput,
    ctx: ProviderRunContext,
  ): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled', sessionId: input.sessionId };
    const endpoint = await this.#ensureConnected();
    ctx.emit({ type: 'session', sessionId: input.sessionId });
    await this.#ensureSubscribed(endpoint, input.sessionId);
    return this.#runTurn(endpoint, input.sessionId, input.prompt, ctx);
  }

  async dispose(): Promise<void> {
    const endpoint = this.#endpoint;
    if (endpoint) {
      for (const subscriptionId of this.#subscriptions.values()) {
        try {
          await endpoint.request(METHODS.removeConversationListener, { subscriptionId });
        } catch {
          /* best-effort */
        }
      }
    }
    this.#subscriptions.clear();
    endpoint?.close();
    this.#endpoint = undefined;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #sessionConfig(input: ProviderStartInput, ctx: ProviderRunContext): Record<string, unknown> {
    return {
      cwd: ctx.workspace.cwd,
      approvalPolicy: mapApprovalPolicy(ctx.policy.approvals),
      sandbox: mapSandbox(ctx.policy.sandbox),
      networkAccess: ctx.policy.network === 'enabled',
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
    // Events arrive as `codex/event/<msg_type>` notifications — match on the prefix.
    endpoint.onNotificationPrefix(EVENT_NOTIFICATION_PREFIX, (params) => this.#onEvent(params));
    endpoint.onRequest(SERVER_REQUESTS.execCommandApproval, (params) =>
      this.#onApprovalRequest('exec_command', params),
    );
    endpoint.onRequest(SERVER_REQUESTS.applyPatchApproval, (params) =>
      this.#onApprovalRequest('apply_patch', params),
    );
    transport.onClose(() => this.#onDisconnect());

    await endpoint.request(METHODS.initialize, {
      clientInfo: { name: 'multicode', version: this.descriptor.version },
    });
    return endpoint;
  }

  /** Subscribe to a conversation's event stream if not already subscribed. Required by the protocol. */
  async #ensureSubscribed(endpoint: JsonRpcEndpoint, conversationId: string): Promise<void> {
    if (this.#subscriptions.has(conversationId)) return;
    const result = await endpoint.request(METHODS.addConversationListener, { conversationId });
    const { subscriptionId } = AddListenerResult.parse(result);
    this.#subscriptions.set(conversationId, subscriptionId);
  }

  #onDisconnect(): void {
    this.#endpoint = undefined;
    this.#subscriptions.clear();
    for (const turn of [...this.#turns.values()]) {
      this.#settle(turn, {
        status: 'failed',
        sessionId: turn.conversationId,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Codex App Server disconnected' },
      });
    }
  }

  #runTurn(
    endpoint: JsonRpcEndpoint,
    conversationId: string,
    prompt: string,
    ctx: ProviderRunContext,
  ): Promise<ProviderTurnResult> {
    return new Promise<ProviderTurnResult>((resolve) => {
      const turn: Turn = {
        ctx,
        conversationId,
        resolve,
        settled: false,
        lastMessage: undefined,
        tokenUsage: undefined,
        onAbort: () => {},
      };
      turn.onAbort = () => {
        void endpoint.request(METHODS.interruptConversation, { conversationId }).catch(() => {});
        this.#settle(turn, { status: 'cancelled', sessionId: conversationId });
      };
      ctx.signal.addEventListener('abort', turn.onAbort, { once: true });
      this.#turns.set(conversationId, turn);

      endpoint
        .request(METHODS.sendUserMessage, {
          conversationId,
          items: [{ type: 'text', text: prompt }],
        })
        .catch((err) => {
          this.#settle(turn, {
            status: 'failed',
            sessionId: conversationId,
            error: { code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) },
          });
        });
    });
  }

  #onEvent(params: unknown): void {
    const parsed = CodexEventNotification.safeParse(params);
    if (!parsed.success) return;
    const { conversationId, msg } = parsed.data;
    const turn = conversationId ? this.#turns.get(conversationId) : this.#singleTurn();
    if (!turn) return;

    const interp = mapCodexMsg(msg);
    for (const event of interp.events) {
      if (event.type === 'token_usage') turn.tokenUsage = event.usage;
      if (event.type === 'message' && event.role === 'assistant') turn.lastMessage = event.text;
      turn.ctx.emit(event);
    }

    if (interp.control?.type === 'complete') {
      this.#settle(turn, {
        status: 'completed',
        sessionId: turn.conversationId,
        ...(interp.control.message ?? turn.lastMessage
          ? { summary: interp.control.message ?? turn.lastMessage! }
          : {}),
        ...(turn.tokenUsage ? { tokenUsage: turn.tokenUsage } : {}),
      });
    } else if (interp.control?.type === 'error') {
      this.#settle(turn, {
        status: 'failed',
        sessionId: turn.conversationId,
        error: { code: 'PROVIDER_ERROR', message: interp.control.message },
      });
    }
  }

  async #onApprovalRequest(kind: ApprovalKind, params: unknown): Promise<{ decision: string }> {
    const p = (params ?? {}) as Record<string, unknown>;
    const conversationId = typeof p['conversationId'] === 'string' ? p['conversationId'] : undefined;
    const turn = conversationId ? this.#turns.get(conversationId) : this.#singleTurn();
    if (!turn) return { decision: 'denied' };

    const callId = typeof p['callId'] === 'string' ? p['callId'] : `${kind}-${conversationId ?? 'x'}`;
    const summary =
      kind === 'exec_command'
        ? `Run command: ${describeCommand(p['command'])}`
        : 'Apply a file patch';
    const outcome = await turn.ctx.requestApproval({
      kind,
      summary,
      detail: p,
      providerToken: callId,
    });
    return { decision: mapDecision(outcome.decision) };
  }

  #singleTurn(): Turn | undefined {
    return this.#turns.size === 1 ? [...this.#turns.values()][0] : undefined;
  }

  #settle(turn: Turn, result: ProviderTurnResult): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.ctx.signal.removeEventListener('abort', turn.onAbort);
    this.#turns.delete(turn.conversationId);
    turn.resolve(result);
  }
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

/** Map Multicode's approval policy to Codex's. `auto` still asks Codex so the orchestrator can gate. */
export const mapApprovalPolicy = (policy: string): string => {
  switch (policy) {
    case 'never':
      return 'never';
    case 'on_failure':
      return 'on-failure';
    case 'on_request':
    case 'auto':
    default:
      return 'on-request';
  }
};

export const mapSandbox = (level: SandboxLevel): string => {
  switch (level) {
    case 'read_only':
      return 'read-only';
    case 'workspace_write':
      return 'workspace-write';
    case 'danger_full_access':
      return 'danger-full-access';
  }
};

export const mapDecision = (decision: ApprovalDecision): string =>
  decision === 'approved' ? 'approved' : 'denied';

const describeCommand = (command: unknown): string => {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.join(' ');
  return '(unknown)';
};
