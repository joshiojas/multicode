import { describe, expect, it } from 'vitest';
import {
  CapabilityError,
  MulticodeError,
  NotFoundError,
  isMulticodeError,
  parseProviderId,
  stableStringify,
  toMulticodeError,
} from '@multicode/core';

describe('errors', () => {
  it('carries a stable code and serializes without a stack', () => {
    const err = new NotFoundError('task not found', { details: { id: 'task_1' } });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('NotFoundError');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'NotFoundError',
      code: 'NOT_FOUND',
      message: 'task not found',
      retriable: false,
      details: { id: 'task_1' },
    });
    expect(JSON.stringify(json)).not.toContain('stack');
  });

  it('preserves instanceof across subclasses', () => {
    const err = new CapabilityError('nope');
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err).toBeInstanceOf(MulticodeError);
    expect(isMulticodeError(err)).toBe(true);
  });

  it('wraps unknown throwables', () => {
    expect(toMulticodeError(new Error('boom')).code).toBe('INTERNAL');
    expect(toMulticodeError('boom').message).toBe('boom');
    const wrapped = toMulticodeError(new CapabilityError('x'));
    expect(wrapped.code).toBe('CAPABILITY_UNSUPPORTED');
  });
});

describe('provider id parsing', () => {
  it('accepts valid ids', () => {
    expect(parseProviderId('codex')).toBe('codex');
    expect(parseProviderId('my-provider-2')).toBe('my-provider-2');
  });

  it('rejects invalid ids', () => {
    expect(() => parseProviderId('Codex')).toThrow();
    expect(() => parseProviderId('2codex')).toThrow();
    expect(() => parseProviderId('a b')).toThrow();
  });
});

describe('stableStringify', () => {
  it('sorts keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 2, b: 1 })).toBe(stableStringify({ b: 1, a: 2 }));
  });

  it('throws on cyclic structures', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(() => stableStringify(obj)).toThrow(/cyclic/);
  });
});
