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
      instructions: [
        'Multicode lets you DELEGATE a self-contained software-engineering task to an external coding',
        'agent (e.g. OpenAI Codex) that works autonomously in an isolated Git worktree and returns a',
        'diff VERIFIED against real git output and command exit codes — never just the agent\'s own summary.',
        '',
        'Delegate with multicode_start_task when:',
        '- the task is well-scoped and describable in a prompt (implement X, fix bug Y, add tests, refactor Z);',
        '- it is long-running, or you want to run several tasks in parallel while you keep working;',
        '- you want the change made and verified in isolation (a throwaway worktree), not in the live tree;',
        '- the user asks to hand off / offload work, or to use Codex or another agent.',
        '',
        'Typical flow: multicode_list_providers (discover providers + capabilities) -> multicode_start_task',
        '(returns immediately; the task runs in the background) -> poll multicode_get_task / stream',
        'multicode_get_events -> review multicode_get_diff. Answer any multicode_respond_approval prompts;',
        'use multicode_continue_task / multicode_steer_task for interactive, resumable sessions.',
        '',
        'Do NOT delegate trivial edits you can do directly. Delegation shines for well-scoped, verifiable',
        'units of work.',
      ].join('\n'),
    },
  );
  registerTools(server, orchestrator);
  return server;
};
