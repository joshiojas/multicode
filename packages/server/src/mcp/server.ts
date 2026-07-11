import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'multicode';
export const SERVER_VERSION = '0.1.0';

/**
 * Construct an MCP server exposing the Multicode tool surface, wired to an {@link Orchestrator}. The
 * same factory is used for stdio (one long-lived server) and for stateless HTTP (a fresh server per
 * request, since durable state lives in the store, not in the server).
 */
export const createMcpServer = (orchestrator: Orchestrator): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {} },
      instructions:
        'Multicode delegates coding tasks to external agents. Discover providers with ' +
        'multicode_list_providers, start work with multicode_start_task, then monitor via ' +
        'multicode_get_task / multicode_get_events. Results are verified against real Git diffs.',
    },
  );
  registerTools(server, orchestrator);
  return server;
};
