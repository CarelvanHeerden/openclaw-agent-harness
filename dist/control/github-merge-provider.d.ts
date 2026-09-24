import type { DatabaseSync } from "node:sqlite";
import type { MergeProvider } from "./merge.js";
import type { getCiSnapshot, getPullRequest, mergePullRequest } from "../adapters/github.js";
type PullRequest = Awaited<ReturnType<typeof getPullRequest>>;
type CiSnapshot = Awaited<ReturnType<typeof getCiSnapshot>>;
type MergeResult = Awaited<ReturnType<typeof mergePullRequest>>;
export interface BoundControlCredential {
    route: {
        provider?: "github" | "gitlab";
        apiBase?: string;
    };
    token: string;
}
export interface ControlMergeProviderDependencies {
    db: DatabaseSync;
    resolveCredential(runId: string, repository: string, prNumber: number, requesterId: string): Promise<BoundControlCredential>;
    getPullRequest(input: {
        provider?: "github" | "gitlab";
        repoFullName: string;
        prNumber: number;
        ghToken: string;
        apiBase?: string;
        signal?: AbortSignal;
    }): Promise<PullRequest>;
    getCiSnapshot(input: {
        provider?: "github" | "gitlab";
        repoFullName: string;
        sha: string;
        ghToken: string;
        apiBase?: string;
        signal?: AbortSignal;
    }): Promise<CiSnapshot>;
    mergePullRequest(input: {
        provider?: "github" | "gitlab";
        repoFullName: string;
        prNumber: number;
        ghToken: string;
        apiBase?: string;
        method: "squash";
        expectedHeadSha: string;
        signal?: AbortSignal;
    }): Promise<MergeResult>;
}
export declare function createControlMergeProvider(deps: ControlMergeProviderDependencies, deadlineMs?: number): MergeProvider;
export {};
//# sourceMappingURL=github-merge-provider.d.ts.map