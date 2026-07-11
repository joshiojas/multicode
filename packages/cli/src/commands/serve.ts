import { bootstrap, createLogger, createMcpServer, serveHttp, serveStdio } from '@multicode/server';
import { loadConfig, createRegistry, type GlobalOptions } from '../config-loader.js';
import { printErr } from '../output.js';

export interface ServeOptions extends GlobalOptions {
  readonly transport?: 'stdio' | 'http';
}

/**
 * Run the MCP server. Defaults to stdio; HTTP is used when configured (or `--transport http`). On
 * boot, interrupted tasks are reconciled before serving. Logs go to stderr/file — never stdout, which
 * the stdio JSON-RPC stream owns.
 */
export const runServe = async (opts: ServeOptions): Promise<number> => {
  const config = loadConfig(opts);
  const logger = createLogger(config.logging).child({ component: 'multicode' });
  const registry = createRegistry(logger);

  const { orchestrator, store } = await bootstrap({ config, registry, logger });

  const recovery = await orchestrator.recover();
  if (recovery.recovered.length > 0) {
    logger.info({ recovered: recovery.recovered.length }, 'reconciled interrupted tasks on boot');
  }

  const transportType = opts.transport ?? config.transport.type;

  let closeHttp: (() => Promise<void>) | undefined;
  if (transportType === 'http') {
    const http = config.transport.type === 'http' ? config.transport : { host: '127.0.0.1', port: 7461, path: '/mcp', authTokenEnv: undefined, allowedOrigins: [] as string[] };
    const authToken = http.authTokenEnv ? process.env[http.authTokenEnv] : undefined;
    const started = await serveHttp(() => createMcpServer(orchestrator), {
      host: http.host,
      port: http.port,
      path: http.path,
      authToken,
      allowedOrigins: http.allowedOrigins,
      logger,
    });
    closeHttp = started.close;
    logger.info({ url: `http://${http.host}:${http.port}${http.path}` }, 'multicode serving over HTTP');
  } else {
    const server = createMcpServer(orchestrator);
    await serveStdio(server);
    logger.info('multicode serving over stdio');
  }

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await closeHttp?.();
      await orchestrator.shutdown();
      await store.close();
    } catch (err) {
      printErr(`shutdown error: ${String(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive.
  return new Promise<number>(() => {
    /* resolves only via process.exit in shutdown */
  });
};
