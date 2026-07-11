import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  PROVIDER_SDK_CONTRACT_VERSION,
  type Logger,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type TokenUsage,
} from '@multicode/core';
import type {
  AuthStatus,
  ProviderAdapter,
  ProviderContinueInput,
  ProviderFactory,
  ProviderRunContext,
  ProviderStartInput,
  ProviderTurnResult,
} from '@multicode/provider-sdk';

/**
 * A minimal, self-contained Ollama provider: it delegates a coding task to a local model (e.g. `gemma`)
 * via the Ollama chat API and applies the model's file edits into the task's confined worktree. This is
 * a *codegen* provider — it never runs untrusted shell commands; it only writes model-produced files
 * (path-confined to the worktree), so Multicode's Git diff is still the ground truth. It exists to
 * demonstrate that the provider SDK is genuinely model-agnostic: a raw local LLM plugs in exactly like
 * the Codex App Server.
 */
export interface OllamaConfig {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly models?: string[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CodegenResult {
  files?: Array<{ path?: unknown; content?: unknown }>;
  summary?: unknown;
}

const SYSTEM_WRITE =
  'You are an autonomous coding agent working inside a Git repository. Accomplish the task by writing ' +
  'files. Respond with ONLY a JSON object of the form ' +
  '{"files":[{"path":"<path relative to the project root>","content":"<the COMPLETE file content>"}],' +
  '"summary":"<one-sentence summary of what you did>"}. Include every file you create or modify, each ' +
  'with its full content. Do not use markdown code fences. Output valid JSON only.';

const SYSTEM_READ =
  'You are a senior code reviewer. Analyze the request and respond with ONLY a JSON object of the form ' +
  '{"files":[],"summary":"<your findings in 1-3 sentences>"}. Do not modify any files. Output valid ' +
  'JSON only.';

export class OllamaProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'ollama',
    displayName: 'Ollama (local)',
    version: '0.1.0',
    protocolVersion: 'ollama-chat-1',
    sdkVersion: PROVIDER_SDK_CONTRACT_VERSION,
  };

  readonly #baseUrl: string;
  readonly #model: string;
  readonly #models: string[];
  readonly #logger: Logger;
  readonly #history = new Map<string, ChatMessage[]>();
  #counter = 0;

  constructor(options: { config?: OllamaConfig; logger: Logger }) {
    const config = options.config ?? {};
    const envBase = process.env['OLLAMA_HOST'];
    this.#baseUrl = (config.baseUrl ?? envBase ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.#model = config.model ?? 'gemma4:latest';
    this.#models = config.models ?? [this.#model];
    this.#logger = options.logger;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      resume: true,
      steering: false,
      approvals: false,
      cancellation: true,
      writeMode: true,
      readOnlyMode: true,
      artifacts: false,
      providerDiff: false,
      structuredResult: true,
      // This adapter only writes model-produced files into the confined worktree (no untrusted exec),
      // and makes no network calls beyond the local Ollama endpoint.
      sandboxLevels: ['read_only', 'workspace_write'],
      networkControl: true,
      models: this.#models,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    try {
      const res = await fetch(`${this.#baseUrl}/api/tags`, { method: 'GET' });
      return res.ok
        ? { authenticated: true, method: 'local', detail: `Ollama reachable at ${this.#baseUrl}` }
        : { authenticated: false, detail: `Ollama returned HTTP ${res.status}` };
    } catch {
      return { authenticated: false, detail: `Ollama not reachable at ${this.#baseUrl}` };
    }
  }

  async startTask(input: ProviderStartInput, ctx: ProviderRunContext): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled' };
    const sessionId = `ollama-${(this.#counter += 1)}`;
    const system = ctx.policy.mode === 'write' ? SYSTEM_WRITE : SYSTEM_READ;
    this.#history.set(sessionId, [
      { role: 'system', content: system },
      { role: 'user', content: input.prompt },
    ]);
    return this.#run(sessionId, ctx, input.model);
  }

  async continueTask(
    input: ProviderContinueInput,
    ctx: ProviderRunContext,
  ): Promise<ProviderTurnResult> {
    if (ctx.signal.aborted) return { status: 'cancelled', sessionId: input.sessionId };
    const history = this.#history.get(input.sessionId) ?? [
      { role: 'system', content: ctx.policy.mode === 'write' ? SYSTEM_WRITE : SYSTEM_READ },
    ];
    history.push({ role: 'user', content: input.prompt });
    this.#history.set(input.sessionId, history);
    return this.#run(input.sessionId, ctx, input.model);
  }

  async #run(
    sessionId: string,
    ctx: ProviderRunContext,
    model: string | undefined,
  ): Promise<ProviderTurnResult> {
    ctx.emit({ type: 'session', sessionId });
    const messages = this.#history.get(sessionId) ?? [];
    const useModel = model ?? this.#model;
    ctx.emit({ type: 'reasoning', text: `Prompting ${useModel} via Ollama…` });

    // Small local models occasionally emit slightly-malformed JSON; give them one corrective retry.
    let parsed: CodegenResult | undefined;
    let usage: TokenUsage | undefined;
    let lastContent = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let content: string;
      try {
        const res = await fetch(`${this.#baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: useModel, stream: false, format: 'json', messages }),
          signal: ctx.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { status: 'failed', sessionId, error: { code: 'PROVIDER_ERROR', message: `Ollama HTTP ${res.status}: ${body.slice(0, 300)}` } };
        }
        const data = (await res.json()) as { message?: { content?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown };
        content = typeof data.message?.content === 'string' ? data.message.content : '';
        usage = buildUsage(data.prompt_eval_count, data.eval_count);
      } catch (err) {
        if (ctx.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          return { status: 'cancelled', sessionId };
        }
        return { status: 'failed', sessionId, error: { code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) } };
      }

      lastContent = content;
      messages.push({ role: 'assistant', content });
      try {
        parsed = JSON.parse(extractJson(content)) as CodegenResult;
        break;
      } catch {
        if (attempt === 2) {
          return { status: 'failed', sessionId, error: { code: 'PROVIDER_ERROR', message: `model did not return valid JSON: ${lastContent.slice(0, 200)}` } };
        }
        ctx.emit({ type: 'notice', level: 'warn', message: 'model output was not valid JSON — retrying' });
        messages.push({
          role: 'user',
          content: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object described earlier — no prose, no markdown fences.',
        });
      }
    }
    if (!parsed) {
      return { status: 'failed', sessionId, error: { code: 'PROVIDER_ERROR', message: 'model did not return valid JSON' } };
    }

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    if (summary) ctx.emit({ type: 'message', role: 'assistant', text: summary });

    const written: string[] = [];
    if (ctx.policy.mode === 'write' && Array.isArray(parsed.files)) {
      const cwd = resolve(ctx.workspace.cwd);
      for (const file of parsed.files) {
        const path = typeof file?.path === 'string' ? file.path : undefined;
        const body = typeof file?.content === 'string' ? file.content : undefined;
        if (!path || body === undefined) continue;
        const abs = resolve(cwd, path);
        // Confine writes to the worktree — refuse anything that escapes it.
        if (abs !== cwd && !abs.startsWith(cwd + sep)) {
          ctx.emit({ type: 'notice', level: 'warn', message: `refused path outside workspace: ${path}` });
          continue;
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, body, 'utf8');
        written.push(path);
        ctx.emit({ type: 'file_changed', path, changeType: 'modified' });
      }
    }

    if (usage) ctx.emit({ type: 'token_usage', usage });
    this.#logger.debug({ sessionId, written }, 'ollama turn complete');

    return {
      status: 'completed',
      sessionId,
      summary,
      structuredOutput: { files: written },
      ...(usage ? { tokenUsage: usage } : {}),
    };
  }
}

/** Tolerate small-model quirks: strip markdown fences and extract the outermost JSON object. */
export const extractJson = (raw: string): string => {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
};

const buildUsage = (input: unknown, output: unknown): TokenUsage | undefined => {
  const i = typeof input === 'number' ? input : undefined;
  const o = typeof output === 'number' ? output : undefined;
  if (i === undefined && o === undefined) return undefined;
  return {
    ...(i !== undefined ? { inputTokens: i } : {}),
    ...(o !== undefined ? { outputTokens: o } : {}),
    ...(i !== undefined && o !== undefined ? { totalTokens: i + o } : {}),
  };
};

export const createProvider: ProviderFactory = (init) =>
  new OllamaProvider({ config: (init.config as OllamaConfig) ?? {}, logger: init.logger });

export default createProvider;
