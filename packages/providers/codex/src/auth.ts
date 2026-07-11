import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthStatus } from '@multicode/provider-sdk';
import { AuthStatusResult } from './protocol.js';

/** The Codex home directory (`$CODEX_HOME` or `~/.codex`). */
export const codexHome = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env['CODEX_HOME'];
  return configured && configured.length > 0 ? configured : join(homedir(), '.codex');
};

/**
 * Determine login status from the filesystem *without ever reading the credential*. We only check that
 * Codex's `auth.json` exists — its contents (the subscription token) are never opened, copied, or
 * persisted by Multicode.
 */
export const authStatusFromFilesystem = (env: NodeJS.ProcessEnv = process.env): AuthStatus => {
  const authFile = join(codexHome(env), 'auth.json');
  return existsSync(authFile)
    ? { authenticated: true, method: 'local', detail: 'Codex login present (token not read).' }
    : { authenticated: false, detail: 'Run `codex login` (or `multicode provider login codex`).' };
};

/** Normalize an App Server auth-status result into the neutral {@link AuthStatus} (no secrets). */
export const normalizeAuthStatus = (raw: unknown): AuthStatus => {
  const parsed = AuthStatusResult.safeParse(raw);
  if (!parsed.success) return { authenticated: false, detail: 'Unrecognized auth status.' };
  const r = parsed.data;
  const method = r.method ?? r.authMethod;
  const account = r.account ?? r.email;
  return {
    authenticated: r.authenticated ?? false,
    ...(method ? { method } : {}),
    ...(account ? { account } : {}),
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
  };
};
