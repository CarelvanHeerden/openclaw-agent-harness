/**
 * beta.17: startup worktree self-heal.
 *
 * Even with beta.17's correct release wiring, leftover worktrees can exist
 * on disk from crashes, container recreates, aborted deploys, or (most
 * commonly) pre-beta.17 sessions where the release call was silently
 * broken. On restart we scan the worktrees root for leftover directories,
 * cross-check against the sessions table, and force-remove any worktree
 * whose owning session is terminal (done/failed/aborted) or entirely
 * unknown to the DB.
 *
 * Belt-and-suspenders on top of the beta.16 loop-side release. Also fixes
 * historical debt: any `pending-<ts>` worktree left behind by pre-beta.17
 * gets cleaned up on the first restart after upgrading.
 */
import type { StateStore } from "./store.js";
export interface WorktreeHealDeps {
    /** List directories directly under the worktrees root (excluding .repos). */
    listWorktreeDirs: () => Promise<string[]>;
    /** Force-remove a specific worktree path. */
    releaseByPath: (worktreePath: string, repoFullName: string) => Promise<{
        ok: boolean;
        path: string;
        error?: string;
    }>;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    /** Provide a plausible default repo for `pending-<ts>` worktrees without a matching session row. Used only for `git worktree prune` routing; the release still works on the path. */
    fallbackRepoFullName?: string;
    /**
     * beta.45: worktree paths belonging to loops that are CURRENTLY running in
     * this process (from `runningSessionIds()` -> their sessions.worktree_path).
     * The heal MUST NOT touch these. A concurrent bootstrap (e.g. triggered by
     * the gateway's plugin-registry re-registration when an unrelated plugin
     * reloads) would otherwise reap a live run's worktree out from under it.
     * Matched by exact path AND basename (a just-allocated `pending-<ts>` dir
     * may not have its `worktree_path` column persisted yet, so the caller
     * should pass whatever it can resolve).
     */
    protectedWorktreePaths?: string[];
    /**
     * beta.45: return the last-modified time (ms) of a worktree dir, or null if
     * it can't be stat'd. Used to protect just-allocated `pending-<ts>` dirs
     * whose owning session row hasn't written `worktree_path` yet (the loop
     * writes it only AFTER lead-plan completes). If a dir was modified within
     * `graceMs`, it is treated as possibly-live and skipped.
     */
    dirMtimeMs?: (worktreePath: string) => number | null;
    /** beta.45: grace window (ms) for the mtime guard above. Default 120000 (2 min). */
    graceMs?: number;
}
export interface WorktreeHealResult {
    scanned: number;
    matched_terminal: number;
    matched_active: number;
    orphaned: number;
    removed: number;
    /** beta.45: dirs skipped because they belong to a currently-running loop. */
    protected_running: number;
    /** beta.45: dirs skipped because they were modified within the grace window. */
    protected_recent: number;
    errors: Array<{
        path: string;
        error: string;
    }>;
}
export declare function healOrphanedWorktrees(state: StateStore, deps: WorktreeHealDeps): Promise<WorktreeHealResult>;
/**
 * Match paths the allocator produces: `pending-<digits>` (pre-beta.57),
 * `pending-<digits>-<hex8>` (beta.57 collision-safe ids), `revert-<digits>`
 * (deploy-repair revert scratch worktrees, previously never reaped), and
 * UUIDs (planned future migration). Deliberately conservative so a
 * mis-configured `worktrees_root` cannot cascade into removing arbitrary
 * user dirs.
 */
export declare function looksLikeAllocatorWorktree(name: string): boolean;
//# sourceMappingURL=worktree-heal.d.ts.map