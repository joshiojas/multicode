/**
 * `multicode` — the CLI and composition root. It is the only package that binds concrete providers
 * (registering Codex as a built-in) and wires the store, security, orchestrator, and transports
 * together. Programmatic embedders can reuse the exported helpers below.
 */
export {
  loadConfig,
  saveConfig,
  starterConfig,
  resolveConfigPath,
  configExists,
  createRegistry,
  type GlobalOptions,
} from './config-loader.js';

export { runInit } from './commands/init.js';
export { runServe } from './commands/serve.js';
export { runDoctor } from './commands/doctor.js';
export { runProviderList, runProviderStatus, runProviderLogin } from './commands/provider.js';
export { runTaskList, runTaskGet, runTaskEvents, runTaskDiff } from './commands/task.js';
export { runApprove } from './commands/approve.js';
export { runConfigValidate, runConfigPath, runConfigShow } from './commands/config.js';
