/**
 * Vercel preview-deployment bridge.
 *
 * Given a repo + branch, waits (bounded) for a preview deployment to reach
 * READY / ERROR, then returns an excerpt of its runtime logs so the
 * adversary can review real behaviour, not just the diff.
 *
 * We treat READY as "ok" and ERROR (build or runtime) as "build_failed".
 * If no deployment appears in `preview_wait_seconds`, we return
 * `no_deploy_yet` and the adversary's runtime dimension is force-flagged
 * MEDIUM (see fable5-adversary.ts).
 *
 * Optional (config-driven): if `harness.vercel.enabled` is false, this
 * module is never called and adversary review skips runtime silently.
 */
export type RuntimeStatus = "ok" | "no_deploy_yet" | "build_failed" | "unavailable";
export interface RuntimeSnapshot {
    provider: "vercel" | "manual" | "local";
    status: RuntimeStatus;
    deploymentUrl?: string;
    logsExcerpt?: string;
    errorCount?: number;
    /** Present when provider="manual" (see harness_upload_logs tool). */
    uploadedAt?: number;
    uploadedBy?: string;
    source?: string;
    /**
     * beta.7 fix #1: local observable-side-effect verification results. When
     * the Vercel/manual runtime is unavailable, sub-task verification (branch
     * pushed, PR opened, file written, commit made) is surfaced here so the
     * adversary has hard "did the observable output actually happen?" data
     * instead of `runtime: no runtime data`.
     */
    localVerification?: Array<{
        seq: number;
        ok: boolean;
        summary: string;
    }>;
}
export interface FetchLogsInput {
    vercelToken: string;
    teamId?: string;
    projectId: string;
    branch: string;
    waitSeconds: number;
    pollIntervalMs?: number;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
interface VercelDeployment {
    uid: string;
    url: string;
    state: "BUILDING" | "READY" | "ERROR" | "QUEUED" | "CANCELED";
    meta?: {
        githubCommitRef?: string;
        branchAlias?: string;
    };
    created: number;
}
/**
 * Wait for the latest deployment on `branch` to reach a terminal state.
 * Returns the deployment record or null if the wait window elapses.
 */
export declare function waitForPreview(input: FetchLogsInput): Promise<VercelDeployment | null>;
/**
 * Fetch build + runtime logs for a deployment. We concat the last N lines
 * of each and return a bounded excerpt (adversary tokens are precious).
 */
export declare function fetchBranchLogs(input: FetchLogsInput): Promise<RuntimeSnapshot>;
export {};
//# sourceMappingURL=logs.d.ts.map