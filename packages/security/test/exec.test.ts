import { CancelledError } from '@multicode/core';
import { describe, expect, it } from 'vitest';
import { runCommand } from '@multicode/security';

const NODE = process.execPath;
const cwd = process.cwd();

describe('runCommand', () => {
  it('captures stdout and a zero exit', async () => {
    const r = await runCommand(NODE, ['-e', 'process.stdout.write("hello")'], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.timedOut).toBe(false);
    expect(r.canceled).toBe(false);
  });

  it('reports a non-zero exit code as data, not an error', async () => {
    const r = await runCommand(NODE, ['-e', 'process.exit(3)'], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.killed).toBe(false);
  });

  it('bounds output', async () => {
    const r = await runCommand(NODE, ['-e', 'process.stdout.write("x".repeat(1000))'], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10,
    });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout).toContain('truncated');
  });

  it('enforces a timeout and kills the process', async () => {
    const r = await runCommand(NODE, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd,
      timeoutMs: 200,
      cancelGraceMs: 200,
      maxOutputBytes: 1_000,
    });
    expect(r.timedOut).toBe(true);
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('cancels on an aborted signal', async () => {
    const controller = new AbortController();
    const promise = runCommand(NODE, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd,
      timeoutMs: 60_000,
      cancelGraceMs: 200,
      maxOutputBytes: 1_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const r = await promise;
    expect(r.canceled).toBe(true);
    expect(r.killed).toBe(true);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommand(NODE, ['-e', ''], {
        cwd,
        timeoutMs: 1_000,
        maxOutputBytes: 100,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});
