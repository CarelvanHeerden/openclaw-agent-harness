export declare function getGitLabRevision(input: {
    repoFullName: string;
    ref: string;
    token: string;
    apiBase: string;
    signal?: AbortSignal;
}): Promise<string>;
export declare function getGitLabMergeRequest(input: {
    repoFullName: string;
    prNumber: number;
    token: string;
    apiBase: string;
    signal?: AbortSignal;
}): Promise<{
    headSha: string;
    state: string;
    merged: boolean;
    mergeCommitSha: string | null;
    mergeable: null;
    baseBranch: string;
    headRepoFullName: string;
    headRef: string;
    draft: boolean;
    htmlUrl: string;
}>;
export declare function getGitLabCiSnapshot(input: {
    repoFullName: string;
    sha: string;
    token: string;
    apiBase: string;
    signal?: AbortSignal;
}): Promise<import("./github.js").CiSnapshot>;
export declare function getGitLabMergeRequestFiles(input: {
    repoFullName: string;
    prNumber: number;
    token: string;
    apiBase: string;
    signal?: AbortSignal;
}): Promise<{
    patch?: string | undefined;
    filename: string;
    status: string;
}[]>;
export declare function mergeGitLabMergeRequest(input: {
    repoFullName: string;
    prNumber: number;
    token: string;
    apiBase: string;
    expectedHeadSha: string;
    signal?: AbortSignal;
}): Promise<{
    merged: boolean;
    sha: string;
    message: string;
}>;
//# sourceMappingURL=gitlab.d.ts.map