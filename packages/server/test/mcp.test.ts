import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asTaskId } from '@multicode/core';
import { createMcpServer } from '@multicode/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, waitFor, type TestHarness } from './helpers.js';

let harness: TestHarness;
let client: Client;

const parse = (result: { content: Array<{ type: string; text?: string }> }): any =>
  JSON.parse(result.content[0]?.text ?? '{}');

beforeEach(async () => {
  harness = await makeHarness();
  const server = createMcpServer(harness.orchestrator);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client?.close();
  await harness?.cleanup();
});

describe('MCP tool surface', () => {
  it('advertises the full Multicode tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'multicode_cancel_task',
        'multicode_continue_task',
        'multicode_get_artifacts',
        'multicode_get_diff',
        'multicode_get_events',
        'multicode_get_task',
        'multicode_list_providers',
        'multicode_list_tasks',
        'multicode_respond_approval',
        'multicode_start_task',
        'multicode_steer_task',
      ].sort(),
    );
  });

  it('lists providers through the protocol', async () => {
    const result = await client.callTool({ name: 'multicode_list_providers', arguments: {} });
    const body = parse(result as never);
    expect(body.providers[0].id).toBe('fake');
  });

  it('starts a task, streams events, and reports a verified diff', async () => {
    const startResult = await client.callTool({
      name: 'multicode_start_task',
      arguments: {
        providerId: 'fake',
        prompt: 'add a changelog entry',
        workspaceRoot: harness.repo,
        mode: 'write',
        sandbox: 'workspace_write',
        approvals: 'never',
      },
    });
    const { task } = parse(startResult as never);
    expect(task.id).toBeDefined();

    await waitFor(
      async () => (await harness.orchestrator.getTask(asTaskId(task.id))).status === 'succeeded',
    );

    const eventsResult = await client.callTool({
      name: 'multicode_get_events',
      arguments: { taskId: task.id },
    });
    const events = parse(eventsResult as never);
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.nextCursor).toBeGreaterThan(0);

    const diffResult = await client.callTool({
      name: 'multicode_get_diff',
      arguments: { taskId: task.id },
    });
    const diff = parse(diffResult as never);
    expect(diff.summary.filesChanged).toBe(1);
    expect(diff.patch).toContain('FAKE_NOTES.md');
  });

  it('surfaces validation errors as structured tool errors, not crashes', async () => {
    const result = (await client.callTool({
      name: 'multicode_get_task',
      arguments: { taskId: 'task_does_not_exist' },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    const body = parse(result as never);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a start with an unapproved workspace root as a tool error', async () => {
    const result = (await client.callTool({
      name: 'multicode_start_task',
      arguments: { providerId: 'fake', prompt: 'x', workspaceRoot: '/etc', mode: 'read_only' },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    const body = parse(result as never);
    expect(body.error.code).toBe('WORKSPACE_INVALID');
  });
});
