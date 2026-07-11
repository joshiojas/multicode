import { MulticodeError } from '../errors.js';

/** Exhaustiveness guard for discriminated unions. Reaching it is a programming error. */
export const assertNever = (value: never, context = 'value'): never => {
  throw new MulticodeError('INTERNAL', `Unexpected ${context}: ${JSON.stringify(value)}`);
};

/** Assert a runtime invariant; throws an internal error when it does not hold. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new MulticodeError('INTERNAL', `Invariant violated: ${message}`);
  }
}

/** Deterministic JSON with sorted keys — used for stable hashing/equality of structured payloads. */
export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new MulticodeError('INTERNAL', 'Cannot stringify cyclic value');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
};
