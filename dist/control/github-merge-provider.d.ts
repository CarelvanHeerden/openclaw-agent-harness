import type { DatabaseSync } from "node:sqlite";
import type { MergeProvider } from "./merge.js";
import type { getCiSnapshot, getPullRequest, mergePullRequest } from "../adapters/github.js";
type PullRequest = Awaited<ReturnType<typeof getPullRequest>>;
type CiSnapshot = Awaited<ReturnType<typeof getCiSnapshot>>;
type MergeResult = Awaited<ReturnType<typeof mergePullRequest>>;
export interface BoundControlCredential {
    route: {
        apiBase?: string;
    };
    token: string;
}
export interface ControlMergeProviderDependencies {
    db: DatabaseSync;
    resolveCredential(runId: string, repository: string, prNumber: number, requesterId: string): Promise<BoundControlCredential>;
    getPullRequest(input: {
        repoFullName: string;
        prNumber: number;
        ghToken: string;
        apiBase?: string;
    }): Promise<PullRequest>;
    getCiSnapshot(input: {
        repoFullName: string;
        sha: string;
        ghToken: string;
        apiBase?: string;
    }): Promise<CiSnapshot>;
    mergePullRequest(input: {
        repoFullName: string;
        prNumber: number;
        ghToken: string;
        apiBase?: string;
        method: "squash";
        expectedHeadSha: string;
    }): Promise<MergeResult>;
}
export declare function createControlMergeProvider(deps: ControlMergeProviderDependencies): MergeProvider;
export {};
//# sourceMappingURL=github-merge-provider.d.ts.map