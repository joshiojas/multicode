import type { FileChangeType, TokenUsage } from '@multicode/core';
import type { ProviderEvent } from '@multicode/provider-sdk';

/**
 * Translation of Codex **v2 ("thread / turn / item")** server notifications into Multicode's neutral
 * event model. Unlike v1 (a single `codex/event/<type>` stream discriminated by `msg.type`), v2
 * notifications are distinguished by their **method name**, and streamed content flows through an item
 * lifecycle (`item/started` → deltas → `item/completed`). Verified against the `openai/codex`
 * `app-server-protocol` v2 schema.
 */
export interface V2Interpretation {
  readonly events: ProviderEvent[];
  /** Turn-control signal derived from `turn/completed` (or a fatal error). */
  readonly control?: { type: 'complete' } | { type: 'cancelled' } | { type: 'error'; message: string };
  /** The final assistant text, captured from a completed `agentMessage` item. */
  readonly lastMessage?: string;
  readonly tokenUsage?: TokenUsage;
}

/** The v2 notification methods this adapter subscribes to. */
export const V2_NOTIFICATION_METHODS = [
  'turn/started',
  'item/started',
  'item/completed',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'turn/diff/updated',
  'thread/tokenUsage/updated',
  'turn/completed',
  'error',
] as const;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' ? (o[k] as string) : undefined;
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const kindToType = (kind: unknown): FileChangeType => {
  const t = str(rec(kind), 'type');
  if (t === 'add') return 'added';
  if (t === 'delete') return 'deleted';
  if (t === 'update') return 'modified';
  return 'modified';
};

const changesToEvents = (changes: unknown): ProviderEvent[] => {
  if (!Array.isArray(changes)) return [];
  const out: ProviderEvent[] = [];
  for (const change of changes) {
    const c = rec(change);
    const path = str(c, 'path');
    if (path) out.push({ type: 'file_changed', path, changeType: kindToType(c['kind']) });
  }
  return out;
};

const tokenUsageFrom = (params: Record<string, unknown>): TokenUsage | undefined => {
  const total = rec(rec(params['tokenUsage'])['total']);
  const input = numOrNull(total['inputTokens']);
  const output = numOrNull(total['outputTokens']);
  const totalTokens = numOrNull(total['totalTokens']);
  if (input === null && output === null && totalTokens === null) return undefined;
  return {
    ...(input !== null ? { inputTokens: input } : {}),
    ...(output !== null ? { outputTokens: output } : {}),
    ...(totalTokens !== null ? { totalTokens } : {}),
  };
};

const mapItem = (item: Record<string, unknown>, phase: 'started' | 'completed'): V2Interpretation => {
  const type = str(item, 'type');
  switch (type) {
    case 'agentMessage': {
      if (phase !== 'completed') return { events: [] };
      const text = str(item, 'text') ?? '';
      return { events: text ? [{ type: 'message', role: 'assistant', text }] : [], ...(text ? { lastMessage: text } : {}) };
    }
    case 'reasoning': {
      if (phase !== 'completed') return { events: [] };
      const content = Array.isArray(item['content']) ? (item['content'] as unknown[]) : [];
      const summary = Array.isArray(item['summary']) ? (item['summary'] as unknown[]) : [];
      const text = [...content, ...summary].filter((x) => typeof x === 'string').join('\n');
      return { events: text ? [{ type: 'reasoning', text }] : [] };
    }
    case 'commandExecution': {
      const command = str(item, 'command') ?? '(exec)';
      if (phase === 'started') {
        return {
          events: [{ type: 'command_started', command, ...(str(item, 'cwd') ? { cwd: str(item, 'cwd')! } : {}) }],
        };
      }
      return {
        events: [
          {
            type: 'command_exited',
            command,
            exitCode: numOrNull(item['exitCode']),
            durationMs: numOrNull(item['durationMs']) ?? 0,
          },
        ],
      };
    }
    case 'fileChange': {
      if (phase !== 'completed') return { events: [] };
      return { events: changesToEvents(item['changes']) };
    }
    default:
      return { events: [] };
  }
};

/** Map a v2 server notification to neutral events + optional control/session signals. */
export const mapV2Notification = (method: string, rawParams: unknown): V2Interpretation => {
  const params = rec(rawParams);
  switch (method) {
    case 'item/started':
      return mapItem(rec(params['item']), 'started');
    case 'item/completed':
      return mapItem(rec(params['item']), 'completed');
    case 'item/commandExecution/outputDelta': {
      // In-turn command output delta is a plain string (the base64 stream is a different feature).
      const delta = str(params, 'delta') ?? '';
      return { events: delta ? [{ type: 'command_output', stream: 'stdout', chunk: delta }] : [] };
    }
    case 'item/fileChange/patchUpdated':
      // File list also arrives via item/completed(fileChange); skip here to avoid duplicates.
      return { events: [] };
    case 'thread/tokenUsage/updated': {
      const usage = tokenUsageFrom(params);
      return usage ? { events: [{ type: 'token_usage', usage }], tokenUsage: usage } : { events: [] };
    }
    case 'turn/started':
      return { events: [{ type: 'notice', level: 'info', message: 'codex turn started' }] };
    case 'turn/completed': {
      const turn = rec(params['turn']);
      const status = str(turn, 'status');
      if (status === 'interrupted') return { events: [], control: { type: 'cancelled' } };
      if (status === 'failed') {
        const message = str(rec(turn['error']), 'message') ?? 'codex turn failed';
        return { events: [], control: { type: 'error', message } };
      }
      return { events: [], control: { type: 'complete' } };
    }
    case 'error': {
      const message = str(rec(params['error']), 'message') ?? 'codex error';
      const willRetry = params['willRetry'] === true;
      // Transient errors (willRetry) don't end the turn; wait for turn/completed for the outcome.
      return { events: [{ type: 'notice', level: willRetry ? 'warn' : 'error', message }] };
    }
    default:
      return { events: [] };
  }
};
