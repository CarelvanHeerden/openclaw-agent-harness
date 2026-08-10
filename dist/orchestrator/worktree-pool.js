/**
 * beta.117: isolated checkouts for parallel sub-tasks.
 *
 * Parallelism has existed since b91 but has always shipped disabled, and the
 * reason is not caution -- it is that the design is unsafe. Concurrent workers
 * share ONE worktree and ONE git index, and `GitAdapter.commit` stages with an
 * unscoped `git add -A` under no lock. Whichever worker finishes first sweeps
 * up whatever the others have half-written at that instant and commits it under
 * its own message. Nothing detects this; the run simply produces commits whose
 * contents do not match their subjects.
 *
 * b91's overlap guard does not save it. That guard compares DECLARED
 * `filesLikelyTouched`, and declaration is demonstrably unreliable: in the b113
 * run a worker regenerated 141 `okf/**` files it never declared, which is the
 * entire reason b114 exists. Under parallelism an undeclared write is not a
 * bloated diff, it is cross-contamination between commits.
 *
 * So each concurrent worker gets its own checkout. Two design choices follow
 * from measurement rather than taste, both taken against ProjectThanos
 * (1.8 GB of `node_modules`, 97,149 files):
 *
 *   npm ci                 25s
 *   hardlink walk (node)   43s
 *   APFS clonefile         36s
 *   symlink                0.17s
 *
 * 1. A POOL, not a worktree per sub-task. Eight sub-tasks over three cycles is
 *    up to 24 allocations; at 25s of install each that is ten minutes, more
 *    than parallelism saves. A pool of `size` checkouts is created at most once
 *    per run and reset between dispatches, so the install is paid `size` times
 *    for the whole run.
 *
 * 2. A REAL install per pooled worktree, not a shared `node_modules`. The
 *    symlink is 150x faster and was tempting, but it reintroduces precisely the
 *    hazard this module exists to remove: one `npm install` from any worker
 *    would reach through the link and mutate every other worker's dependencies,
 *    and b109 is on record doing exactly that (a worker ran `npm install` for
 *    `prisma format` and swept 12,291 cache files into a commit). Isolation
 *    that leaks under the one failure mode we have actually observed is not
 *    isolation. With a pool, the honest version costs ~25s once.
 *
 * The pool owns leases only. Allocation, reset and release are injected, so
 * this is testable without git.
 */
/**
 * Branch name for a slot. Deterministic, so a re-run reuses the ref.
 *
 * A SIBLING (`harness/feat-w1`), never a child (`harness/feat/w1`). Git stores
 * refs as a directory tree, so `refs/heads/harness/feat` being a file makes
 * `refs/heads/harness/feat/w1` unrepresentable -- `worktree add` fails with
 * "cannot lock ref ... 'refs/heads/harness/feat' exists". The child form is the
 * obvious way to name these and it cannot work; only a real-git test finds that.
 */
export function slotBranch(sessionBranch, slot) {
    return `${(sessionBranch ?? "").replace(/[/\-]+$/, "")}-w${slot}`;
}
/**
 * A fixed set of checkouts leased to workers one at a time.
 *
 * `acquire` resolves as soon as a slot is free, so callers may await it in the
 * dispatcher's fill loop without tracking availability themselves.
 */
export class WorktreePool {
    size;
    sessionBranch;
    deps;
    /** Slots that exist on disk, by slot number. */
    created = new Map();
    /** Slots not currently leased. */
    free = [];
    /** Slot numbers never yet created; drained before any waiting happens. */
    uncreated = [];
    /** FIFO of callers waiting for a slot to come back. */
    waiters = [];
    draining = false;
    constructor(opts) {
        this.size = Math.max(0, Math.floor(opts.size || 0));
        this.sessionBranch = opts.sessionBranch;
        this.deps = opts.deps;
        for (let i = 1; i <= this.size; i++)
            this.uncreated.push(i);
    }
    /** True when the pool can hand out at least one isolated checkout. */
    get enabled() {
        return this.size > 0;
    }
    /** Slots actually created on disk. Zero until the first concurrent dispatch. */
    get createdCount() {
        return this.created.size;
    }
    /**
     * Lease a checkout positioned at `sha`.
     *
     * Prefers an already-created free slot over creating a new one, so a run that
     * never truly overlaps pays a single install however large `size` is.
     */
    async acquire(sha) {
        if (!this.enabled)
            throw new Error("worktree pool is disabled (size 0)");
        if (this.draining)
            throw new Error("worktree pool is draining");
        const existing = this.free.pop();
        if (existing) {
            await this.deps.reset(existing, sha);
            return existing;
        }
        const slot = this.uncreated.shift();
        if (slot !== undefined) {
            const branch = slotBranch(this.sessionBranch, slot);
            let path;
            try {
                path = await this.deps.create(slot, branch);
            }
            catch (err) {
                // Put the slot back so a later acquire can retry; a transient failure
                // (disk, network) must not permanently shrink the pool.
                this.uncreated.unshift(slot);
                throw err;
            }
            const wt = { path, branch, slot };
            this.created.set(slot, wt);
            await this.deps.reset(wt, sha);
            return wt;
        }
        // Everything is created and leased: wait for a release.
        const wt = await new Promise((resolve) => this.waiters.push(resolve));
        await this.deps.reset(wt, sha);
        return wt;
    }
    /**
     * Return a lease. Hands the slot straight to the longest-waiting caller when
     * there is one, so a released slot never sits idle while a worker waits.
     */
    release(wt) {
        const next = this.waiters.shift();
        if (next) {
            next(wt);
            return;
        }
        if (!this.free.includes(wt))
            this.free.push(wt);
    }
    /**
     * Destroy every created checkout. Best-effort and never throws: a run that
     * has already shipped must not fail because a directory would not delete.
     */
    async drain() {
        this.draining = true;
        const all = [...this.created.values()];
        this.created.clear();
        this.free.length = 0;
        for (const wt of all) {
            try {
                await this.deps.destroy(wt);
            }
            catch (err) {
                this.deps.logger?.warn("[worktree-pool] slot destroy failed (non-fatal)", { slot: wt.slot, err: String(err) });
            }
        }
    }
}
//# sourceMappingURL=worktree-pool.js.map