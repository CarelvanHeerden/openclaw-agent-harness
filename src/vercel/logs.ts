/**
 * Vercel logs bridge (optional).
 *
 * Fetches preview deployment logs for the current branch so the adversarial
 * reviewer can observe real runtime behaviour of the AI-authored code.
 *
 * Adversarial-review rule: if `enabled` is true but no preview deploy exists
 * yet, the adversary MUST NOT silently review blind. Instead:
 *   - the caller polls `waitForPreview()` up to `previewWaitSeconds`,
 *   - if still no deploy, `fetchBranchLogs()` returns
 *     `{ status: "no_deploy_yet", ... }` and the adversary receives an
 *     explicit "NO RUNTIME DATA" banner in its prompt (see
 *     orchestrator/fable5-adversary.ts).
 *
 * PHASE 0 SCAFFOLD.
 */

export interface VercelLogsInput {
  team: string;
  project: string;
  branch: string;
  token: string;
  maxLines?: number;
  previewWaitSeconds?: number;  // 0 disables wait
}

export type VercelLogsStatus =
  | "ok"
  | "no_deploy_yet"
  | "build_failed"
  | "unavailable";

export interface VercelLogsResult {
  status: VercelLogsStatus;
  deploymentUrl?: string;
  deploymentId?: string;
  logs: string;
  errorCount: number;
  hasErrors: boolean;
  fetchedAt: number;
}

export async function waitForPreview(
  _input: Pick<VercelLogsInput, "team" | "project" | "branch" | "token">,
  _timeoutSeconds: number,
): Promise<{ found: boolean; deploymentUrl?: string; deploymentId?: string }> {
  // TODO(phase-4): poll Vercel deployments API filtered by
  //   gitSource.ref = branch. Return as soon as latest deployment is
  //   in READY, ERROR, or CANCELED state.
  throw new Error("waitForPreview: not implemented (phase-0 scaffold)");
}

export async function fetchBranchLogs(
  _input: VercelLogsInput,
): Promise<VercelLogsResult> {
  // TODO(phase-4): call Vercel REST API for deployment events / build logs.
  //   Count errors. Return status="no_deploy_yet" if the branch has no
  //   deployment yet. Return status="build_failed" if the latest deployment
  //   errored during build (adversary should treat that as a hard finding).
  throw new Error("fetchBranchLogs: not implemented (phase-0 scaffold)");
}
