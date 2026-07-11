/**
 * Minimal structured-logging contract. The core depends only on this interface; concrete logging
 * (pino) lives at the edges so the domain never pulls in a logging framework.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogFields = Record<string, unknown>;

export interface Logger {
  level: LogLevel;
  trace(fields: LogFields, msg?: string): void;
  trace(msg: string): void;
  debug(fields: LogFields, msg?: string): void;
  debug(msg: string): void;
  info(fields: LogFields, msg?: string): void;
  info(msg: string): void;
  warn(fields: LogFields, msg?: string): void;
  warn(msg: string): void;
  error(fields: LogFields, msg?: string): void;
  error(msg: string): void;
  fatal(fields: LogFields, msg?: string): void;
  fatal(msg: string): void;
  /** Return a child logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
}

/** A logger that discards everything. Handy as a default and in tests. */
export const noopLogger: Logger = {
  level: 'info',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** True when `level` is at or above the configured `threshold`. */
export const isLevelEnabled = (level: LogLevel, threshold: LogLevel): boolean =>
  ORDER[level] >= ORDER[threshold];
