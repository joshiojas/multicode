/**
 * `@multicode/provider-codex` — the Codex provider adapter, integrated through the official Codex App
 * Server (JSON-RPC over stdio). Register it as a built-in via {@link createProvider}, or configure it as
 * a package provider.
 *
 * Two protocol generations are supported and selected by `config.protocol`:
 * - `v2` (default) — the current "thread / turn / item" protocol (Codex ≳ 0.106, incl. `main`).
 * - `v1` — the legacy "conversation" protocol (Codex ≲ 0.105).
 */
import type { ProviderFactory } from '@multicode/provider-sdk';
import { CodexProvider, type CodexProviderOptions } from './provider.js';
import { CodexV2Provider } from './provider-v2.js';
import { readProtocolVersion } from './transport.js';

/** The provider factory Multicode's registry calls. Dispatches on the configured protocol version. */
export const createProvider: ProviderFactory = (init) => {
  const config = (init.config ?? {}) as Record<string, unknown>;
  const options = {
    logger: init.logger,
    config,
    ...(init.command ? { command: init.command } : {}),
    ...(init.args ? { args: init.args } : {}),
    ...(init.env ? { env: init.env } : {}),
  };
  return readProtocolVersion(config) === 'v1'
    ? new CodexProvider(options)
    : new CodexV2Provider(options);
};

export default createProvider;

export { CodexProvider, type CodexProviderOptions } from './provider.js';
export { CodexV2Provider, type CodexV2Options } from './provider-v2.js';
export { mapApprovalPolicy, mapSandbox, mapDecision } from './provider.js';
export { mapCodexMsg } from './events.js';
export { mapV2Notification, V2_NOTIFICATION_METHODS } from './events-v2.js';
export { authStatusFromFilesystem, normalizeAuthStatus, codexHome } from './auth.js';
export { JsonRpcEndpoint, type MessageTransport } from './json-rpc.js';
export { ChildProcessTransport, type SpawnOptions } from './child-transport.js';
export { createCodexTransport, readProtocolVersion } from './transport.js';
export {
  METHODS,
  SERVER_REQUESTS,
  EVENT_NOTIFICATION_PREFIX,
  REVIEW_DECISIONS,
  CODEX_EVENT_TYPES,
} from './protocol.js';
export { METHODS_V2, SERVER_REQUESTS_V2, V2_DECISIONS } from './protocol-v2.js';

export type { CodexProviderOptions as ProviderOptions };
