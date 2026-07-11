import { ProviderError } from '@multicode/core';

/**
 * A bidirectional JSON-RPC 2.0 message transport. Production uses newline-delimited JSON over a child
 * process's stdio ({@link ChildProcessTransport}); tests use an in-memory pair. Keeping this abstract
 * lets the endpoint and the whole Codex adapter be exercised without spawning a real process.
 */
export interface MessageTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;
export type PrefixNotificationHandler = (params: unknown, method: string) => void;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A JSON-RPC 2.0 endpoint over a {@link MessageTransport}. Supports outbound requests/notifications and
 * inbound requests (e.g. the App Server asking for an approval) and notifications (streamed events).
 */
export class JsonRpcEndpoint {
  readonly #transport: MessageTransport;
  #nextId = 1;
  #closed = false;
  readonly #pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #requestHandlers = new Map<string, RequestHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();
  readonly #prefixNotificationHandlers: Array<{ prefix: string; handler: PrefixNotificationHandler }> = [];

  constructor(transport: MessageTransport) {
    this.#transport = transport;
    transport.onMessage((msg) => this.#dispatch(msg));
    transport.onClose(() => this.#onClose());
  }

  /** Send a request and await its result. Rejects on a JSON-RPC error or transport close. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new ProviderError('Codex App Server connection is closed'));
    const id = this.#nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#transport.send(message);
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new ProviderError(String(err)));
      }
    });
  }

  /** Fire a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.#transport.send(message);
  }

  /** Handle an inbound request (server→client), e.g. an approval prompt. */
  onRequest(method: string, handler: RequestHandler): void {
    this.#requestHandlers.set(method, handler);
  }

  /** Handle an inbound notification (server→client), e.g. a streamed event. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.#notificationHandlers.set(method, handler);
  }

  /**
   * Handle inbound notifications whose method starts with `prefix` (e.g. `codex/event/`). Checked only
   * when no exact-match handler is registered.
   */
  onNotificationPrefix(prefix: string, handler: PrefixNotificationHandler): void {
    this.#prefixNotificationHandlers.push({ prefix, handler });
  }

  close(): void {
    if (this.#closed) return;
    this.#transport.close();
    this.#onClose();
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) {
      reject(new ProviderError('Codex App Server connection closed before response'));
    }
    this.#pending.clear();
  }

  #dispatch(msg: unknown): void {
    if (!isObject(msg)) return;
    // Response to one of our requests.
    if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      const res = msg as unknown as JsonRpcResponse;
      const pending = this.#pending.get(res.id);
      if (!pending) return;
      this.#pending.delete(res.id);
      if (res.error) {
        pending.reject(new ProviderError(`Codex RPC error ${res.error.code}: ${res.error.message}`, { details: { data: res.error.data } }));
      } else {
        pending.resolve(res.result);
      }
      return;
    }
    // Inbound request (needs a response).
    if ('id' in msg && 'method' in msg) {
      void this.#handleInboundRequest(msg as unknown as JsonRpcRequest);
      return;
    }
    // Notification.
    if ('method' in msg) {
      const note = msg as unknown as JsonRpcNotification;
      const exact = this.#notificationHandlers.get(note.method);
      if (exact) {
        exact(note.params);
        return;
      }
      for (const { prefix, handler } of this.#prefixNotificationHandlers) {
        if (note.method.startsWith(prefix)) {
          handler(note.params, note.method);
          return;
        }
      }
    }
  }

  async #handleInboundRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.#requestHandlers.get(req.method);
    if (!handler) {
      this.#transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      return;
    }
    try {
      const result = await handler(req.params);
      this.#transport.send({ jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      this.#transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
