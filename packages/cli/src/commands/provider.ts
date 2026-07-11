import { spawn } from 'node:child_process';
import { createLogger, providerSpecsFromConfig } from '@multicode/server';
import { loadConfig, createRegistry, type GlobalOptions } from '../config-loader.js';
import { print, printErr, printJson, table } from '../output.js';

const withRegistry = async (opts: GlobalOptions) => {
  const config = loadConfig(opts);
  const logger = createLogger({ level: 'error', pretty: false });
  const registry = createRegistry(logger);
  await registry.load(providerSpecsFromConfig(config));
  return { config, registry };
};

/** `multicode provider list` */
export const runProviderList = async (opts: GlobalOptions & { json?: boolean }): Promise<number> => {
  const { registry } = await withRegistry(opts);
  const infos = registry.list();
  if (opts.json) {
    printJson({ providers: infos });
  } else if (infos.length === 0) {
    print('No providers configured. Edit your config or run `multicode init`.');
  } else {
    const rows = infos.map((i) => [
      i.id,
      i.status,
      i.source,
      i.capabilities ? [i.capabilities.writeMode ? 'write' : 'read', i.capabilities.resume ? 'resume' : '', i.capabilities.approvals ? 'approvals' : ''].filter(Boolean).join(',') : '—',
      i.descriptor?.version ?? '—',
    ]);
    print(table(['ID', 'STATUS', 'SOURCE', 'CAPABILITIES', 'VERSION'], rows));
  }
  await registry.dispose();
  return infos.some((i) => i.status === 'failed') ? 1 : 0;
};

/** `multicode provider status <id>` */
export const runProviderStatus = async (id: string, opts: GlobalOptions & { json?: boolean }): Promise<number> => {
  const { registry } = await withRegistry(opts);
  if (!registry.has(id)) {
    printErr(`Provider "${id}" is not ready (${registry.info(id)?.status ?? 'not configured'}).`);
    await registry.dispose();
    return 1;
  }
  const status = await registry.get(id).authStatus();
  if (opts.json) printJson({ provider: id, auth: status });
  else {
    print(`Provider: ${id}`);
    print(`  authenticated: ${status.authenticated}`);
    if (status.method) print(`  method:        ${status.method}`);
    if (status.account) print(`  account:       ${status.account}`);
    if (status.detail) print(`  detail:        ${status.detail}`);
  }
  await registry.dispose();
  return status.authenticated ? 0 : 1;
};

/**
 * `multicode provider login <id>` — reuse the provider's own local login flow. For Codex this shells
 * out to `codex login`, whose device/browser flow handles credentials directly; Multicode never sees
 * or stores the token.
 */
export const runProviderLogin = async (id: string, opts: GlobalOptions): Promise<number> => {
  const { config } = await withRegistry(opts);
  const providerConfig = config.providers[id];
  if (!providerConfig) {
    printErr(`Provider "${id}" is not configured.`);
    return 1;
  }

  if (id === 'codex') {
    const command = providerConfig.command ?? 'codex';
    print(`Launching \`${command} login\` — follow its prompts. Multicode never reads the token.`);
    return spawnInherit(command, ['login']);
  }

  printErr(
    `Automatic login is not wired for provider "${id}". Use that provider's own login command, then re-run \`multicode provider status ${id}\`.`,
  );
  return 1;
};

const spawnInherit = (command: string, args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      printErr(`Failed to launch ${command}: ${String(err)}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
