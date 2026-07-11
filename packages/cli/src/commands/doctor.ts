import { existsSync } from 'node:fs';
import { createLogger } from '@multicode/server';
import { isGitRepo, runCommand } from '@multicode/security';
import { loadConfig, createRegistry, resolveConfigPath, configExists, type GlobalOptions } from '../config-loader.js';
import { providerSpecsFromConfig } from '@multicode/server';
import { print, printJson } from '../output.js';

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  level: Level;
  detail: string;
}

const marker = (level: Level): string => (level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗');

/** Diagnose the environment and configuration; exit non-zero if anything critical fails. */
export const runDoctor = async (opts: GlobalOptions & { json?: boolean }): Promise<number> => {
  const checks: Check[] = [];

  // Node version
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'Node.js >= 20.10',
    level: major >= 20 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
  });

  // Git
  try {
    const git = await runCommand('git', ['--version'], { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 4096, env: { PATH: process.env['PATH'] ?? '' } });
    checks.push({ name: 'git available', level: git.exitCode === 0 ? 'ok' : 'fail', detail: git.stdout.trim() || 'not found' });
  } catch {
    checks.push({ name: 'git available', level: 'fail', detail: 'git not found on PATH' });
  }

  // Config
  const configPath = resolveConfigPath(opts);
  if (!configExists(configPath)) {
    checks.push({ name: 'config', level: 'fail', detail: `missing (${configPath}); run \`multicode init\`` });
    return report(checks, opts.json);
  }

  let config;
  try {
    config = loadConfig(opts);
    checks.push({ name: 'config valid', level: 'ok', detail: configPath });
  } catch (err) {
    checks.push({ name: 'config valid', level: 'fail', detail: err instanceof Error ? err.message : String(err) });
    return report(checks, opts.json);
  }

  // Data dir
  checks.push({
    name: 'data directory',
    level: existsSync(config.dataDir) ? 'ok' : 'warn',
    detail: config.dataDir + (existsSync(config.dataDir) ? '' : ' (will be created)'),
  });

  // Workspace roots
  if (config.workspaceRoots.length === 0) {
    checks.push({ name: 'workspace roots', level: 'warn', detail: 'none configured — no task can run' });
  }
  for (const root of config.workspaceRoots) {
    const exists = existsSync(root);
    const git = exists ? await isGitRepo(root) : false;
    checks.push({
      name: `workspace: ${root}`,
      level: exists ? 'ok' : 'fail',
      detail: exists ? (git ? 'git repository' : 'exists (not a git repo — write tasks need git)') : 'does not exist',
    });
  }

  // Providers
  const logger = createLogger({ level: 'error', pretty: false });
  const registry = createRegistry(logger);
  await registry.load(providerSpecsFromConfig(config));
  for (const info of registry.list()) {
    if (info.status === 'ready') {
      let auth = 'unknown';
      try {
        const status = await registry.get(info.id).authStatus();
        auth = status.authenticated ? `authenticated${status.account ? ` (${status.account})` : ''}` : 'not logged in';
      } catch {
        auth = 'auth status unavailable';
      }
      checks.push({ name: `provider: ${info.id}`, level: 'ok', detail: `ready — ${auth}` });
    } else if (info.status === 'disabled') {
      checks.push({ name: `provider: ${info.id}`, level: 'warn', detail: 'disabled' });
    } else {
      checks.push({ name: `provider: ${info.id}`, level: 'fail', detail: info.error?.message ?? 'failed to load' });
    }
  }

  await registry.dispose();
  return report(checks, opts.json);
};

const report = (checks: Check[], json?: boolean): number => {
  if (json) {
    printJson({ checks });
  } else {
    print('Multicode doctor\n');
    for (const c of checks) print(`  ${marker(c.level)} ${c.name.padEnd(32)} ${c.detail}`);
    print('');
  }
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
};
