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
/**
 * beta.76 (Defect B): does a string look like a disk-exhaustion / corrupted-
 * install failure? The Opus-5/Sonnet-5 smoke (session 73e7451f seq-3) had the
 * worktree's `npm ci` half-run under a full sandbox disk (`ENOSPC`), which
 * CORRUPTED node_modules -- so the worker could not RUN the test it wrote. A
 * silently-swallowed bootstrap install then let the run continue toward a
 * false-green (committed-but-unrun test). We classify these so the harness can
 * surface a BLOCKING env diagnostic instead of pretending the worktree is
 * healthy.
 */
export declare const DISK_EXHAUSTION_RE: RegExp;
export declare function isCommitMsgNoise(path: string): boolean;
export declare function looksLikeDiskExhaustion(text: string): boolean;
/**
 * beta.110: package-manager and tooling caches that a `npm install` (or yarn,
 * or pnpm) can drop INSIDE the worktree when the sandbox has no writable HOME.
 *
 * ProjectThanos PR #932, session `9217236c`: sub-task 9 needed the prisma CLI,
 * ran an install, and npm wrote its content-addressed cache to
 * `.npm-cache-tmp/_cacache/` in the worktree because `$HOME/.npm` was not
 * writable. The next `commit()` ran its unscoped `git add -A` and swept 12,292
 * cache blobs into the schema-format commit. The adversary was then handed a
 * 12,432-file diff, could not review it inside `adversary_timeout_seconds`,
 * and the whole run failed at 55.6 minutes having pushed nothing -- losing
 * eight good commits that were already sitting in the worktree.
 *
 * Written to `.git/info/exclude`, NOT to the repo's `.gitignore`: the target
 * repo is somebody else's, the exclusion is a property of how the harness runs
 * tools rather than of their project, and `info/exclude` is per-clone and
 * never appears in a diff. Patching the target repo's `.gitignore` (as the
 * b109 post-mortem proposed) would fix one repo and leave every other one
 * exposed to the same failure.
 */
export declare const HARNESS_EXCLUDE_PATTERNS: readonly string[];
export interface GitAdapterOptions {
    worktreesRoot: string;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    /**
     * beta.53 (P3/P4): install node deps (`npm ci`/`npm install`) once at
     * worktree allocation so workers never hit an un-installed tool mid-turn
     * (the env-wait "Monitor event" hallucination trigger). Default enabled;
     * set false to skip (e.g. non-node repos or tests).
     */
    /**
     * beta.110: untracked-file count at which a single top-level directory is
     * treated as a runaway (tool cache, build output) and excluded from the
     * commit. Default 500; 0 disables. See excludeRunawayUntracked.
     */
    runawayUntrackedThreshold?: number;
    bootstrapDeps?: boolean;
    /** beta.53: max ms for the bootstrap install before it is abandoned. Default 600000. */
    bootstrapTimeoutMs?: number;
    /**
     * beta.76 (Defect B): minimum free bytes on the worktrees filesystem BEFORE a
     * dep bootstrap install is attempted. If the free space is below this, we do
     * NOT run the install (a half-run install under a full disk corrupts
     * node_modules) and instead surface a blocking `harness.worktree_disk_low`
     * diagnostic. Default 1 GiB. Set 0 to disable the preflight.
     */
    minFreeDiskBytes?: number;
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
/**
 * beta.57 (P2): scrub secrets out of strings that end up in error messages /
 * logs. The initial private-repo clone embeds the PAT in the URL argv (the
 * beta.24 404-vs-401 workaround), so a failing clone used to throw
 * `git clone ... https://x-access-token:<PAT>@github.com/...` -- putting the
 * token into logs, audit payloads, and Slack error posts. Redacts:
 *   - userinfo in any URL (`scheme://user:secret@host` -> `scheme://***@host`)
 *   - the exact token value when known.
 */
export declare function redactSecrets(text: string, token?: string): string;
/** Test/diagnostic helper: which branches are mid-allocation right now. */
export declare function inFlightBranchHolders(): Array<{
    key: string;
    sessionId: string;
}>;
export declare function inFlightWorktreePaths(): string[];
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
    /**
     * beta.101: check out the LOCAL sessionBranch at its own tip, never resetting
     * it. Distinct from {@link reuseExistingBranch}, which resolves the tip from
     * `origin/<branch>` and therefore only works for a branch that has already
     * been PUSHED (the revise-of-a-shipped-PR flow).
     *
     * ROOT CAUSE (b100 smoke, session 3c6c1608). Resuming from
     * `awaiting_clarification` runs a full re-plan, which allocates a NEW
     * worktree. Allocation force-removed the paused worktree and then ran
     * `worktree add -B <branch> <wt> origin/<base>`, and `-B` RESETS the branch.
     * The branch had six worker commits (`ce05f55f..88ce5f44`) and had never been
     * pushed, so `reuseExistingBranch` could not have saved it either. The ref
     * jumped to `origin/main` (which had moved on to an unrelated docs commit)
     * and all six commits became unreachable. The adversary then reviewed a diff
     * containing none of the run's work and blocked.
     *
     * With this flag, allocation checks out the existing local branch as-is, so
     * local commits survive a re-plan. Falls back to the base checkout when the
     * branch does not exist locally (a first run), so it is safe to set
     * unconditionally on any resume.
     */
    preserveLocalBranch?: boolean;
    /**
     * beta.104: per-allocation override of the adapter-wide {@link
     * GitAdapterOptions.bootstrapDeps}.
     *
     * Exists for the lead scout, which allocates a throwaway worktree purely to
     * READ the repo before planning and then releases it. Running `npm ci` for a
     * read-only look would add minutes to every run to install dependencies
     * nothing in that worktree will ever execute. Undefined keeps the
     * adapter-wide default, so the real run worktree still bootstraps.
     */
    bootstrapDeps?: boolean;
    /**
     * beta.105: report which checkout path allocation actually took.
     *
     * The b103 smoke (session b8ece861) lost eight commits on a clarification
     * resume, and nothing in the durable trail could say whether allocation
     * preserved the branch or reset it -- the answer had to be reconstructed from
     * the commit graph hours later. `preserveLocalBranch` is a REQUEST that
     * silently falls through when no local branch of that name exists, so the
     * request being set proves nothing about what happened.
     *
     * Optional; the adapter always logs the same information regardless.
     */
    onBranchDecision?: (d: BranchAllocationDecision) => void;
}
/** beta.105: the checkout path allocation took, and the inputs that chose it. */
export interface BranchAllocationDecision {
    /** `preserve_local` never moves the ref; the other two reset it. */
    path: "preserve_local" | "reuse_remote" | "reset_to_base";
    branch: string;
    /** The ref the branch was pointed at (empty for `preserve_local`). */
    startPoint: string;
    preserveRequested: boolean;
    localBranchExists: boolean;
    /** The local branch's tip BEFORE allocation, when it had one. */
    tipBefore: string;
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
     *
     * beta.57 (P2): the token is NO LONGER written into the script body. The
     * script reads `$OAH_GH_TOKEN` from the child-process env at invocation
     * (same channel the beta.34 cred helper uses), so the secret never touches
     * disk and no shell-escaping of the token is needed. Callers that pass
     * `askpassPath` to run() must also pass the token so the env var is set.
     */
    private makeAskpass;
    allocate(ctx: GitContext): Promise<string>;
    private allocateInner;
    /**
     * beta.53: install node deps in a freshly-allocated worktree when a
     * package.json is present and node_modules is missing/empty. Prefers a
     * clean `npm ci` (respects the lockfile) and falls back to `npm install`
     * when there is no lockfile. Bounded + best-effort: never throws.
     */
    /**
     * beta.76 (Defect B): free bytes on the filesystem backing `p`, or null when
     * unknowable. Best-effort (`statfsSync`); never throws.
     */
    private freeDiskBytes;
    private bootstrapWorktreeDeps;
    /** beta.76: redact a token from a bootstrap error string before logging. */
    private redactSafe;
    /**
     * beta.69 (F4): do the declared check-script binaries (eslint / tsx / tsc /
     * the tools behind lint|typecheck|okf:check|test scripts) resolve in
     * node_modules/.bin? A partial node_modules (deps present, dev tools absent)
     * otherwise slips past the "non-empty" skip and makes the check scripts exit
     * 127. Best-effort + conservative: unknown/unreadable => treat as present so
     * we never loop-install. Only the common dev-tool bins are probed.
     */
    private declaredCheckBinsPresent;
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
    /** beta.101: does `refs/heads/<branch>` exist in the bare repo? Never throws. */
    private localBranchExists;
    /** beta.105: a local branch's tip, or "" when it has none. Diagnostics only. */
    private branchTipSha;
    /**
     * beta.101: NEVER SILENTLY DISCARD COMMITS.
     *
     * `git worktree add -B <branch> <wt> <startPoint>` RESETS <branch> to
     * <startPoint>. When the branch already carries commits that <startPoint>
     * cannot reach, those commits become unreachable from any ref and are lost to
     * the next `git gc` -- which is exactly how the b100 smoke (session 3c6c1608)
     * destroyed six worker commits on a clarification resume.
     *
     * The preserve-local-branch path above is the CURE for the known trigger.
     * This is the NET for every other path to a destructive reset, including ones
     * that do not exist yet: before the reset, park the doomed tip under
     * `refs/harness-rescue/<branch>/<timestamp>` so the work stays reachable and
     * recoverable. Deliberately non-blocking -- we do not refuse the reset, we
     * just make it non-destructive, so no legitimate fresh-start allocation is
     * broken by this guard.
     *
     * Best-effort by construction: any git failure here must not fail allocation,
     * because a rescue ref is a safety bonus and never a precondition.
     */
    private rescueBranchIfAhead;
    /**
     * beta.101: are ALL of `shas` reachable from `from` in this worktree? Returns
     * the subset that is NOT reachable. Powers the ledger-reachability guard: a
     * sub-task that recorded a commit_sha which HEAD cannot reach means the work
     * is no longer on the branch, and anything downstream (review, PR) would be
     * operating on a diff that does not contain it. Never throws; an
     * indeterminate check returns [] so the guard fails OPEN (a git failure must
     * not block a healthy run).
     */
    unreachableCommits(worktreePath: string, from: string, shas: string[]): Promise<string[]>;
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
     * beta.53 (P2): the working-tree files a worker actually touched, INCLUDING
     * uncommitted + untracked changes. `listChangedFiles`/`listCommittedFiles`
     * only see committed work (`git diff`/`git log base..HEAD`), so a worker that
     * WROTE a file but never ran `git commit` shows up as "no side-effects"
     * (Staging beta.52 #858 seq-5: the aria-label edit was on disk, 1145 bytes,
     * but filesTouched was []). `git status --porcelain` surfaces the uncommitted
     * work so the audit + the retry logic can distinguish a partial-work turn
     * ("wrote X, didn't commit") from a genuine zero-work turn. Best-effort:
     * returns [] on any error.
     */
    statusPorcelain(worktreePath: string): Promise<string[]>;
    /**
     * beta.10: files touched by commits in `base..HEAD`.
     * Unlike `listChangedFiles` (`git diff`) this includes files reachable via
     * multi-commit history even if the net diff is empty; unlike `git diff` it
     * still ignores untracked files.
     * Used by the `file_committed` verify probe.
     */
    listCommittedFiles(worktreePath: string, base: string): Promise<string[]>;
    /**
     * beta.105: was `path` ADDED (A) or RENAMED-TO (R) by a commit in
     * `base..HEAD`?
     *
     * `file_written` uses mtime as its proxy for "this sub-task authored this
     * path", and `git mv` preserves mtime. So a worker that correctly moves a
     * file onto the contract's path fails `file_written` while `file_committed`
     * passes on the same file in the same commit -- the split verdict that killed
     * b103 smoke seq 3. This asks git the question mtime was standing in for.
     *
     * `--diff-filter=AR` with `--name-status` reports `A<TAB>path` for a fresh
     * file and `R<score><TAB>old<TAB>new` for a rename, so the path is matched
     * structurally against the LAST field of each record (the destination).
     * Modifications (M) are deliberately excluded: touching a file that already
     * existed at this path is not authoring it here.
     */
    pathIntroducedSince(worktreePath: string, base: string, path: string): Promise<{
        introduced: boolean;
        changeType: string;
        detail: string;
    }>;
    /**
     * beta.10: query the remote for a branch's tip SHA via `git ls-remote`.
     * Returns `undefined` when the branch does not exist on the remote (or the
     * lookup errors out; the caller treats those the same).
     * Used by the `remote_branch_exists` / `commit_sha_matches` verify probes.
     */
    remoteBranchSha(worktreePath: string, remote: string, branch: string, ghToken?: string): Promise<string | undefined>;
    /**
     * beta.73 (D2): does `branch` exist on origin for `repoFullName`? Unlike
     * {@link remoteBranchSha} this does NOT need a local worktree -- it runs
     * `git ls-remote <authed-url> refs/heads/<branch>` directly, so it can be
     * called at LEAD-PLAN time (before any worktree is allocated) to decide
     * whether a `branchHint` names an existing open-PR branch (-> pinned/reuse)
     * or a new one (-> create fresh). Best-effort: returns false on any error.
     */
    remoteBranchExistsByUrl(repoFullName: string, branch: string, ghToken: string): Promise<boolean>;
    /**
     * beta.107: DELETE commit-message scratch files before they can be staged.
     *
     * Workers write `.git-commit-msg.txt` into the worktree to pass a multi-line
     * message to `git commit -F` when the sandbox blocks heredocs and command
     * substitution -- and then cannot delete it, because the sandbox blocks `rm`
     * on it too. b95 taught the VERIFIER to ignore these files, which stopped them
     * spoofing a contract match, but they still get committed and still show up in
     * the PR diff, where the adversary reads them as what they are: a stray
     * scratch file at the repo root.
     *
     * On b106 that became finding #1, raised in the final review of a run that had
     * otherwise converged, and unclosable: every revise cycle that tried to remove
     * it hit the same sandbox denial. The harness has no such restriction, so it
     * sweeps them here, at the one point every worker's work passes through.
     *
     * Only ever removes paths `isCommitMsgNoise` already classifies as scratch --
     * the same predicate b95 uses to keep them out of the verifier -- so a repo
     * that legitimately tracks such a file could only be affected if it also
     * matches that pattern, and b95 would already be hiding it from verification.
     */
    private sweepCommitMsgScratch;
    /**
     * beta.110: append the harness's own exclusions to `.git/info/exclude`.
     *
     * Idempotent, best-effort, and additive -- an existing exclude file is read
     * and only missing patterns are appended, so a repo that already excludes
     * something keeps it. Resolves the real git dir via `rev-parse --git-path`
     * so this works in a linked worktree, where `.git` is a FILE pointing at
     * `…/.git/worktrees/<name>` and writing `<worktree>/.git/info/exclude`
     * directly would silently do nothing.
     */
    private appendExcludes;
    applyHarnessExcludes(worktreePath: string): Promise<string[]>;
    /**
     * beta.110: exclude any untracked directory that is pouring thousands of new
     * files into the worktree, whatever it happens to be called.
     *
     * The named list above only helps for names we predicted. On PR #932 the
     * directory was `.npm-cache-tmp`, but the container's npm cache was already
     * at `/home/node/.npm-cache` with a writable HOME -- so nothing forced that
     * path. A worker chose the name itself, presumably passing `--cache
     * .npm-cache-tmp` to avoid touching the shared cache. The next worker is free
     * to choose `.tmp-npm`, `build-cache`, or anything else, and a static list
     * will not save us.
     *
     * So: count untracked files per top-level directory and exclude any that
     * exceeds `runawayUntrackedThreshold`. No single sub-task legitimately
     * introduces hundreds of NEW files under one root -- regenerating a bundle
     * modifies files that are already tracked, which this does not count.
     *
     * Excluding rather than refusing is deliberate. The worker's real work is
     * sitting in the same worktree, and on #932 eight good commits were lost
     * because the run died. Drop the cache, keep the work, say so loudly.
     */
    excludeRunawayUntracked(worktreePath: string): Promise<Array<{
        dir: string;
        count: number;
    }>>;
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
    /**
     * beta.74: thread an optional GitHub token so a `git diff <base> HEAD` that
     * must fetch a PROMISOR object (the base-sha) from origin can authenticate.
     *
     * The worktree is a `--filter=blob:none` partial clone (git-worktree
     * allocate). When the adversary review diffs `<baseSha> HEAD` and the
     * base-sha's tree/blobs are not local, git lazily fetches them from origin
     * over HTTPS. Pre-beta.74 `diff()` passed NO token, so on a private repo the
     * fetch hit `Authentication failed ... (128)` and the adversary review
     * crashed BEFORE it could open the PR (session 666fc103: the commit + tests
     * were fine, but review died on the promisor fetch). This was masked until
     * beta.73's D2 fix put the worker on the real branch HEAD -- before that the
     * worker sat on main, whose base needed no promisor fetch.
     *
     * Passing the token routes through `run()`, which sets `OAH_GH_TOKEN` in the
     * child env + wires GIT_ASKPASS -- the beta.34 persistent cred-helper on the
     * bare repo then authenticates the promisor fetch automatically. Omitting the
     * token preserves prior behaviour (public repos / already-local base).
     */
    diff(worktreePath: string, base: string, ghToken?: string): Promise<string>;
    /**
     * beta.67 (Bug B): the fork-point sha -- the merge-base of `ref` (the default
     * base branch, resolved to its remote-tracking ref) and HEAD in the
     * worktree. This is the stable base the branch was created from. Diffing the
     * adversary review against THIS (`git diff <fork-point>..HEAD`) shows ONLY
     * the branch's own commits, not accumulated main history (which caused
     * beta.66 smoke #4's false-positive revise). Returns "" if the merge-base
     * cannot be resolved (caller falls back to the base-branch name).
     */
    mergeBase(worktreePath: string, ref: string): Promise<string>;
    /** beta.67 (Bug B): count commits in `<base>..HEAD` (the branch's own commits). */
    commitCount(worktreePath: string, base: string): Promise<number>;
    /**
     * beta.101: the repo's tracked files at HEAD, for plan-time detection of
     * paths the lead invented (see orchestrator/plan-path-validate.ts). Returns
     * [] on failure, which makes the check express no opinion.
     */
    listTrackedFiles(worktreePath: string): Promise<string[]>;
    /** beta.64 (P0-3/P0-4): `git diff --stat <base>..HEAD` in the worktree. */
    diffStat(worktreePath: string, base: string): Promise<string>;
    /**
     * beta.84 (#1): GROUND-TRUTH per-file change count for an EXACT path in
     * `<base>..HEAD`. Runs `git diff --numstat <base> HEAD -- <path>` and sums
     * additions + deletions. Returns 0 when the exact path was not modified in
     * the range (or the range is empty / the command errors).
     *
     * WHY THIS EXISTS (session 1c744d70, cyc2 seq7): the `file_committed` check
     * resolved its contract path (`.../files/[fileId]/route.ts`) via the
     * basename-unique fallback to a SIBLING file (`.../download/route.ts`) that
     * another contract entry already legitimately claimed, and reported PASS --
     * a false-positive. The worker never touched `route.ts`; only the `file_
     * written` mtime probe caught it. numstat on the EXACT contract path is the
     * un-fuzzable predicate: it is non-zero iff the commit range actually
     * modified THAT path. No basename fuzzing, no mtime shenanigans.
     *
     * `--numstat` prints `<added>\t<deleted>\t<path>` per changed file (binary
     * files print `-\t-\t<path>`, which we treat as a real change -> 1).
     */
    fileDiffLineCount(worktreePath: string, base: string, exactPath: string): Promise<number>;
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
    /**
     * beta.53: run an arbitrary command (e.g. `npm ci`) in `cwd` with a hard
     * timeout. Used by worktree dep bootstrap. Rejects on non-zero exit, spawn
     * error, or timeout (the caller treats all as non-fatal best-effort).
     */
    private runCmd;
}
//# sourceMappingURL=git-worktree.d.ts.map