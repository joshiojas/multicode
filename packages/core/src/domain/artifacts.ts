import { z } from 'zod';

/** Category of a produced artifact, used by clients to decide how to render/consume it. */
export const ArtifactKind = z.enum([
  'diff',
  'file',
  'log',
  'test_report',
  'summary',
  'patch',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/**
 * A durable output produced by a task. Small artifacts are stored inline; larger ones reference a
 * path within the task's managed storage. Multicode never trusts a provider's claim that a file
 * changed — artifacts of kind `diff` are always reconciled against real Git output before use.
 */
export const Artifact = z
  .object({
    id: z.string(),
    taskId: z.string(),
    kind: ArtifactKind,
    /** Stable name, e.g. `changes.diff`, `vitest.log`. */
    name: z.string(),
    /** MIME type, best-effort. */
    contentType: z.string().default('text/plain'),
    /** Byte size of the content (of the referenced file, if `path` is set). */
    sizeBytes: z.number().int().nonnegative(),
    /** Inline content for small artifacts. */
    content: z.string().optional(),
    /** Absolute path within managed storage for large artifacts. */
    path: z.string().optional(),
    /** SHA-256 of the content, hex. */
    sha256: z.string().optional(),
    createdAt: z.string(),
  })
  .strict()
  .refine((a) => a.content !== undefined || a.path !== undefined, {
    message: 'Artifact must have either inline content or a path.',
  });
export type Artifact = z.infer<typeof Artifact>;
