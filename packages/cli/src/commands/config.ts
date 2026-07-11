import { loadConfig, resolveConfigPath, type GlobalOptions } from '../config-loader.js';
import { print, printErr, printJson } from '../output.js';

/** `multicode config validate` — load and validate the configuration. */
export const runConfigValidate = async (opts: GlobalOptions): Promise<number> => {
  try {
    const config = loadConfig(opts);
    print(`✓ Config is valid (${resolveConfigPath(opts)}).`);
    print(`  workspace roots: ${config.workspaceRoots.length}`);
    print(`  providers:       ${Object.keys(config.providers).join(', ') || 'none'}`);
    print(`  transport:       ${config.transport.type}`);
    return 0;
  } catch (err) {
    printErr(`✗ ${err instanceof Error ? err.message : String(err)}`);
    if (err && typeof err === 'object' && 'details' in err) {
      printErr(JSON.stringify((err as { details: unknown }).details, null, 2));
    }
    return 1;
  }
};

/** `multicode config path` */
export const runConfigPath = async (opts: GlobalOptions): Promise<number> => {
  print(resolveConfigPath(opts));
  return 0;
};

/** `multicode config show` */
export const runConfigShow = async (opts: GlobalOptions): Promise<number> => {
  printJson(loadConfig(opts));
  return 0;
};
