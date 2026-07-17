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
}
export interface WorktreeHealResult {
    scanned: number;
    matched_terminal: number;
    matched_active: number;
    orphaned: number;
    removed: number;
    errors: Array<{
        path: string;
        error: string;
    }>;
}
export declare function healOrphanedWorktrees(state: StateStore, deps: WorktreeHealDeps): Promise<WorktreeHealResult>;
/**
 * Match paths the allocator produces: `pending-<digits>` (current allocator,
 * beta-era) and UUIDs (planned future migration). Deliberately conservative
 * so a mis-configured `worktrees_root` cannot cascade into removing arbitrary
 * user dirs.
 */
export declare function looksLikeAllocatorWorktree(name: string): boolean;
//# sourceMappingURL=worktree-heal.d.ts.map