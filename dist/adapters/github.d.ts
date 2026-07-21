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