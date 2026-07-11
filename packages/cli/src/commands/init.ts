import { mkdirSync } from 'node:fs';
import { dataPaths, defaultDataDir } from '@multicode/core';
import {
  configExists,
  resolveConfigPath,
  saveConfig,
  starterConfig,
  type GlobalOptions,
} from '../config-loader.js';
import { print } from '../output.js';

export interface InitOptions extends GlobalOptions {
  readonly force?: boolean;
}

/** Create the data directory and a starter config (current dir as workspace root, Codex enabled). */
export const runInit = async (opts: InitOptions): Promise<number> => {
  const path = resolveConfigPath(opts);
  if (configExists(path) && !opts.force) {
    print(`Config already exists at ${path} (use --force to overwrite).`);
    return 0;
  }

  const dataDir = opts.dataDir ?? defaultDataDir();
  const config = starterConfig(process.cwd(), { dataDir });
  const paths = dataPaths(config.dataDir);
  for (const dir of [paths.root, paths.worktrees, paths.artifacts, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  saveConfig(path, config);

  print('Multicode initialized.');
  print('');
  print(`  config:     ${path}`);
  print(`  data dir:   ${config.dataDir}`);
  print(`  workspace:  ${config.workspaceRoots[0]}`);
  print(`  provider:   codex (enabled)`);
  print('');
  print('Next steps:');
  print('  1. Log in to a provider:   multicode provider login codex');
  print('  2. Check your setup:       multicode doctor');
  print('  3. Run the MCP server:     multicode serve');
  print('');
  print('Register with Claude Code:   claude mcp add multicode -- npx -y multicode serve');
  return 0;
};
