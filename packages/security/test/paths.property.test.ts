import { relative, resolve } from 'node:path';
import { SecurityError } from '@multicode/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isWithinRoot, resolveWithinRoot } from '@multicode/security';

const numRuns = Number(process.env['MULTICODE_PROPERTY_RUNS'] ?? '300') || 300;

// A non-existent absolute root so realpath resolution is deterministic (only "/" is real).
const rootArb = fc
  .array(fc.constantFrom('mcroot', 'workspace', 'proj', 'a', 'deep'), { minLength: 1, maxLength: 3 })
  .map((segs) => `/${['mc-fuzz', ...segs].join('/')}`);

// Path segments that include traversal and absolute-injection attempts.
const segmentArb = fc.constantFrom(
  'a',
  'b',
  'src',
  'node_modules',
  'file.ts',
  '..',
  '.',
  '',
  'nested',
  '..',
  'evil',
);

const candidateArb = fc.oneof(
  // Relative candidate assembled from segments.
  fc.array(segmentArb, { maxLength: 8 }).map((s) => s.join('/')),
  // Absolute-injection candidate.
  fc.array(segmentArb, { maxLength: 6 }).map((s) => `/${s.join('/')}`),
  // Known escape shapes.
  fc.constantFrom('../evil', '../../etc/passwd', '/etc/passwd', '..', '../'.repeat(5) + 'x'),
);

describe('path confinement (property-based)', () => {
  it('never returns a path outside the root; escapes throw SecurityError', () => {
    fc.assert(
      fc.property(rootArb, candidateArb, (root, candidate) => {
        let result: string;
        try {
          result = resolveWithinRoot(root, candidate);
        } catch (err) {
          // The only acceptable rejection is a SecurityError.
          expect(err).toBeInstanceOf(SecurityError);
          return;
        }
        // If it resolved, the result must be contained — no silent escape, ever.
        expect(isWithinRoot(root, result)).toBe(true);
        // And it must genuinely be the root or a descendant per path.relative.
        const rel = relative(resolve(root), result);
        expect(rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))).toBe(true);
      }),
      { numRuns },
    );
  });

  it('always rejects an explicit parent-escape', () => {
    fc.assert(
      fc.property(rootArb, fc.integer({ min: 1, max: 6 }), (root, depth) => {
        const candidate = `${'../'.repeat(depth)}escapee`;
        expect(() => resolveWithinRoot(root, candidate)).toThrow(SecurityError);
      }),
      { numRuns },
    );
  });

  it('accepts safe descendant paths and resolves them under the root', () => {
    fc.assert(
      fc.property(
        rootArb,
        fc.array(fc.constantFrom('a', 'b', 'src', 'lib', 'x'), { minLength: 1, maxLength: 5 }),
        (root, segs) => {
          const candidate = segs.join('/');
          const result = resolveWithinRoot(root, candidate);
          expect(result).toBe(resolve(root, candidate));
          expect(isWithinRoot(root, result)).toBe(true);
        },
      ),
      { numRuns },
    );
  });
});
