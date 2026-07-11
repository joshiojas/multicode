import { JsonRpcEndpoint, type MessageTransport } from '@multicode/provider-codex';

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MockV2Options {
  readonly failWith?: string;
  readonly authenticated?: boolean;
}

/**
 * In-process fake of the Codex **v2 App Server** (thread / turn / item). Speaks the exact wire protocol
 * the adapter targets: `initialize` → `initialized` → `thread/start` (auto-subscribes) → `turn/start`,
 * then streams `turn/started` → `item/*` → `turn/completed`, raising an approval request when the
 * thread's approval policy asks for one. Verified against the `openai/codex` v2 schema.
 */
export class MockCodexV2Server {
  readonly #endpoint: JsonRpcEndpoint;
  readonly #threadConfigs = new Map<string, Record<string, unknown>>();
  readonly #opts: MockV2Options;
  #threadCounter = 0;
  #turnCounter = 0;
  readonly steers: string[] = [];

  constructor(transport: MessageTransport, opts: MockV2Options = {}) {
    this.#opts = opts;
    this.#endpoint = new JsonRpcEndpoint(transport);

    this.#endpoint.onRequest('initialize', () => ({
      userAgent: 'mock-codex/0',
      codexHome: '/tmp/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    }));
    this.#endpoint.onRequest('account/read', () => ({
      account: this.#opts.authenticated === false
        ? null
        : { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: false,
    }));
    this.#endpoint.onRequest('thread/start', (params) => {
      const id = `thread-${(this.#threadCounter += 1)}`;
      this.#threadConfigs.set(id, (params ?? {}) as Record<string, unknown>);
      return { thread: { id }, model: 'gpt-5-codex', cwd: '/repo', instructionSources: [] };
    });
    this.#endpoint.onRequest('turn/start', (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const turnId = `turn-${(this.#turnCounter += 1)}`;
      void this.#runTurn(String(p['threadId'] ?? ''), turnId, extractText(p));
      return { turn: { id: turnId, status: 'inProgress' } };
    });
    this.#endpoint.onRequest('turn/steer', (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      this.steers.push(extractText(p));
      return { turnId: String(p['expectedTurnId'] ?? '') };
    });
    this.#endpoint.onRequest('turn/interrupt', () => ({}));
    this.#endpoint.onRequest('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#endpoint.notify(method, params);
  }

  async #runTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const config = this.#threadConfigs.get(threadId) ?? {};
    const approvalPolicy = String(config['approvalPolicy'] ?? 'never');
    const base = { threadId, turnId };

    this.#notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    await tick();

    this.#notify('item/started', {
      ...base,
      startedAtMs: 0,
      item: { type: 'commandExecution', id: 'i1', command: 'pnpm test', cwd: config['cwd'], status: 'inProgress' },
    });
    this.#notify('item/commandExecution/outputDelta', { ...base, itemId: 'i1', delta: 'ok\n' });
    await tick();

    if (approvalPolicy !== 'never') {
      await this.#endpoint
        .request('item/commandExecution/requestApproval', {
          ...base,
          itemId: 'i1',
          startedAtMs: 0,
          command: 'pnpm test',
          cwd: config['cwd'],
        })
        .catch(() => ({ decision: 'decline' }));
    }

    this.#notify('item/completed', {
      ...base,
      completedAtMs: 1,
      item: { type: 'commandExecution', id: 'i1', command: 'pnpm test', exitCode: 0, durationMs: 5, status: 'completed' },
    });

    if (this.#opts.failWith) {
      this.#notify('error', { ...base, error: { message: this.#opts.failWith }, willRetry: false });
      this.#notify('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'failed', error: { message: this.#opts.failWith } },
      });
      return;
    }

    this.#notify('item/completed', {
      ...base,
      completedAtMs: 2,
      item: {
        type: 'fileChange',
        id: 'i2',
        status: 'completed',
        changes: [{ path: 'CODEX_NOTES.md', kind: { type: 'add' }, diff: '+notes\n' }],
      },
    });
    this.#notify('item/completed', {
      ...base,
      completedAtMs: 3,
      item: { type: 'agentMessage', id: 'i3', text: `Done: ${prompt}` },
    });
    this.#notify('thread/tokenUsage/updated', {
      ...base,
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: 200000,
      },
    });
    await tick();
    this.#notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
  }
}

const extractText = (params: Record<string, unknown>): string => {
  const input = params['input'];
  if (Array.isArray(input)) {
    const first = input.find((i) => i && typeof i === 'object' && 'text' in (i as object));
    if (first && typeof (first as { text?: unknown }).text === 'string') {
      return (first as { text: string }).text;
    }
  }
  return '';
};
