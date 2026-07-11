#!/usr/bin/env node
import { Command } from 'commander';
import { isMulticodeError } from '@multicode/core';
import { printErr } from '../output.js';
import type { GlobalOptions } from '../config-loader.js';
import { runInit } from '../commands/init.js';
import { runServe } from '../commands/serve.js';
import { runDoctor } from '../commands/doctor.js';
import { runProviderList, runProviderLogin, runProviderStatus } from '../commands/provider.js';
import { runTaskDiff, runTaskEvents, runTaskGet, runTaskList } from '../commands/task.js';
import { runApprove } from '../commands/approve.js';
import { runConfigPath, runConfigShow, runConfigValidate } from '../commands/config.js';

const program = new Command();

program
  .name('multicode')
  .description('A model-agnostic MCP server for delegating coding tasks to external agents.')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to the Multicode config file')
  .option('--data-dir <path>', 'override the data directory');

const globals = (): GlobalOptions => {
  const o = program.opts<{ config?: string; dataDir?: string }>();
  return { ...(o.config ? { config: o.config } : {}), ...(o.dataDir ? { dataDir: o.dataDir } : {}) };
};

/** Run a command, translating errors into a clean message + exit code. */
const run = (fn: () => Promise<number>): void => {
  fn()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (isMulticodeError(err)) {
        printErr(`error [${err.code}]: ${err.message}`);
      } else {
        printErr(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exitCode = 1;
    });
};

program
  .command('init')
  .description('Create the data directory and a starter config.')
  .option('--force', 'overwrite an existing config')
  .action((opts: { force?: boolean }) => run(() => runInit({ ...globals(), ...(opts.force ? { force: true } : {}) })));

program
  .command('serve')
  .description('Run the MCP server (stdio by default).')
  .option('--transport <type>', 'transport: stdio or http')
  .action((opts: { transport?: 'stdio' | 'http' }) =>
    run(() => runServe({ ...globals(), ...(opts.transport ? { transport: opts.transport } : {}) })),
  );

program
  .command('doctor')
  .description('Diagnose the environment, configuration, and providers.')
  .option('--json', 'output JSON')
  .action((opts: { json?: boolean }) => run(() => runDoctor({ ...globals(), ...(opts.json ? { json: true } : {}) })));

const provider = program.command('provider').description('Manage and inspect providers.');
provider
  .command('list')
  .description('List configured providers and their status.')
  .option('--json', 'output JSON')
  .action((opts: { json?: boolean }) => run(() => runProviderList({ ...globals(), ...(opts.json ? { json: true } : {}) })));
provider
  .command('status <id>')
  .description('Show a provider\'s authentication status.')
  .option('--json', 'output JSON')
  .action((id: string, opts: { json?: boolean }) => run(() => runProviderStatus(id, { ...globals(), ...(opts.json ? { json: true } : {}) })));
provider
  .command('login <id>')
  .description('Log in to a provider using its own login flow.')
  .action((id: string) => run(() => runProviderLogin(id, globals())));

const task = program.command('task').description('Inspect tasks.');
task
  .command('list')
  .description('List tasks.')
  .option('--status <status>', 'filter by status')
  .option('--provider <id>', 'filter by provider')
  .option('--limit <n>', 'max rows')
  .option('--json', 'output JSON')
  .action((opts: Record<string, string | boolean>) => run(() => runTaskList({ ...globals(), ...opts } as never)));
task
  .command('get <id>')
  .description('Show a task in full.')
  .option('--json', 'output JSON')
  .action((id: string, opts: { json?: boolean }) => run(() => runTaskGet(id, { ...globals(), ...(opts.json ? { json: true } : {}) })));
task
  .command('events <id>')
  .description('Show a task\'s event log.')
  .option('--after <seq>', 'only events after this seq')
  .option('--limit <n>', 'max events')
  .option('--json', 'output JSON')
  .action((id: string, opts: Record<string, string | boolean>) => run(() => runTaskEvents(id, { ...globals(), ...opts } as never)));
task
  .command('diff <id>')
  .description('Show a task\'s verified diff.')
  .option('--json', 'output JSON')
  .action((id: string, opts: { json?: boolean }) => run(() => runTaskDiff(id, { ...globals(), ...(opts.json ? { json: true } : {}) })));

program
  .command('approve <approvalId>')
  .description('Approve (or deny) a pending approval.')
  .option('--deny', 'deny instead of approve')
  .option('--note <text>', 'attach a note')
  .action((approvalId: string, opts: { deny?: boolean; note?: string }) =>
    run(() => runApprove(approvalId, { ...globals(), ...(opts.deny ? { deny: true } : {}), ...(opts.note ? { note: opts.note } : {}) })),
  );

const config = program.command('config').description('Inspect and validate configuration.');
config.command('validate').description('Validate the config file.').action(() => run(() => runConfigValidate(globals())));
config.command('path').description('Print the resolved config path.').action(() => run(() => runConfigPath(globals())));
config.command('show').description('Print the effective config.').action(() => run(() => runConfigShow(globals())));

program.parseAsync(process.argv).catch((err) => {
  printErr(String(err));
  process.exitCode = 1;
});
