import type { Logger } from '@multicode/core';
import { ChildProcessTransport } from './child-transport.js';
import type { MessageTransport } from './json-rpc.js';

export interface CodexConnectionOptions {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly logger: Logger;
  /** Injected transport (tests). Defaults to spawning the Codex App Server process. */
  readonly transportFactory?: (() => MessageTransport) | undefined;
}

/**
 * Create the message transport to the Codex App Server — a spawned `codex app-server` child by default,
 * or an injected transport in tests. Shared by every protocol-version driver (v1, v2).
 */
export const createCodexTransport = (options: CodexConnectionOptions): MessageTransport => {
  if (options.transportFactory) return options.transportFactory();
  return new ChildProcessTransport({
    command: options.command ?? 'codex',
    args: options.args ?? ['app-server'],
    ...(options.env ? { env: options.env } : {}),
    logger: options.logger,
  });
};

/** Read the configured protocol version from adapter config (default: v2, current Codex). */
export const readProtocolVersion = (config: Record<string, unknown> | undefined): 'v1' | 'v2' => {
  const raw = config?.['protocol'];
  return raw === 'v1' ? 'v1' : 'v2';
};
