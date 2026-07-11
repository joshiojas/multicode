import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Serve an MCP server over stdio — the default transport. The JSON-RPC stream owns stdout, so all
 * logging must go to stderr or a file (never stdout).
 */
export const serveStdio = async (server: McpServer): Promise<StdioServerTransport> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
};
