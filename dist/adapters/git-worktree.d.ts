/**
 * Git worktree adapter.
 *
 * The harness runs each session inside a per-session `git worktree` rooted
 * at `<worktrees_root>/<sessionId>`. That gives us:
 *   - complete isolation between concurrent sessions,
 *   - cheap allocation (no full clone per session),
 *   - a fixed cleanup path (worktree remove).
 *
 * The base clone (bare) lives at `<worktrees_root>/.repos/<owner>/<repo>.git`.
 * We fetch it once per session start, then create a worktree pointing at
 * the desired base branch.
 *
 * PAT handling (beta.24):
 *   - For the INITIAL bare clone, we embed the PAT in the URL passed to git.
 *     This is required for private repos because GitHub returns 404 (not
 *     401) on unauthenticated requests, so `GIT_ASKPASS` alone never fires.
 *     After the clone succeeds we immediately `remote set-url` back to the
 *     plain URL so the token is NOT persisted in .git/config on disk.
 *   - For fetch, push, and all subsequent operations, the PAT is passed via
 *     `GIT_ASKPASS` pointing at a per-invocation shell helper. The URL on
 *     disk stays plain, and the token lives only in the child process env
 *     for the duration of the git call.
 *
 * The token is never written to any config file, .gitconfig, or URL that
 * survives past the initial clone command line. The clone command itself
 * does have the token in its argv for the duration of that one process,
 * which is unavoidable for the private-repo 404-vs-401 workaround.
 */
export interface GitAdapterOptions {
    worktreesRoot: string;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
}
/**
 * beta.24: build a token-embedded HTTPS URL for the initial private-repo
 * clone. Uses the `x-access-token` username convention that GitHub PATs
 * and GitHub App installation tokens both accept.
 *
 * The token is URL-encoded so a `%` / `@` / `:` in a token cannot mangle
 * the URL. Ghmaller PATs currently only use `[A-Za-z0-9_]`, but this is
 * defensive against a future token format change.
 */
export declare function buildAuthedCloneUrl(repoFullName: string, token: string): string;
export interface GitContext {
    repoFullName: string;
    baseBranch: string;
    sessionBranch: string;
    sessionId: string;
    ghToken: string;
    commitIdentity: {
        name: string;
        email: string;
    };
    /**
     * beta.44: revise flow. When true, check out the EXISTING sessionBranch at
     * its own tip (`worktree add <wt> <branch>`) instead of resetting it to
     * baseBranch (`worktree add -B <branch> <wt> <base>`). This preserves the
     * prior session's commits so a revise stacks new work on the existing PR
     * head. The `+refs/heads/*` fetch above makes the remote branch ref
     * available locally before the checkout.
     */
    reuseExistingBranch?: boolean;
}
export declare class GitAdapter {
    private readonly opts;
    constructor(opts: GitAdapterOptions);
    private expand;
    private repoBarePath;
    private sessionWorktreePath;
    /**
     * Writes a per-invocation askpass helper that prints the PAT on stdout.
     * The helper is chmod 0700 and lives in a fresh mkdtemp dir; caller
     * must clean it up.
     */
    private makeAskpass;
    allocate(ctx: GitContext): Promise<string>;
    /**
     * Release (remove) a session's worktree.
     *
     * beta.17 fix: previously reconstructed the worktree path from `sessionId`
     * via `sessionWorktreePath(sessionId)`. That's wrong: the allocator uses
     * `pending-<Date.now()>` as the on-disk id (see index.ts allocateWorktree),
     * NOT the DB session UUID. So the reconstructed path never existed and
     * `if (!existsSync(wt)) return;` silently no-op'd every release.
     *
     * The correct path is stored on `sessions.worktree_path` after allocation
     * and propagated on `plan.worktreePath`. Callers must pass it explicitly.
     *
     * Returns `{ ok, path, error? }` so callers can surface failures in audit
     * payloads instead of relying on exceptions or fire-and-forget promises.
     */
    /**
     * beta.38: robust recursive directory removal.
     *
     * `fs.rm(recursive, force)` alone loses a race against still-open file
     * handles and against native-module symlink trees. Real-world failure
     * (Staging ProjectThanos smoke): a Next.js worktree's
     * `node_modules/@next/swc-linux-x64-musl` left the dir non-empty:
     *   ENOTEMPTY: directory not empty, rmdir '.../@next/swc-linux-x64-musl'
     * Node's own `rm` supports retry-on-EBUSY/ENOTEMPTY via `maxRetries` +
     * `retryDelay`; we opt in so transient filehandle races self-heal instead
     * of orphaning a directory that then collides with the next run.
     */
    private robustRemoveDir;
    /**
     * beta.38: before `git worktree add -B <branch>`, ensure no OTHER worktree
     * still holds <branch>. `git worktree add -B` refuses when the branch is
     * checked out elsewhere. We (1) prune dangling admin entries, then (2) parse
     * `git worktree list --porcelain`, and for any registered worktree that is
     * NOT the target path AND is on <branch>, force-remove it (git first, then a
     * robust rm fallback). Best-effort: failures are logged, not thrown -- the
     * subsequent `worktree add` will surface a clear error if reconciliation was
     * insufficient.
     */
    private reconcileBranchWorktrees;
    releaseByPath(worktreePath: string, repoFullName: string): Promise<{
        ok: boolean;
        path: string;
        error?: string;
    }>;
    /**
     * Legacy signature kept for back-compat with callers that still pass a
     * `sessionId` (github-watcher pre-beta.17). Prefer `releaseByPath` when
     * the actual worktree path is available (which is nearly always: it's
     * stored on `sessions.worktree_path`).
     *
     * IMPORTANT: this path RECONSTRUCTS the worktree path from `sessionId`
     * via `sessionWorktreePath` — which is wrong when the allocator used
     * `pending-<ts>` ids. The github-watcher will be migrated to
     * releaseByPath in a follow-up. For beta.17 we accept an optional
     * `worktreePath` override that, when provided, wins over reconstruction.
     */
    release(sessionId: string, repoFullName: string, worktreePath?: string): Promise<{
        ok: boolean;
        path: string;
        error?: string;
    }>;
    /**
     * beta.17: enumerate leftover worktrees under the root that look like
     * per-session allocations (`pending-<timestamp>` or DB-session UUIDs).
     * Used by the startup self-heal path.
     */
    listWorktreeDirs(): Promise<string[]>;
    baseSha(worktreePath: string): Promise<string>;
    listChangedFiles(worktreePath: string, base: string): Promise<string[]>;
    /**
     * beta.10: files touched by commits in `base..HEAD`.
     * Unlike `listChangedFiles` (`git diff`) this includes files reachable via
     * multi-commit history even if the net diff is empty; unlike `git diff` it
     * still ignores untracked files.
     * Used by the `file_committed` verify probe.
     */
    listCommittedFiles(worktreePath: string, base: string): Promise<string[]>;
    /**
     * beta.10: query the remote for a branch's tip SHA via `git ls-remote`.
     * Returns `undefined` when the branch does not exist on the remote (or the
     * lookup errors out; the caller treats those the same).
     * Used by the `remote_branch_exists` / `commit_sha_matches` verify probes.
     */
    remoteBranchSha(worktreePath: string, remote: string, branch: string, ghToken?: string): Promise<string | undefined>;
    commit(worktreePath: string, message: string, identity: {
        name: string;
        email: string;
    }): Promise<string | null>;
    pushBranch(worktreePath: string, remote: string, branch: string, ghToken: string): Promise<void>;
    /**
     * beta.36: revert a list of (squash-)merge commits on `main`, newest first.
     *
     * Used by the deploy-repair loop when a merged change plus up to N repair
     * PRs still can't produce a healthy Vercel deploy: we undo ALL of them to
     * put `main` back to a working state, then leave the last repair attempt as
     * an open PR for human review.
     *
     * Squash merges are single-parent commits, so a plain `git revert <sha>`
     * (no --mainline) is correct. We revert in the given order (caller passes
     * newest-first so the reverts apply cleanly in reverse-chronological order).
     *
     * Strategy: fetch latest `main` into the bare repo, create a scratch
     * worktree on it, apply the reverts, then TRY to push straight to `main`.
     * If that push is rejected (branch protection — the 95% case), we push the
     * reverts to a dedicated branch and return `{ pushedToMain: false, branch }`
     * so the caller opens + auto-merges a revert PR instead.
     *
     * Returns the scratch worktree path so the caller can release it.
     */
    revertCommits(repoFullName: string, shas: string[], ghToken: string, opts?: {
        baseBranch?: string;
        revertBranch?: string;
    }): Promise<{
        pushedToMain: boolean;
        branch: string;
        worktreePath: string;
        revertedShas: string[];
    }>;
    formatPatch(worktreePath: string, base: string, outFile: string): Promise<void>;
    diff(worktreePath: string, base: string): Promise<string>;
    /**
     * beta.34: install a persistent credential helper into the bare repo
     * config (Staging's recommended hardening, option 1). The helper script
     * contains NO token — it reads `$OAH_GH_TOKEN` from the process env at
     * invocation time and prints `username=x-access-token` / `password=$token`.
     * This makes EVERY git op against origin auth automatically (including
     * sub-processes git spawns internally, e.g. promisor blob fetches during
     * push, which do NOT inherit GIT_ASKPASS reliably), without persisting the
     * token on disk. Consistent with the "never persist the token" invariant:
     * only a reference to an env var is written to config.
     *
     * Callers must set `OAH_GH_TOKEN` in the git child env for ops that need
     * auth (see `run(..., token)`). askpass stays wired as a second channel.
     */
    private installCredHelper;
    private run;
}
//# sourceMappingURL=git-worktree.d.ts.map