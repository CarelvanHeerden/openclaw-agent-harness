/**
 * beta.117: bringing a parallel worker's commits onto the session branch.
 *
 * With b117 each concurrent worker commits in its own checkout on its own
 * sibling branch, so its commits are not on the session branch until they are
 * brought across. That is the only place two workers' work meets, and it runs
 * under a mutex: git will not take two index operations in one worktree, and a
 * lock turns a race into a queue.
 *
 * MERGE, NOT CHERRY-PICK. The first draft replayed commits with cherry-pick for
 * linear history, which was wrong for a reason that has nothing to do with
 * aesthetics. Cherry-pick writes NEW shas, and the b101 ledger guard checks
 * that every sha the harness recorded is still reachable from HEAD -- unioning
 * `sub_tasks.commit_sha` with the append-only `loop.worker_end_turn` audit
 * events precisely so the record cannot be erased. After a cherry-pick the
 * worker's original commit lives only on the slot branch, so every parallel
 * sub-task would be reported as lost work by the guard that exists to detect
 * lost work. Rewriting the table would not have been enough; the audit log is
 * append-only by design.
 *
 * Merging keeps the worker's own commit in history, so the ledger stays true
 * with no translation layer. It also costs less history noise than expected:
 * the slot branch is cut from the session tip, so when no other worker has
 * landed in the meantime the merge FAST-FORWARDS and adds no commit at all. A
 * merge commit appears only on genuine overlap, which is exactly when the
 * history should record that two lines of work converged.
 *
 * THE CONFLICT IS THE POINT. Today two workers writing the same undeclared file
 * silently corrupt each other's commits and nothing in the harness can tell.
 * Bringing them onto a shared branch turns that same collision into a merge
 * conflict: loud, attributable to a specific sub-task, and recoverable by
 * re-running that one sub-task serially. A failure we can see beats a
 * corruption we cannot.
 */
/** Minimal git surface, injected so this is testable without a repo. */
export interface MergeBackGit {
    /** `git -C <cwd> <args>`; must reject on non-zero exit. */
    run: (cwd: string, args: string[]) => Promise<string>;
    /** Current HEAD sha of a checkout. */
    headSha: (cwd: string) => Promise<string>;
}
export interface MergeBackRequest {
    /** The integration checkout, which has the session branch checked out. */
    sessionWorktree: string;
    /** The worker's isolated checkout. */
    workerWorktree: string;
    /** The worker's branch, merged into the session branch. */
    workerBranch: string;
    /** Sha the worker's branch started from (the session tip at dispatch). */
    baseSha: string;
    /** For audit lines. */
    seq: number;
}
export type MergeBackResult = {
    ok: true;
    /** The worker's own commits, still reachable from the session branch. */
    landed: string[];
    /** True when the session tip had not moved and no merge commit was needed. */
    fastForward: boolean;
    headSha: string;
} | {
    ok: false;
    reason: "conflict" | "error";
    conflictedPaths: string[];
    detail: string;
};
/** A promise-chain mutex. Fair, and small enough to read in one sitting. */
export declare class Mutex {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
/** Commits on the worker's branch that are not yet on the session branch, oldest first. */
export declare function commitsToReplay(git: MergeBackGit, req: MergeBackRequest): Promise<string[]>;
/** Paths git reports as conflicted mid-merge. */
export declare function conflictedPaths(git: MergeBackGit, cwd: string): Promise<string[]>;
/**
 * Bring a worker's commits onto the session branch.
 *
 * On conflict the merge is ABORTED before returning, so the session worktree is
 * left clean and the next sub-task in the queue is not handed a repository
 * stuck mid-merge. The contract is that the session branch either advances
 * fully or is left completely untouched.
 */
export declare function mergeBackSubTask(git: MergeBackGit, req: MergeBackRequest): Promise<MergeBackResult>;
//# sourceMappingURL=merge-back.d.ts.map