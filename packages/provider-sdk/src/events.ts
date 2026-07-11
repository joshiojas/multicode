import type { FileChangeType, NewTaskEvent, TokenUsage } from '@multicode/core';

/**
 * The provider-observable events an adapter emits during a turn. This is deliberately a *subset* of
 * the durable {@link NewTaskEvent} space — lifecycle concerns (status changes, approvals, steering,
 * final result) are owned by the orchestrator, not the provider. Adapters translate their native
 * protocol into these neutral events; the orchestrator maps them onto the durable log.
 */
export type ProviderEvent =
  | { type: 'message'; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; name: string; callId?: string; argsSummary?: string }
  | { type: 'tool_result'; name: string; callId?: string; ok: boolean; summary?: string }
  | { type: 'command_started'; command: string; cwd?: string }
  | { type: 'command_output'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'command_exited'; command: string; exitCode: number | null; durationMs: number; killed?: boolean }
  | { type: 'file_changed'; path: string; changeType: FileChangeType }
  | { type: 'session'; sessionId: string }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Translate a {@link ProviderEvent} into a durable {@link NewTaskEvent}. Returns `null` for events the
 * orchestrator handles out of band (e.g. `session` and `token_usage`, which update the task record
 * rather than appending a log line).
 */
export const providerEventToTaskEvent = (event: ProviderEvent): NewTaskEvent | null => {
  switch (event.type) {
    case 'message':
      return { type: 'provider.message', role: event.role, text: event.text };
    case 'reasoning':
      return { type: 'provider.reasoning', text: event.text };
    case 'tool_call':
      return {
        type: 'provider.tool_call',
        name: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.argsSummary ? { argsSummary: event.argsSummary } : {}),
      };
    case 'tool_result':
      return {
        type: 'provider.tool_result',
        name: event.name,
        ok: event.ok,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
      };
    case 'command_started':
      return {
        type: 'command.started',
        command: event.command,
        ...(event.cwd ? { cwd: event.cwd } : {}),
      };
    case 'command_output':
      return { type: 'command.output', stream: event.stream, chunk: event.chunk };
    case 'command_exited':
      return {
        type: 'command.exited',
        command: event.command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        killed: event.killed ?? false,
      };
    case 'file_changed':
      return { type: 'file.changed', path: event.path, changeType: event.changeType };
    case 'notice':
      return { type: 'note', level: event.level, message: event.message };
    case 'session':
    case 'token_usage':
      return null;
  }
};
