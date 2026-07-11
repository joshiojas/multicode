import { toMulticodeError } from '@multicode/core';

/** The MCP tool result shape we return (content-first, always JSON-safe across SDK versions). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** Wrap a successful payload as a tool result. */
export const ok = (payload: unknown): ToolResult => text(payload);

/** Wrap an error as a tool result with `isError` and a safe, structured error body. */
export const fail = (err: unknown): ToolResult => {
  const error = toMulticodeError(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: error.toJSON() }, null, 2) }],
    isError: true,
  };
};

/** Run a tool handler, translating any thrown Multicode/unknown error into a safe tool result. */
export const guard = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
};
