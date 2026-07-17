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
import { basename } from "node:path";
export async function healOrphanedWorktrees(state, deps) {
    const result = {
        scanned: 0,
        matched_terminal: 0,
        matched_active: 0,
        orphaned: 0,
        removed: 0,
        errors: [],
    };
    let dirs;
    try {
        dirs = await deps.listWorktreeDirs();
    }
    catch (err) {
        deps.logger.warn("[worktree-heal] failed to list worktree dirs", { err: String(err) });
        return result;
    }
    result.scanned = dirs.length;
    // Bulk-load session rows keyed by worktree_path so we can O(1) match each dir.
    // Also load by basename for pre-beta.17 rows where `worktree_path` might be missing.
    const rowsByPath = new Map();
    const rowsByBasename = new Map();
    try {
        const rows = state.db
            .prepare(`SELECT id, status, repo, worktree_path FROM sessions`)
            .all();
        for (const r of rows) {
            if (r.worktree_path)
                rowsByPath.set(r.worktree_path, r);
            if (r.worktree_path)
                rowsByBasename.set(basename(r.worktree_path), r);
        }
    }
    catch (err) {
        deps.logger.warn("[worktree-heal] failed to load sessions", { err: String(err) });
        return result;
    }
    for (const dir of dirs) {
        const bn = basename(dir);
        const row = rowsByPath.get(dir) ?? rowsByBasename.get(bn);
        const isTerminal = row && ["done", "failed", "aborted"].includes(row.status);
        const isActive = row && !isTerminal;
        if (isActive) {
            result.matched_active += 1;
            continue;
        }
        if (isTerminal) {
            result.matched_terminal += 1;
        }
        else {
            result.orphaned += 1;
        }
        // Only reap dirs that look like allocator output. Guard against
        // accidentally removing user-created scratch dirs under the same root.
        if (!looksLikeAllocatorWorktree(bn)) {
            deps.logger.info("[worktree-heal] skipping non-allocator dir", { dir });
            continue;
        }
        const repo = row?.repo ?? deps.fallbackRepoFullName ?? "unknown/unknown";
        try {
            const outcome = await deps.releaseByPath(dir, repo);
            if (outcome.ok) {
                result.removed += 1;
                deps.logger.info("[worktree-heal] removed leftover worktree", {
                    path: dir,
                    reason: isTerminal ? "session-terminal" : "orphan",
                    sessionId: row?.id ?? null,
                });
            }
            else {
                result.errors.push({ path: dir, error: outcome.error ?? "unknown" });
                deps.logger.warn("[worktree-heal] release reported not-ok", { path: dir, error: outcome.error });
            }
        }
        catch (err) {
            result.errors.push({ path: dir, error: String(err) });
            deps.logger.warn("[worktree-heal] release threw", { path: dir, err: String(err) });
        }
    }
    return result;
}
/**
 * Match paths the allocator produces: `pending-<digits>` (current allocator,
 * beta-era) and UUIDs (planned future migration). Deliberately conservative
 * so a mis-configured `worktrees_root` cannot cascade into removing arbitrary
 * user dirs.
 */
export function looksLikeAllocatorWorktree(name) {
    if (/^pending-\d+$/.test(name))
        return true;
    // UUIDv4-ish
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name))
        return true;
    return false;
}
//# sourceMappingURL=worktree-heal.js.map