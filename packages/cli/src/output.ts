/** Small stdout formatting helpers for the CLI (human tables + JSON mode). */

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

export const printErr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Render an array of rows as an aligned text table. */
export const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ');
  const lines = [fmt(headers), widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n');
};

/** Status glyph for a task/provider status string. */
export const glyph = (status: string): string => {
  switch (status) {
    case 'succeeded':
    case 'ready':
    case 'approved':
      return '✓';
    case 'failed':
    case 'timed_out':
    case 'denied':
      return '✗';
    case 'cancelled':
    case 'disabled':
      return '∅';
    case 'running':
    case 'provisioning':
      return '▶';
    case 'awaiting_approval':
    case 'awaiting_input':
      return '⏸';
    default:
      return '·';
  }
};
