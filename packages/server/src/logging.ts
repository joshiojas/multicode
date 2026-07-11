import pino from 'pino';
import type { Logger, LoggingConfig } from '@multicode/core';

/**
 * Build a structured logger from configuration. Crucially for the stdio transport, logs are written to
 * **stderr** (fd 2) or a file — never stdout, which is reserved for the JSON-RPC stream.
 */
export const createLogger = (config: LoggingConfig): Logger => {
  const options = { level: config.level };
  let instance;
  if (config.file) {
    instance = pino(options, pino.destination({ dest: config.file, mkdir: true, sync: false }));
  } else if (config.pretty) {
    instance = pino({
      ...options,
      transport: { target: 'pino-pretty', options: { destination: 2, colorize: true } },
    });
  } else {
    instance = pino(options, pino.destination(2));
  }
  return instance as unknown as Logger;
};
