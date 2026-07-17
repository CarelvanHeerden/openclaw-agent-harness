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
    formatPatch(worktreePath: string, base: string, outFile: string): Promise<void>;
    diff(worktreePath: string, base: string): Promise<string>;
    private run;
}
//# sourceMappingURL=git-worktree.d.ts.map