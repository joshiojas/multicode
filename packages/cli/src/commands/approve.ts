import { asApprovalId, asTaskId, dataPaths } from '@multicode/core';
import { SqliteStore } from '@multicode/persistence';
import { loadConfig, type GlobalOptions } from '../config-loader.js';
import { print, printErr } from '../output.js';

export interface ApproveOptions extends GlobalOptions {
  deny?: boolean;
  note?: string;
}

/**
 * Resolve a pending approval from the CLI. If a server is running, its orchestrator polls the store and
 * unblocks the waiting task automatically; otherwise the decision is simply recorded for audit.
 */
export const runApprove = async (approvalId: string, opts: ApproveOptions): Promise<number> => {
  const config = loadConfig(opts);
  const store = await SqliteStore.open({ path: dataPaths(config.dataDir).database });
  try {
    const approval = await store.getApproval(asApprovalId(approvalId));
    if (!approval) {
      printErr(`Approval ${approvalId} not found.`);
      return 1;
    }
    if (approval.status !== 'pending') {
      printErr(`Approval ${approvalId} is already ${approval.status}.`);
      return 1;
    }
    const decision = opts.deny ? 'denied' : 'approved';
    await store.resolveApproval(asApprovalId(approvalId), decision, opts.note ? { note: opts.note } : {});
    await store.appendEvents(asTaskId(approval.taskId), [
      { type: 'approval.resolved', approvalId: asApprovalId(approvalId), decision },
    ]);
    print(`Approval ${approvalId} ${decision}.`);
    return 0;
  } finally {
    await store.close();
  }
};
