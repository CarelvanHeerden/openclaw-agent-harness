/**
 * rc.9 -- does the work this database claims to have still exist?
 *
 * StitchGuard, session f7c4e585, 2026-09-14 ~19:42. A container restart, and
 * then two startup checks that both reported success:
 *
 *   5431  harness.worktrees_preflight  {ok:true, created:false}
 *   5432  harness.worktree_heal        {scanned:0, removed:0, errors:[]}
 *
 * Both were telling the truth about what they measure, and together they were
 * profoundly misleading. The worktrees root is a tmpfs mount, so the restart
 * took every worktree with it -- and the bare object cache too, because the git
 * adapter puts `.repos/<owner>/<repo>.git` INSIDE the worktrees root. Nine
 * recorded commits existed nowhere else. Meanwhile the state DB sat on a
 * host-backed virtiofs mount and survived perfectly, still holding a paused
 * session, a worktree path and all nine SHAs.
 *
 * The healer could not see any of that because it only ever walks ONE way:
 * enumerate the directories on disk, look each one up in the database, decide
 * whether to reap it. An empty root means the loop body never runs. `scanned:0`
 * is not "nothing to check", it is "nothing left to check WITH".
 *
 * This module walks the other way -- from the rows that claim work to the disk
 * that should be holding it -- and writes down what it finds. Two rules:
 *
 *   - It NEVER deletes anything. Reconciliation is diagnosis. Deletion stays
 *     with the healer, whose protections (live loops, paused sessions, in-flight
 *     allocations, worktrees an abort deliberately preserved) are unchanged.
 *   - "I could not tell" is recorded as `unknown`, never as `ok`. A writable
 *     directory is not a durable one, and that conflation is the incident.
 */
/** What a reconciliation concluded about one session's local storage. */
export type StorageState = 
/** Worktree, object store and every recorded commit are present. */
"ok"
/** The recorded worktree directory is gone. */
 | "missing_worktree"
/** The worktree is there but the bare object cache backing it is not. */
 | "missing_objects"
/** Both exist, but commits this session recorded are not reachable. */
 | "missing_commits"
/** A check could not be completed. Explicitly NOT `ok`. */
 | "unknown";
export interface SessionStorageFinding {
    sessionId: string;
    state: StorageState;
    /** Operator-facing detail. Safe to surface: paths and counts, no contents. */
    reason: string;
    /** Commits the session recorded that could not be found. */
    missingCommits: string[];
}
/** A session row as the reconciliation needs to see it. */
export interface ReconcilableSession {
    id: string;
    status: string;
    repo: string;
    branch: string | null;
    worktreePath: string | null;
    /** Commit SHAs this session recorded as its own work. */
    recordedCommits: string[];
}
export declare function claimsLocalStorage(status: string): boolean;
/**
 * The bare object cache the git adapter would use for a repo.
 *
 * Diagnostic only -- it describes the adapter's layout, and the incident's
 * fatal detail is that this path sits INSIDE the worktrees root and therefore
 * shares its mount's fate. Reconciliation does not decide anything from it;
 * see the `.git` link resolution below for why.
 */
export declare function bareCachePathFor(worktreesRoot: string, repoFullName: string): string;
export interface ReconcileDeps {
    worktreesRoot: string;
    exists?: (p: string) => boolean;
    /** Reads a `.git` link file. Without it, object-store checks are skipped rather than guessed. */
    readText?: (p: string) => string;
    /**
     * Which of `shas` are NOT reachable in the repository at `worktreePath`.
     * Injected because it shells out to git. When absent, commit reachability is
     * simply not claimed -- an unchecked commit must not read as a verified one.
     */
    unreachableCommits?: (worktreePath: string, shas: string[]) => Promise<string[]>;
}
/**
 * Walk session rows -> disk and report what is missing.
 *
 * Ordered cheapest-first and short-circuiting: there is no point asking git
 * about commits in a directory that is not there.
 */
export declare function reconcileSessionsToDisk(sessions: readonly ReconcilableSession[], deps: ReconcileDeps): Promise<SessionStorageFinding[]>;
/**
 * Is this checkpoint root capable of outliving the worktrees it protects?
 *
 * A checkpoint stored inside the worktrees root is not a checkpoint. That is
 * not a hypothetical: it is precisely the shape of the incident, where the bare
 * object cache -- the only other copy of every commit -- lived at
 * `<worktrees_root>/.repos/...` and died with the mount it was nested in.
 */
export declare function checkpointRootIsSafe(checkpointRoot: string, worktreesRoot: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export interface StorageProbe {
    path: string;
    exists: boolean;
    /** st_dev, which is how you tell a nested mount from its parent. */
    device?: number;
    /** True when the device differs from the parent's -- i.e. a mount boundary. */
    separateMount?: boolean;
    /** Filesystem type, when `/proc/self/mountinfo` is readable. */
    fsType?: string;
    /**
     * The filesystem is known not to survive a restart. `undefined` means
     * UNKNOWN, which is not the same as durable and must not be reported as such.
     */
    volatile?: boolean;
    note?: string;
}
/**
 * What kind of storage is this path on?
 *
 * Honest about its own limits: `/proc/self/mountinfo` does not exist on macOS
 * and may be unreadable in a locked-down container, and in that case `volatile`
 * stays undefined rather than defaulting to "fine". The rc.8 preflight's
 * problem was not that it was wrong, it was that `ok:true` read as a broader
 * claim than "I created and deleted a file here".
 */
export declare function probeStorage(path: string, readMountInfo?: () => string): StorageProbe;
//# sourceMappingURL=storage-health.d.ts.map