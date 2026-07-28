/**
 * GitHub REST adapter for the ONE operation the harness performs: open a
 * pull request. Everything else (push, fetch) goes through git.
 *
 * We deliberately do NOT wrap the whole Octokit surface. The plugin should
 * touch as little of GitHub as possible.
 */
export interface CreatePrInput {
    repoFullName: string;
    head: string;
    base: string;
    title: string;
    body: string;
    ghToken: string;
    draft?: boolean;
    /**
     * beta.57 (P3): REST API base. Defaults to public github.com; pass the
     * resolved provider apiBase so GitHub Enterprise hosts work (every other
     * REST call already routes through resolution.apiBase; this adapter was
     * the one hardcoded holdout).
     */
    apiBase?: string;
}
export interface CreatePrOutput {
    number: number;
    htmlUrl: string;
    nodeId: string;
    /** beta.44: true when the PR already existed (revise) and was updated by the push, not newly created. */
    updatedExisting?: boolean;
}
export declare function createPullRequest(input: CreatePrInput): Promise<CreatePrOutput>;
/**
 * beta.75 (#1): post a comment on a PR (issue-comments endpoint).
 *
 * WHY: `createPullRequest` writes the review verdict/findings into the PR
 * BODY only at CREATE time. On a re-push to an EXISTING PR (a revise, or a
 * harness_run that D2 promoted onto an open-PR branch), the commits update the
 * PR diff but nothing surfaces the NEW review outcome -- so a `do_not_merge`
 * verdict + its findings were invisible on the PR itself (Carel on #876: "the
 * new test file is there but the PR comments didn't update"). Posting a fresh
 * comment on every review makes each review's verdict/findings visible on the
 * PR timeline, not just in the harness DB. Best-effort: a failed comment must
 * NEVER fail the run (the code + PR already landed), so callers swallow errors.
 */
export declare function postPrComment(input: {
    repoFullName: string;
    prNumber: number;
    body: string;
    ghToken: string;
    apiBase?: string;
}): Promise<{
    ok: boolean;
    status: number;
    htmlUrl?: string;
    error?: string;
}>;
/**
 * Sanity-check that a PAT can see a repo. Used at session-start so we
 * fail fast with a clear Slack error instead of dying mid-worker.
 */
export declare function verifyRepoAccess(input: {
    repoFullName: string;
    ghToken: string;
}): Promise<{
    ok: boolean;
    status: number;
    scopes?: string;
    reason?: string;
}>;
/** beta.34: fetch a PR's head SHA + state (open/closed, merged). */
export declare function getPullRequest(input: {
    repoFullName: string;
    prNumber: number;
    ghToken: string;
}): Promise<{
    headSha: string;
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    baseBranch: string;
}>;
/**
 * beta.34: combined CI status for a commit SHA. Merges the legacy Statuses
 * API and the Check Runs API into one verdict: "success" | "failure" |
 * "pending" | "none" (no checks configured).
 */
export declare function getCombinedStatus(input: {
    repoFullName: string;
    sha: string;
    ghToken: string;
}): Promise<"success" | "failure" | "pending" | "none">;
/**
 * beta.81 (Track B / B2): fetch a short excerpt of the FAILING check-runs for a
 * commit SHA -- each failed run's name, conclusion, and output title/summary --
 * so the harness can surface WHY CI is red as the revise finding source. Never
 * throws; returns "" on any error or when nothing failed.
 */
export declare function getFailingCheckLogs(input: {
    repoFullName: string;
    sha: string;
    ghToken: string;
    apiBase?: string;
}): Promise<string>;
/** beta.34: merge a PR (squash by default). Returns the merge commit SHA. */
export declare function mergePullRequest(input: {
    repoFullName: string;
    prNumber: number;
    ghToken: string;
    method?: "squash" | "merge" | "rebase";
    commitTitle?: string;
}): Promise<{
    merged: boolean;
    sha: string;
    message: string;
}>;
//# sourceMappingURL=github.d.ts.map