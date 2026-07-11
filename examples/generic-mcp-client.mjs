#!/usr/bin/env node
// A standalone MCP client that spawns `multicode serve` over stdio and drives the tools.
//
// Prereqs:  npm i @modelcontextprotocol/sdk   (and a built/installed `multicode`)
// Run:      node examples/generic-mcp-client.mjs /absolute/path/to/an/approved/workspace
//
// It lists providers, starts a read-only task, streams events until the task is terminal, and prints
// the verified result. Swap mode to "write" (and sandbox to "workspace_write") to get a real diff.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspaceRoot = process.argv[2] ?? process.cwd();
const providerId = process.env.MULTICODE_PROVIDER ?? 'codex';

const parse = (result) => JSON.parse(result.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', 'multicode', 'serve'],
});
const client = new Client({ name: 'multicode-example', version: '1.0.0' });
await client.connect(transport);

// 1. Discover providers and their negotiated capabilities.
const providers = parse(await client.callTool({ name: 'multicode_list_providers', arguments: {} }));
console.log('providers:', providers.providers.map((p) => `${p.id} (${p.status})`).join(', '));

// 2. Start a read-only task.
const started = parse(
  await client.callTool({
    name: 'multicode_start_task',
    arguments: {
      providerId,
      prompt: 'Summarize what this project does and list its main modules.',
      workspaceRoot,
      mode: 'read_only',
    },
  }),
);
const taskId = started.task.id;
console.log('started task:', taskId, '→', started.task.status);

// 3. Stream events until the task reaches a terminal state.
let cursor = 0;
let status = started.task.status;
while (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) {
  await sleep(500);
  const page = parse(
    await client.callTool({ name: 'multicode_get_events', arguments: { taskId, afterSeq: cursor } }),
  );
  for (const e of page.events) {
    if (e.type === 'provider.message') console.log(`  [${e.role}] ${e.text}`);
    else if (e.type === 'command.exited') console.log(`  $ ${e.command} → ${e.exitCode}`);
    else if (e.type === 'status.changed') console.log(`  · ${e.from} → ${e.to}`);
  }
  cursor = page.nextCursor;
  status = parse(await client.callTool({ name: 'multicode_get_task', arguments: { taskId } })).task.status;
}

// 4. Show the verified result.
const finalTask = parse(await client.callTool({ name: 'multicode_get_task', arguments: { taskId } })).task;
console.log('final status:', finalTask.status);
console.log('summary:', finalTask.result?.summary ?? '(none)');
console.log('change confirmed:', finalTask.result?.verification.changeConfirmed);

await client.close();
process.exit(0);
