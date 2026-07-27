/**
 * beta.72 (D-A): worktrees-root ownership/writability preflight.
 *
 * THE BUG: the harness process runs as uid `node` inside the container, but
 * `worktrees/` (and its `.repos/` child) kept coming back `root:root` after a
 * beta.70 install/restart. When the root is root-owned, the harness's first
 * `mkdir(dirname(bare), {recursive:true})` in git-worktree.ts throws
 *   `EACCES: permission denied, mkdir '.../worktrees/.repos'`
 * DURING PLANNING -- so a run dies at $0.00 before any harness logic executes,
 * with a raw, un-actionable stack. Staging hit this three times on 2026-07-27;
 * each needed a manual host `chown -R node:node .../worktrees`.
 *
 * ROOT CAUSE is an install/host action creating the dir as root (the `cp -a` /
 * `mkdir` steps run as root), NOT the harness runtime (which is `node`). The
 * harness cannot `chown` a root-owned dir (that needs root). What it CAN do:
 *   1. If the root is MISSING, create it as the current (node) uid so a fresh
 *      install is correct from byte one -- no manual chown needed.
 *   2. If the root EXISTS but is NOT WRITABLE by the current process, detect it
 *      at bootstrap and emit a precise, actionable diagnostic (the exact chown
 *      command) instead of letting it explode as a raw EACCES mid-planning.
 *
 * This is a pure, side-effect-injected function so it is unit-testable without
 * touching the real filesystem.
 */
export interface WorktreesPreflightDeps {
    /** Absolute, ~-expanded worktrees root path. */
    worktreesRoot: string;
    /** True if the path exists (dir or otherwise). */
    exists: (p: string) => boolean;
    /** Create the directory (recursive). Throws on failure. */
    mkdirp: (p: string) => void;
    /**
     * Probe write access for the CURRENT process: create+remove a throwaway
     * entry under `p`. Returns true if writable, false on EACCES/EPERM. Should
     * NOT throw for the permission case (only for genuinely unexpected errors,
     * which the caller treats as non-writable to fail safe).
     */
    probeWritable: (p: string) => boolean;
    /** Current process uid, or null if unavailable (e.g. Windows). */
    getuid: () => number | null;
}
export type WorktreesPreflightResult = {
    ok: true;
    created: boolean;
    worktreesRoot: string;
} | {
    ok: false;
    created: false;
    worktreesRoot: string;
    reason: "not_writable";
    uid: number | null;
    /** Ready-to-paste remediation for an operator. */
    chownCommand: string;
    message: string;
};
/**
 * Ensure the worktrees root is present and writable by this process.
 *
 * - Missing  -> create it (node-owned) and return {ok:true, created:true}.
 * - Present + writable -> {ok:true, created:false}.
 * - Present + NOT writable -> {ok:false, reason:"not_writable", chownCommand}.
 *   (We cannot chown from an unprivileged process; surface the fix instead.)
 */
export declare function ensureWorktreesRootWritable(deps: WorktreesPreflightDeps): WorktreesPreflightResult;
//# sourceMappingURL=worktrees-preflight.d.ts.map