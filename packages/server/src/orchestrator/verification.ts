import {
  isEventType,
  type CommandOutcome,
  type DiffSummary,
  type TaskEvent,
  type Verification,
} from '@multicode/core';

/**
 * Build the independently-verified account of what a turn did. Command outcomes come from the durable
 * `command.exited` events Multicode observed (real exit codes), and the diff — when present — is the
 * ground-truth Git diff computed by the security layer. `changeConfirmed` is true only when there is
 * objective evidence of a change (a non-empty diff or a produced artifact), never because the agent
 * said so.
 */
export const buildVerification = (params: {
  diff?: DiffSummary | undefined;
  events: readonly TaskEvent[];
  artifactIds?: readonly string[];
}): Verification => {
  const commands: CommandOutcome[] = [];
  for (const event of params.events) {
    if (isEventType(event, 'command.exited')) {
      commands.push({
        command: event.command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        killed: event.killed,
      });
    }
  }

  const artifactIds = [...(params.artifactIds ?? [])];
  const diffHasChanges = params.diff !== undefined && params.diff.filesChanged > 0;
  const changeConfirmed = diffHasChanges || artifactIds.length > 0;

  return {
    ...(params.diff ? { diff: params.diff } : {}),
    commands,
    artifactIds,
    changeConfirmed,
  };
};
