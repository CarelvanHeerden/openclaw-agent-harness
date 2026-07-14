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
}
export interface CreatePrOutput {
    number: number;
    htmlUrl: string;
    nodeId: string;
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
//# sourceMappingURL=github.d.ts.map