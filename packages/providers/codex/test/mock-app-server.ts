import { JsonRpcEndpoint, type MessageTransport } from '@multicode/provider-codex';

/** A pair of in-memory transports wired to each other (simulates stdio between client and server). */
export const linkedTransports = (): [MessageTransport, MessageTransport] => {
  let aOnMsg: ((m: unknown) => void) | undefined;
  let bOnMsg: ((m: unknown) => void) | undefined;
  let aOnClose: (() => void) | undefined;
  let bOnClose: (() => void) | undefined;
  let closed = false;

  const deliver = (handler: ((m: unknown) => void) | undefined, m: unknown): void => {
    if (closed) return;
    queueMicrotask(() => handler?.(structuredClone(m)));
  };
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      aOnClose?.();
      bOnClose?.();
    });
  };

  const a: MessageTransport = {
    send: (m) => deliver(bOnMsg, m),
    onMessage: (h) => {
      aOnMsg = h;
    },
    onClose: (h) => {
      aOnClose = h;
    },
    close: closeBoth,
  };
  const b: MessageTransport = {
    send: (m) => deliver(aOnMsg, m),
    onMessage: (h) => {
      bOnMsg = h;
    },
    onClose: (h) => {
      bOnClose = h;
    },
    close: closeBoth,
  };
  return [a, b];
};

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MockOptions {
  /** Emit a stream_error instead of completing. */
  readonly failWith?: string;
  readonly authenticated?: boolean;
}

/**
 * An in-process fake of the Codex App Server that speaks the exact JSON-RPC contract the adapter
 * targets. It streams a representative event sequence, raises an approval request when the
 * conversation's approval policy asks for it, and completes the turn — enough to exercise the whole
 * adapter (and drive the shared conformance suite) with no real Codex process.
 */
export class MockCodexAppServer {
  readonly #endpoint: JsonRpcEndpoint;
  readonly #configs = new Map<string, Record<string, unknown>>();
  /** conversationIds the client has subscribed to via addConversationListener. */
  readonly #subscribed = new Set<string>();
  readonly #opts: MockOptions;
  #counter = 0;

  constructor(transport: MessageTransport, opts: MockOptions = {}) {
    this.#opts = opts;
    this.#endpoint = new JsonRpcEndpoint(transport);
    this.#endpoint.onRequest('initialize', () => ({ serverInfo: { name: 'mock-codex', version: '0' } }));
    this.#endpoint.onRequest('getAuthStatus', () => ({
      authenticated: this.#opts.authenticated ?? true,
      authMethod: 'chatgpt',
      account: 'user@example.com',
    }));
    this.#endpoint.onRequest('newConversation', (params) => {
      const conversationId = `conv-${(this.#counter += 1)}`;
      this.#configs.set(conversationId, (params ?? {}) as Record<string, unknown>);
      return { conversationId, rolloutPath: `/tmp/${conversationId}.jsonl` };
    });
    // Subscription is REQUIRED before events flow — mirror the real app-server.
    this.#endpoint.onRequest('addConversationListener', (params) => {
      const conversationId = String((params as Record<string, unknown>)?.['conversationId'] ?? '');
      this.#subscribed.add(conversationId);
      return { subscriptionId: `sub-${conversationId}` };
    });
    this.#endpoint.onRequest('removeConversationListener', () => ({}));
    this.#endpoint.onRequest('interruptConversation', () => ({ abortReason: 'interrupted' }));
    this.#endpoint.onRequest('sendUserMessage', (params) => {
      void this.#runTurn((params ?? {}) as Record<string, unknown>);
      return {};
    });
  }

  /** Conversation ids the client subscribed to (for test assertions). */
  get subscriptions(): string[] {
    return [...this.#subscribed];
  }

  /** Emit a streamed event exactly as the app-server does: method `codex/event/<type>`. */
  #emit(conversationId: string, msg: Record<string, unknown>): void {
    // The real server only delivers events to subscribed conversations.
    if (!this.#subscribed.has(conversationId)) return;
    const type = String(msg['type'] ?? 'unknown');
    this.#endpoint.notify(`codex/event/${type}`, { id: 'turn-1', conversationId, msg });
  }

  async #runTurn(params: Record<string, unknown>): Promise<void> {
    const conversationId = String(params['conversationId'] ?? '');
    const config = this.#configs.get(conversationId) ?? {};
    const approvalPolicy = String(config['approvalPolicy'] ?? 'never');
    const prompt = extractPrompt(params);

    this.#emit(conversationId, { type: 'task_started' });
    await tick();
    this.#emit(conversationId, { type: 'agent_reasoning', text: 'Considering the request.' });
    this.#emit(conversationId, {
      type: 'exec_command_begin',
      call_id: 'c1',
      command: ['pnpm', 'test'],
      cwd: config['cwd'],
    });
    this.#emit(conversationId, {
      type: 'exec_command_output_delta',
      call_id: 'c1',
      stream: 'stdout',
      chunk: Buffer.from('ok\n').toString('base64'), // real app-server base64-encodes chunks
    });
    await tick();

    if (approvalPolicy !== 'never') {
      // Ask the client to approve; proceed regardless of the answer.
      await this.#endpoint
        .request('execCommandApproval', {
          conversationId,
          callId: 'c1',
          command: ['pnpm', 'test'],
          cwd: config['cwd'],
        })
        .catch(() => ({ decision: 'denied' }));
    }

    this.#emit(conversationId, {
      type: 'exec_command_end',
      call_id: 'c1',
      exit_code: 0,
      duration: { secs: 0, nanos: 5_000_000 }, // serde Duration shape
    });

    if (this.#opts.failWith) {
      this.#emit(conversationId, { type: 'stream_error', message: this.#opts.failWith });
      return;
    }

    this.#emit(conversationId, {
      type: 'patch_apply_end',
      call_id: 'c1',
      success: true,
      changes: { 'CODEX_NOTES.md': { add: { content: 'notes\n' } } },
    });
    this.#emit(conversationId, { type: 'agent_message', message: `Done: ${prompt}` });
    this.#emit(conversationId, {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    });
    await tick();
    this.#emit(conversationId, { type: 'task_complete', last_agent_message: `Done: ${prompt}` });
  }
}

const extractPrompt = (params: Record<string, unknown>): string => {
  const items = params['items'];
  if (Array.isArray(items)) {
    const first = items.find((i) => i && typeof i === 'object' && 'text' in (i as object));
    if (first && typeof (first as { text?: unknown }).text === 'string') {
      return (first as { text: string }).text;
    }
  }
  return '';
};
