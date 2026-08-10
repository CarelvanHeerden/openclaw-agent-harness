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
/** A promise-chain mutex. Fair, and small enough to read in one sitting. */
export class Mutex {
    tail = Promise.resolve();
    async run(fn) {
        const prior = this.tail;
        let release;
        this.tail = new Promise((r) => (release = r));
        await prior;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
}
/** Commits on the worker's branch that are not yet on the session branch, oldest first. */
export async function commitsToReplay(git, req) {
    const out = await git.run(req.workerWorktree, ["rev-list", "--reverse", `${req.baseSha}..HEAD`]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
/** Paths git reports as conflicted mid-merge. */
export async function conflictedPaths(git, cwd) {
    try {
        const out = await git.run(cwd, ["diff", "--name-only", "--diff-filter=U"]);
        return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Bring a worker's commits onto the session branch.
 *
 * On conflict the merge is ABORTED before returning, so the session worktree is
 * left clean and the next sub-task in the queue is not handed a repository
 * stuck mid-merge. The contract is that the session branch either advances
 * fully or is left completely untouched.
 */
export async function mergeBackSubTask(git, req) {
    let landed;
    try {
        landed = await commitsToReplay(git, req);
    }
    catch (err) {
        return { ok: false, reason: "error", conflictedPaths: [], detail: `could not list commits: ${String(err)}` };
    }
    if (landed.length === 0) {
        // A worker that changed nothing is routine, especially on revise cycles,
        // and must not read as a failure.
        return { ok: true, landed: [], fastForward: true, headSha: await git.headSha(req.sessionWorktree).catch(() => "") };
    }
    const before = await git.headSha(req.sessionWorktree).catch(() => "");
    try {
        await git.run(req.sessionWorktree, ["merge", "--no-edit", req.workerBranch]);
    }
    catch (err) {
        const paths = await conflictedPaths(git, req.sessionWorktree);
        await git.run(req.sessionWorktree, ["merge", "--abort"]).catch(() => undefined);
        return {
            ok: false,
            reason: paths.length > 0 ? "conflict" : "error",
            conflictedPaths: paths,
            detail: paths.length > 0
                ? `sub-task ${req.seq} touched ${paths.join(", ")}, which another parallel worker also changed`
                : `merge of ${req.workerBranch} failed: ${String(err)}`,
        };
    }
    const headSha = await git.headSha(req.sessionWorktree).catch(() => "");
    // A fast-forward lands the worker's last commit as the new tip; anything else
    // means git had to synthesise a merge commit because the tip had moved.
    const fastForward = headSha === landed[landed.length - 1];
    return { ok: true, landed, fastForward, headSha: headSha || before };
}
//# sourceMappingURL=merge-back.js.map