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
 * The PAT is never written to any config file, .gitconfig, or URL. It is
 * passed only via GH_TOKEN + GIT_ASKPASS to a helper subprocess, which is
 * why we spawn git via a small askpass wrapper written at runtime.
 */
export interface GitAdapterOptions {
    worktreesRoot: string;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
}
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
    release(sessionId: string, repoFullName: string): Promise<void>;
    baseSha(worktreePath: string): Promise<string>;
    listChangedFiles(worktreePath: string, base: string): Promise<string[]>;
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