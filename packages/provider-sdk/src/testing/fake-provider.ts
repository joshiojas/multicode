import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CancelledError, PROVIDER_SDK_CONTRACT_VERSION, type ProviderCapabilities, type ProviderDescriptor } from '@multicode/core';
import type {
  AuthStatus,
  ProviderAdapter,
  ProviderContinueInput,
  ProviderFactory,
  ProviderRunContext,
  ProviderStartInput,
  ProviderTurnResult,
} from '../adapter.js';

export interface FakeProviderOptions {
  /** Simulated authentication state. */
  readonly authenticated?: boolean;
  /** Force a failure with this message instead of completing. */
  readonly failWith?: string;
  /** Milliseconds between simulated steps (kept tiny for tests). */
  readonly stepDelayMs?: number;
  /** File name written into the worktree for write-mode tasks. */
  readonly writeFileName?: string;
  /** Override advertised capabilities (e.g. to simulate a limited provider). */
  readonly capabilities?: Partial<ProviderCapabilities>;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A deterministic, in-memory provider adapter. It exercises the full contract — streaming, approvals,
 * resume, steering, cancellation, and (for write tasks) a *real* file write into the worktree so the
 * orchestrator's Git-based verification has genuine changes to observe. It is the reference the
 * conformance suite validates and the double the server's integration tests run against.
 */
export class FakeProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #opts: Required<Omit<FakeProviderOptions, 'capabilities' | 'failWith'>> &
    Pick<FakeProviderOptions, 'failWith' | 'capabilities'>;
  #turn = 0;
  readonly steering: string[] = [];

  constructor(opts: FakeProviderOptions = {}) {
    this.#opts = {
      authenticated: opts.authenticated ?? true,
      stepDelayMs: opts.stepDelayMs ?? 1,
      writeFileName: opts.writeFileName ?? 'FAKE_NOTES.md',
      ...(opts.failWith !== undefined ? { failWith: opts.failWith } : {}),
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    };
    this.descriptor = {
      id: 'fake',
      displayName: 'Fake Provider',
      version: '0.1.0',
      protocolVersion: 'fake-1',
      sdkVersion: PROVIDER_SDK_CONTRACT_VERSION,
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      resume: true,
      steering: true,
      approvals: true,
      cancellation: true,
      writeMode: true,
      readOnlyMode: true,
      artifacts: false,
      providerDiff: false,
      structuredResult: true,
      sandboxLevels: ['read_only', 'workspace_write', 'danger_full_access'],
      networkControl: true,
      models: ['fake-1'],
      ...this.#opts.capabilities,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return this.#opts.authenticated
      ? { authenticated: true, method: 'fake', account: 'fake@example.com' }
      : { authenticated: false, detail: 'run `multicode provider login fake`' };
  }

  async startTask(input: ProviderStartInput, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    return this.#run(input.prompt, input.mode === 'write', ctx);
  }

  async continueTask(input: ProviderContinueInput, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    ctx.emit({ type: 'notice', level: 'info', message: `resuming session ${input.sessionId}` });
    return this.#run(input.prompt, false, ctx);
  }

  async steerTask(_sessionId: string, message: string): Promise<void> {
    this.steering.push(message);
  }

  async #run(prompt: string, isWrite: boolean, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    const sessionId = `fake-session-${(this.#turn += 1)}`;
    const step = this.#opts.stepDelayMs;

    const check = (): void => {
      if (ctx.signal.aborted) throw new CancelledError('fake provider cancelled');
    };

    try {
      check();
      ctx.emit({ type: 'session', sessionId });
      ctx.emit({ type: 'message', role: 'assistant', text: `Working on: ${prompt}` });
      await tick(step);
      check();

      ctx.emit({ type: 'reasoning', text: 'Considering the request.' });
      ctx.emit({ type: 'tool_call', name: 'read_file', callId: 'c1', argsSummary: 'README.md' });
      ctx.emit({ type: 'tool_result', name: 'read_file', callId: 'c1', ok: true, summary: '42 lines' });
      await tick(step);
      check();

      if (this.#opts.failWith) {
        return { status: 'failed', sessionId, error: { code: 'FAKE_FAILURE', message: this.#opts.failWith } };
      }

      let approved = true;
      if (ctx.policy.approvals === 'on_request') {
        const outcome = await ctx.requestApproval({
          kind: 'exec_command',
          summary: 'run the test suite',
          detail: { command: 'pnpm test' },
          providerToken: `tok-${sessionId}`,
        });
        approved = outcome.decision === 'approved';
        ctx.emit({ type: 'notice', level: 'info', message: `approval ${outcome.decision}` });
      }
      check();

      ctx.emit({ type: 'command_started', command: 'pnpm test', cwd: ctx.workspace.cwd });
      ctx.emit({ type: 'command_output', stream: 'stdout', chunk: 'ok\n' });
      ctx.emit({ type: 'command_exited', command: 'pnpm test', exitCode: 0, durationMs: 5 });
      await tick(step);
      check();

      if (isWrite && approved) {
        const file = join(ctx.workspace.cwd, this.#opts.writeFileName);
        writeFileSync(file, `# Fake notes\n\n${prompt}\n`);
        ctx.emit({ type: 'file_changed', path: this.#opts.writeFileName, changeType: 'added' });
      }

      ctx.emit({ type: 'token_usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });

      return {
        status: 'completed',
        summary: approved ? `Completed: ${prompt}` : 'Skipped elevated action after denial',
        sessionId,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        structuredOutput: { prompt, wrote: isWrite && approved },
      };
    } catch (err) {
      if (err instanceof CancelledError) return { status: 'cancelled', sessionId };
      throw err;
    }
  }
}

/** Factory conforming to {@link ProviderFactory}, usable both as a builtin and via the loader path. */
export const createProvider: ProviderFactory = (init) =>
  new FakeProvider((init.config as FakeProviderOptions) ?? {});

/** Convenience for tests that want a specific configuration. */
export const createFakeProvider = (opts: FakeProviderOptions = {}): ProviderFactory => () =>
  new FakeProvider(opts);
