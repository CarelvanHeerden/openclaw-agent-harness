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
export type CiState = "success" | "failure" | "pending" | "none" | "unknown";
/**
 * beta.119: the structured evidence behind a CI verdict. `getCombinedStatus`
 * collapses this to a bare state for the merge-time gate; the polling loop
 * consumes the whole snapshot so it can apply the check-count high-water mark
 * (see `pollCiStatus`) that a single reading cannot.
 */
export interface CiSnapshot {
    state: CiState;
    /** Both API reads succeeded. When false the state is always "unknown". */
    statusReadable: boolean;
    checksReadable: boolean;
    /** Legacy Statuses API. */
    statusState: string;
    statusCount: number;
    /** Check Runs API. */
    checkTotal: number;
    checkIncomplete: number;
    checkFailed: number;
    /** Completed with a conclusion we affirmatively recognise as non-red. */
    checkPassed: number;
    /** Which rule produced `state`, for the audit trail. */
    reason: string;
    /**
     * beta.124: set when a signal was unreadable for a reason that WAITING WILL
     * NOT FIX -- 401/403/404 from GitHub, which mean the token is wrong, lacks a
     * permission, or cannot see the repo. Empty when the failure is transient
     * (5xx, rate limit, network) or when nothing failed.
     *
     * The b123 smoke burned 896 seconds across 44 polls on a check-runs 403 and
     * then reported "could NOT determine CI state", which is true and useless:
     * the answer had arrived, unchanged, on the first poll. The value here is
     * the remedy, phrased for whoever has to go and fix the token.
     */
    permanentDenial: string;
}
/**
 * beta.34: combined CI status for a commit SHA, merging the legacy Statuses API
 * and the Check Runs API into one verdict.
 *
 * beta.119: this gate used to FAIL OPEN, and the b118 smoke shipped on it.
 * ProjectThanos PR #986 was declared green at 21:10:45 while Lint had failed at
 * 21:10:17 and Tests failed at 21:13:39. The old code read both APIs but guarded
 * the check-runs branch with a bare `if (cRes.ok)` and no else, so an
 * unreadable -- or transiently empty, which the Check Runs API genuinely does
 * return under eventual consistency -- check-run list was indistinguishable
 * from "this repo has no check runs". The "nothing configured" guard then
 * required BOTH sources to be empty, and ProjectThanos has exactly one legacy
 * status (Vercel). So the moment Vercel's deploy went green the function fell
 * through `anySuccess` and reported the whole commit green, blind to all ten
 * Actions checks. The old body also ENDED in `return "success"`, making success
 * the default for every state not explicitly matched.
 *
 * The rules below invert that: success requires positive evidence from every
 * signal, and anything we could not read is "unknown", never a pass.
 */
export declare function getCiSnapshot(input: {
    repoFullName: string;
    sha: string;
    ghToken: string;
    apiBase?: string;
}): Promise<CiSnapshot>;
/**
 * beta.119: the OAuth scopes GitHub reports for this token.
 *
 * GitHub returns `x-oauth-scopes` on any authenticated request, but ONLY for
 * classic PATs and OAuth tokens. Fine-grained PATs and GitHub App installation
 * tokens return it absent or empty while being perfectly capable, so `null`
 * here means "cannot tell" and must never be read as "cannot do". Never throws.
 */
export declare function getTokenScopes(input: {
    ghToken: string;
    apiBase?: string;
}): Promise<string[] | null>;
/** beta.34 / beta.119: the bare state. Prefer `getCiSnapshot` where the evidence matters. */
export declare function getCombinedStatus(input: {
    repoFullName: string;
    sha: string;
    ghToken: string;
    apiBase?: string;
}): Promise<CiState>;
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