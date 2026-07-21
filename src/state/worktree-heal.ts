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
import type { StateStore } from "./store.js";

export interface WorktreeHealDeps {
  /** List directories directly under the worktrees root (excluding .repos). */
  listWorktreeDirs: () => Promise<string[]>;
  /** Force-remove a specific worktree path. */
  releaseByPath: (worktreePath: string, repoFullName: string) => Promise<{ ok: boolean; path: string; error?: string }>;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
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
  errors: Array<{ path: string; error: string }>;
}

export async function healOrphanedWorktrees(state: StateStore, deps: WorktreeHealDeps): Promise<WorktreeHealResult> {
  const result: WorktreeHealResult = {
    scanned: 0,
    matched_terminal: 0,
    matched_active: 0,
    orphaned: 0,
    removed: 0,
    protected_running: 0,
    protected_recent: 0,
    errors: [],
  };

  // beta.45: build the protected set (exact paths + basenames) from live loops.
  const protectedPaths = new Set<string>(deps.protectedWorktreePaths ?? []);
  const protectedBasenames = new Set<string>((deps.protectedWorktreePaths ?? []).map((p) => basename(p)));
  const graceMs = typeof deps.graceMs === "number" ? deps.graceMs : 120_000;

  let dirs: string[];
  try {
    dirs = await deps.listWorktreeDirs();
  } catch (err) {
    deps.logger.warn("[worktree-heal] failed to list worktree dirs", { err: String(err) });
    return result;
  }
  result.scanned = dirs.length;

  // Bulk-load session rows keyed by worktree_path so we can O(1) match each dir.
  // Also load by basename for pre-beta.17 rows where `worktree_path` might be missing.
  const rowsByPath = new Map<string, { id: string; status: string; repo: string; worktree_path: string | null }>();
  const rowsByBasename = new Map<string, { id: string; status: string; repo: string; worktree_path: string | null }>();
  try {
    const rows = state.db
      .prepare(`SELECT id, status, repo, worktree_path FROM sessions`)
      .all() as Array<{ id: string; status: string; repo: string; worktree_path: string | null }>;
    for (const r of rows) {
      if (r.worktree_path) rowsByPath.set(r.worktree_path, r);
      if (r.worktree_path) rowsByBasename.set(basename(r.worktree_path), r);
    }
  } catch (err) {
    deps.logger.warn("[worktree-heal] failed to load sessions", { err: String(err) });
    return result;
  }

  for (const dir of dirs) {
    const bn = basename(dir);

    // beta.45 GUARD 1: never touch a worktree belonging to a live loop.
    // Checked BEFORE session-row classification because the row's
    // `worktree_path` may not be written yet for a just-allocated dir.
    if (protectedPaths.has(dir) || protectedBasenames.has(bn)) {
      result.protected_running += 1;
      deps.logger.info("[worktree-heal] skipping live-loop worktree", { dir });
      continue;
    }

    // beta.45 GUARD 2: never touch an allocator dir modified within the grace
    // window. A `pending-<ts>` dir freshly created by an in-flight allocation
    // may not yet have its session row / worktree_path persisted, so it would
    // otherwise be misclassified as an `orphan` and reaped mid-run. A
    // genuinely-orphaned dir simply gets reaped on a later bootstrap once it
    // ages past the window. False-skip is safe; false-reap is fatal.
    if (looksLikeAllocatorWorktree(bn) && typeof deps.dirMtimeMs === "function") {
      const mtime = deps.dirMtimeMs(dir);
      if (mtime != null && Date.now() - mtime < graceMs) {
        result.protected_recent += 1;
        deps.logger.info("[worktree-heal] skipping recently-modified allocator dir", {
          dir,
          ageMs: Date.now() - mtime,
          graceMs,
        });
        continue;
      }
    }

    const row = rowsByPath.get(dir) ?? rowsByBasename.get(bn);
    const isTerminal = row && ["done", "failed", "aborted"].includes(row.status);
    const isActive = row && !isTerminal;

    if (isActive) {
      result.matched_active += 1;
      continue;
    }

    if (isTerminal) {
      result.matched_terminal += 1;
    } else {
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
      } else {
        result.errors.push({ path: dir, error: outcome.error ?? "unknown" });
        deps.logger.warn("[worktree-heal] release reported not-ok", { path: dir, error: outcome.error });
      }
    } catch (err) {
      result.errors.push({ path: dir, error: String(err) });
      deps.logger.warn("[worktree-heal] release threw", { path: dir, err: String(err) });
    }
  }

  return result;
}

/**
 * Match paths the allocator produces: `pending-<digits>` (pre-beta.57),
 * `pending-<digits>-<hex8>` (beta.57 collision-safe ids), `revert-<digits>`
 * (deploy-repair revert scratch worktrees, previously never reaped), and
 * UUIDs (planned future migration). Deliberately conservative so a
 * mis-configured `worktrees_root` cannot cascade into removing arbitrary
 * user dirs.
 */
export function looksLikeAllocatorWorktree(name: string): boolean {
  if (/^pending-\d+(-[0-9a-f]{1,8})?$/i.test(name)) return true;
  // beta.57 (P3): deploy-repair revert scratch dirs leaked forever before.
  if (/^revert-\d+$/.test(name)) return true;
  // UUIDv4-ish
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return true;
  return false;
}
