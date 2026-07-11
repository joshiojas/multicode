import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@multicode/core';

export interface HttpServeOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Bearer token clients must present. Required for non-loopback binds. */
  readonly authToken?: string | undefined;
  readonly allowedOrigins?: readonly string[];
  readonly logger: Logger;
}

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

/**
 * Serve MCP over secure, stateless Streamable HTTP. Each request gets a fresh server+transport (durable
 * state lives in the store, not in memory), DNS-rebinding protection is on, and a bearer token is
 * required whenever the bind is non-loopback. Binds to loopback by default.
 */
export const serveHttp = (
  createMcpServer: () => McpServer,
  options: HttpServeOptions,
): Promise<{ server: Server; close: () => Promise<void> }> => {
  const { host, port, path, authToken, logger } = options;
  const allowedHosts = [
    `${host}:${port}`,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ];
  const allowedOrigins = [...(options.allowedOrigins ?? [])];

  const authorize = (req: IncomingMessage): boolean => {
    if (!authToken) return isLoopback(host);
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return constantTimeEqual(header.slice('Bearer '.length), authToken);
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length === 0) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    if (url.pathname !== path) {
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (!authorize(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no server-initiated streams / session deletion.
      res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    const server = createMcpServer();
    // Stateless mode (sessionIdGenerator: undefined) with DNS-rebinding protection. Cast bypasses the
    // SDK's exactOptionalPropertyTypes friction on `sessionIdGenerator`.
    const transportOptions: Record<string, unknown> = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
    };
    const transport = new StreamableHTTPServerTransport(
      transportOptions as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
    );
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error({ err: String(err) }, 'http request failed');
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'internal error' }));
    }
  };

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      logger.info({ host, port, path, authRequired: Boolean(authToken) }, 'HTTP transport listening');
      resolve({
        server: httpServer,
        close: () =>
          new Promise<void>((res2, rej) => httpServer.close((err) => (err ? rej(err) : res2()))),
      });
    });
  });
};
