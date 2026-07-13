/**
 * Sonnet worker: bounded sub-task executor.
 *
 * Runs as its own Claude Agent SDK session, scoped to a specific worktree
 * and a specific allow-list of paths. Bash whitelist / denylist enforced via
 * SDK permission callback. Reports back a structured WorkerResult.
 *
 * PHASE 0 SCAFFOLD.
 */

export interface WorkerInput {
  subTaskId: string;
  description: string;
  worktreePath: string;
  allowedPaths: string[];
  model: string;
  budgetUsd: number;
  timeoutSeconds: number;
  safety: {
    permissionMode: "acceptEdits" | "bypassPermissions" | "plan";
    bashWhitelist: string[];
    bashDenylistPatterns: string[];
    pathDenylist: string[];
  };
}

export interface WorkerResult {
  subTaskId: string;
  status: "ok" | "failed" | "timed_out" | "over_budget";
  filesTouched: string[];
  summary: string;
  costUsd: number;
  transcriptPath?: string;
}

export async function runWorker(_input: WorkerInput): Promise<WorkerResult> {
  // TODO(phase-2): spawn @anthropic-ai/claude-agent-sdk with:
  //   - cwd = worktreePath
  //   - permission callback enforcing whitelists
  //   - onEvent: stream to Slack thread (batched)
  //   - track cost from result event
  throw new Error("runWorker: not implemented (phase-0 scaffold)");
}
