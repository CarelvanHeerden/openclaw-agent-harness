/**
 * GitHub PR adapter.
 *
 * Pushes a session's branch to origin and opens a PR against the base
 * branch. The PR body embeds the adversary's summary so a human reviewer
 * sees the harness's own verdict without opening the review JSON.
 *
 * Auth uses the session-specific GH token resolved by PatRouter — the
 * token is only ever passed via env-var to git and via Authorization
 * header to the REST API. It never appears in .gitconfig or the URL.
 */
import type { ReviewReport } from "../orchestrator/fable5-adversary.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { GitAdapter } from "./git-worktree.js";
export interface OpenPrInput {
    worktreePath: string;
    repoFullName: string;
    baseBranch: string;
    headBranch: string;
    brief: CrystallisedBrief;
    reviewReport: ReviewReport;
    ghToken: string;
    requesterHandle: string;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
    git: GitAdapter;
    fetchImpl?: typeof fetch;
}
export declare function pushBranchAndOpenPr(input: OpenPrInput): Promise<string>;
export declare function buildPrBody(input: OpenPrInput): string;
//# sourceMappingURL=github-pr.d.ts.map