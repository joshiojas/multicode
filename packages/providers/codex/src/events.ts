import type { FileChangeType, TokenUsage } from '@multicode/core';
import type { ProviderEvent } from '@multicode/provider-sdk';
import { CODEX_EVENT_TYPES } from './protocol.js';

export interface CodexInterpretation {
  readonly events: ProviderEvent[];
  /** Turn-control signal derived from the event, if any. */
  readonly control?:
    | { type: 'complete'; message?: string }
    | { type: 'error'; message: string };
}

const str = (obj: Record<string, unknown>, key: string): string | undefined => {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
};
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Codex sends `exec_command_output_delta.chunk` base64-encoded; decode when it looks like base64. */
const decodeChunk = (raw: string): string => {
  if (raw.length === 0 || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) return raw;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return raw;
  }
};

/** Codex `duration` may be a number of ms or a serde `Duration` (`{ secs, nanos }`). */
const durationToMs = (v: unknown): number => {
  if (typeof v === 'number') return Math.round(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const secs = typeof o['secs'] === 'number' ? o['secs'] : 0;
    const nanos = typeof o['nanos'] === 'number' ? o['nanos'] : 0;
    return Math.round(secs * 1000 + nanos / 1e6);
  }
  return 0;
};

/** Map a Codex `FileChange` entry to a change type. */
const changeTypeOf = (change: unknown): FileChangeType => {
  if (change && typeof change === 'object') {
    const o = change as Record<string, unknown>;
    if ('add' in o) return 'added';
    if ('delete' in o) return 'deleted';
    if ('update' in o) return 'modified';
    const kind = str(o, 'type') ?? str(o, 'kind') ?? '';
    if (kind === 'add' || kind === 'added') return 'added';
    if (kind === 'delete' || kind === 'deleted') return 'deleted';
  }
  return 'modified';
};

/** Extract file paths from a `+++ b/<path>` header line in a unified diff. */
const pathsFromUnifiedDiff = (diff: string): Array<{ path: string; changeType: FileChangeType }> => {
  const out: Array<{ path: string; changeType: FileChangeType }> = [];
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus?.[1]) {
      const minus = lines[i - 1] ?? '';
      const changeType: FileChangeType = minus.includes('/dev/null') ? 'added' : 'modified';
      out.push({ path: plus[1], changeType });
    } else if (/^\+\+\+ \/dev\/null$/.test(line)) {
      const minus = /^--- a\/(.+)$/.exec(lines[i - 1] ?? '');
      if (minus?.[1]) out.push({ path: minus[1], changeType: 'deleted' });
    }
  }
  return out;
};

const extractTokenUsage = (msg: Record<string, unknown>): TokenUsage | undefined => {
  const info = (msg['info'] ?? msg) as Record<string, unknown>;
  const totals = (info['total_token_usage'] ?? info) as Record<string, unknown>;
  const input = numOrNull(totals['input_tokens']);
  const output = numOrNull(totals['output_tokens']);
  const total = numOrNull(totals['total_tokens']);
  if (input === null && output === null && total === null) return undefined;
  return {
    ...(input !== null ? { inputTokens: input } : {}),
    ...(output !== null ? { outputTokens: output } : {}),
    ...(total !== null ? { totalTokens: total } : {}),
  };
};

/**
 * Translate a Codex `msg` payload into provider-neutral events plus an optional turn-control signal.
 * Unknown event types produce no events (forward-compatible with newer Codex releases).
 */
export const mapCodexMsg = (msg: Record<string, unknown>): CodexInterpretation => {
  const type = str(msg, 'type');
  const T = CODEX_EVENT_TYPES;

  switch (type) {
    case T.agentMessage: {
      const text = str(msg, 'message') ?? str(msg, 'text') ?? '';
      return { events: text ? [{ type: 'message', role: 'assistant', text }] : [] };
    }
    case T.agentReasoning: {
      const text = str(msg, 'text') ?? str(msg, 'reasoning') ?? '';
      return { events: text ? [{ type: 'reasoning', text }] : [] };
    }
    case T.execBegin: {
      const command = str(msg, 'command') ?? (Array.isArray(msg['command']) ? (msg['command'] as string[]).join(' ') : '');
      return {
        events: [
          {
            type: 'command_started',
            command,
            ...(str(msg, 'cwd') ? { cwd: str(msg, 'cwd')! } : {}),
          },
        ],
      };
    }
    case T.execDelta: {
      // Codex sends the output chunk base64-encoded.
      const chunk = decodeChunk(str(msg, 'chunk') ?? str(msg, 'delta') ?? '');
      const stream = str(msg, 'stream') === 'stderr' ? 'stderr' : 'stdout';
      return { events: chunk ? [{ type: 'command_output', stream, chunk }] : [] };
    }
    case T.execEnd: {
      // exec_command_end has no `command` field; correlation to the begin event is by call_id.
      const command = str(msg, 'command') ?? str(msg, 'call_id') ?? '(exec)';
      return {
        events: [
          {
            type: 'command_exited',
            command,
            exitCode: numOrNull(msg['exit_code']),
            durationMs: durationToMs(msg['duration'] ?? msg['duration_ms']),
          },
        ],
      };
    }
    case T.turnDiff: {
      const diff = str(msg, 'unified_diff') ?? str(msg, 'diff') ?? '';
      return { events: pathsFromUnifiedDiff(diff).map((f) => ({ type: 'file_changed', ...f })) };
    }
    // Both begin and end carry the `changes` map depending on Codex version; handle either.
    case T.patchApplyBegin:
    case T.patchApplyEnd: {
      const changes = msg['changes'];
      if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
        return {
          events: Object.entries(changes as Record<string, unknown>).map(([path, change]) => ({
            type: 'file_changed',
            path,
            changeType: changeTypeOf(change),
          })),
        };
      }
      return { events: [] };
    }
    case T.tokenCount: {
      const usage = extractTokenUsage(msg);
      return { events: usage ? [{ type: 'token_usage', usage }] : [] };
    }
    case T.taskStarted:
      return { events: [{ type: 'notice', level: 'info', message: 'codex turn started' }] };
    case T.taskComplete: {
      const message = str(msg, 'last_agent_message');
      return { events: [], control: { type: 'complete', ...(message ? { message } : {}) } };
    }
    case T.error:
    case T.streamError: {
      const message = str(msg, 'message') ?? 'codex error';
      return { events: [{ type: 'notice', level: 'error', message }], control: { type: 'error', message } };
    }
    default:
      return { events: [] };
  }
};
