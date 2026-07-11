import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProviderUnavailableError, type Logger } from '@multicode/core';
import type { MessageTransport } from './json-rpc.js';

export interface SpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly logger: Logger;
}

/**
 * Newline-delimited JSON-RPC transport over a spawned Codex App Server process. Each message is a
 * single JSON object on its own line (jsonl). stderr is forwarded to the logger; process exit closes
 * the transport, which unblocks any pending requests.
 */
export class ChildProcessTransport implements MessageTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #logger: Logger;
  #buffer = '';
  #messageHandler: ((message: unknown) => void) | undefined;
  #closeHandler: (() => void) | undefined;
  #closed = false;

  constructor(options: SpawnOptions) {
    this.#logger = options.logger;
    try {
      this.#child = spawn(options.command, [...options.args], {
        env: { ...(options.env ?? {}) },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw new ProviderUnavailableError(`Failed to spawn Codex App Server: ${String(err)}`, {
        details: { command: options.command },
      });
    }

    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) =>
      this.#logger.debug({ codexStderr: chunk.trimEnd() }, 'codex app-server stderr'),
    );
    this.#child.on('error', (err) => {
      this.#logger.error({ err: String(err) }, 'codex app-server process error');
      this.#emitClose();
    });
    this.#child.on('close', (code) => {
      this.#logger.info({ code }, 'codex app-server exited');
      this.#emitClose();
    });
  }

  send(message: unknown): void {
    if (this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.#messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill('SIGTERM');
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          this.#messageHandler?.(JSON.parse(line));
        } catch (err) {
          this.#logger.warn({ line: line.slice(0, 200), err: String(err) }, 'unparseable codex message');
        }
      }
      index = this.#buffer.indexOf('\n');
    }
  }

  #emitClose(): void {
    if (this.#closed) {
      this.#closeHandler?.();
      return;
    }
    this.#closed = true;
    this.#closeHandler?.();
  }
}
