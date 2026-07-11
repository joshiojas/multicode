import { spawn } from 'node:child_process';
import { CancelledError } from '@multicode/core';
import { BoundedBuffer } from './output.js';

export interface RunCommandOptions {
  /** Working directory. Callers must validate this is within the workspace root first. */
  readonly cwd: string;
  /** Environment for the child. When omitted, the child inherits an *empty* env (safe default). */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL after a timeout/cancel. */
  readonly cancelGraceMs?: number;
  /** Maximum bytes retained per stream before truncation. */
  readonly maxOutputBytes: number;
  /** Cancellation signal; aborting terminates the child cooperatively then forcibly. */
  readonly signal?: AbortSignal;
  /** Optional stdin. */
  readonly input?: string;
  /** Stream callbacks for live event emission. */
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface RunCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly canceled: boolean;
  /** True if the process was killed by us (timeout/cancel) rather than exiting on its own. */
  readonly killed: boolean;
}

/**
 * Spawn a child process under strict controls: a hard timeout, cooperative-then-forced cancellation,
 * and byte-bounded stdout/stderr. Never uses a shell unless explicitly requested by the caller through
 * `command`/`args` (we always pass `shell: false`), so argument injection through the shell is not
 * possible here.
 *
 * The promise resolves with the observed outcome even for non-zero exits (exit codes are data, not
 * errors) and even after a timeout/cancel — the result carries `timedOut`/`canceled`/`killed` flags so
 * the orchestrator can record the real exit. It rejects only if the process could not be started, or
 * with {@link CancelledError} when the signal was already aborted before spawn.
 */
export const runCommand = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> => {
  const { cwd, env, timeoutMs, maxOutputBytes, signal, input } = options;
  const cancelGraceMs = options.cancelGraceMs ?? 10_000;
  const startedAt = Date.now();

  return new Promise<RunCommandResult>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Command cancelled before start'));
      return;
    }

    const child = spawn(command, [...args], {
      cwd,
      env: env ?? {},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new BoundedBuffer(maxOutputBytes);
    const stderr = new BoundedBuffer(maxOutputBytes);
    let timedOut = false;
    let canceled = false;
    let killed = false;
    let settled = false;

    let hardKillTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      killed = true;
      child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, cancelGraceMs);
      hardKillTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const onAbort = (): void => {
      canceled = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (data: Buffer) => {
      stdout.write(data);
      options.onStdout?.(data.toString('utf8'));
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr.write(data);
      options.onStderr?.(data.toString('utf8'));
    });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        command,
        args: [...args],
        exitCode: code,
        signal: sig,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
        timedOut,
        canceled,
        killed,
      });
    });

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
};
