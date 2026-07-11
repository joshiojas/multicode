import { z } from 'zod';

/** The type of change Git reports for a single path. */
export const FileChangeType = z.enum(['added', 'modified', 'deleted', 'renamed', 'type_changed']);
export type FileChangeType = z.infer<typeof FileChangeType>;

export const FileChange = z
  .object({
    path: z.string(),
    changeType: FileChangeType,
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** Present for renames. */
    renamedFrom: z.string().optional(),
    binary: z.boolean().default(false),
  })
  .strict();
export type FileChange = z.infer<typeof FileChange>;

/** Ground-truth summary of the Git diff a write task produced, derived by Multicode — not the agent. */
export const DiffSummary = z
  .object({
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(FileChange),
    /** The base commit the diff was computed against. */
    baseRef: z.string(),
    /** SHA-256 of the unified patch, for tamper-evidence. */
    patchSha256: z.string().optional(),
    /** Artifact id holding the full unified patch, if stored. */
    patchArtifactId: z.string().optional(),
    /** True if the diff was truncated to respect output bounds. */
    truncated: z.boolean().default(false),
  })
  .strict();
export type DiffSummary = z.infer<typeof DiffSummary>;

/** A command Multicode observed the task run, with its real exit code. */
export const CommandOutcome = z
  .object({
    command: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    /** True if the process was killed (timeout/cancel) rather than exiting on its own. */
    killed: z.boolean().default(false),
  })
  .strict();
export type CommandOutcome = z.infer<typeof CommandOutcome>;

/**
 * The verified evidence of what a task actually did. Populated from Git and process observations, so
 * downstream consumers never have to trust the agent's own narrative.
 */
export const Verification = z
  .object({
    diff: DiffSummary.optional(),
    commands: z.array(CommandOutcome).default([]),
    artifactIds: z.array(z.string()).default([]),
    /** Whether Multicode independently confirmed a change occurred (non-empty diff or artifacts). */
    changeConfirmed: z.boolean(),
  })
  .strict();
export type Verification = z.infer<typeof Verification>;

export const TokenUsage = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * The structured outcome of a task. `summary` is the provider's own words; `verification` is
 * Multicode's independent, evidence-based account. Consumers should trust `verification`.
 */
export const TaskResult = z
  .object({
    /** The provider's natural-language summary of what it did (untrusted narrative). */
    summary: z.string().default(''),
    /** Independently derived evidence. */
    verification: Verification,
    /** Opaque, provider-specific structured payload (already validated by the adapter). */
    structuredOutput: z.record(z.unknown()).optional(),
    tokenUsage: TokenUsage.optional(),
    /** Provider session id enabling `continue_task`, if the provider is resumable. */
    providerSessionId: z.string().optional(),
  })
  .strict();
export type TaskResult = z.infer<typeof TaskResult>;
