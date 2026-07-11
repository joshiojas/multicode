import { describe, expect, it } from 'vitest';
import { BoundedBuffer } from '@multicode/security';

describe('BoundedBuffer', () => {
  it('retains everything under the cap', () => {
    const buf = new BoundedBuffer(100);
    buf.write('hello ');
    buf.write('world');
    expect(buf.toString()).toBe('hello world');
    expect(buf.truncated).toBe(false);
    expect(buf.retainedBytes).toBe(11);
  });

  it('truncates at the cap and reports dropped bytes', () => {
    const buf = new BoundedBuffer(5);
    const r1 = buf.write('abc');
    const r2 = buf.write('defgh');
    expect(r1).toEqual({ retained: 3, dropped: 0 });
    expect(r2).toEqual({ retained: 2, dropped: 3 });
    expect(buf.truncated).toBe(true);
    expect(buf.droppedBytes).toBe(3);
    expect(buf.toBuffer().toString()).toBe('abcde');
    expect(buf.toString()).toContain('truncated 3 byte');
  });

  it('drops entirely once full', () => {
    const buf = new BoundedBuffer(2);
    buf.write('ab');
    const r = buf.write('cccc');
    expect(r).toEqual({ retained: 0, dropped: 4 });
    expect(buf.totalBytes).toBe(6);
  });

  it('rejects an invalid cap', () => {
    expect(() => new BoundedBuffer(0)).toThrow(RangeError);
    expect(() => new BoundedBuffer(-1)).toThrow(RangeError);
  });
});
