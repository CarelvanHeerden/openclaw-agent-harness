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
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
/**
 * beta.24: build a token-embedded HTTPS URL for the initial private-repo
 * clone. Uses the `x-access-token` username convention that GitHub PATs
 * and GitHub App installation tokens both accept.
 *
 * The token is URL-encoded so a `%` / `@` / `:` in a token cannot mangle
 * the URL. Ghmaller PATs currently only use `[A-Za-z0-9_]`, but this is
 * defensive against a future token format change.
 */
export function buildAuthedCloneUrl(repoFullName, token) {
    const encoded = encodeURIComponent(token);
    return `https://x-access-token:${encoded}@github.com/${repoFullName}.git`;
}
export class GitAdapter {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    expand(p) {
        return p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "") : p;
    }
    repoBarePath(repoFullName) {
        const [owner, repo] = repoFullName.split("/");
        return resolve(this.expand(this.opts.worktreesRoot), ".repos", owner, `${repo}.git`);
    }
    sessionWorktreePath(sessionId) {
        return resolve(this.expand(this.opts.worktreesRoot), sessionId);
    }
    /**
     * Writes a per-invocation askpass helper that prints the PAT on stdout.
     * The helper is chmod 0700 and lives in a fresh mkdtemp dir; caller
     * must clean it up.
     */
    async makeAskpass(ghToken) {
        const { mkdtemp } = await import("node:fs/promises");
        const dir = await mkdtemp(join(tmpdir(), "oah-askpass-"));
        const p = join(dir, "askpass.sh");
        // GH will call this twice: once for username, once for password. We answer
        // username=`x-access-token`, password=<PAT>. Distinguish via $1.
        const script = `#!/bin/sh
case "$1" in
  Username*) printf 'x-access-token' ;;
  *) printf '%s' "${ghToken.replace(/'/g, "'\\''")}" ;;
esac
`;
        await writeFile(p, script, "utf8");
        await chmod(p, 0o700);
        return {
            path: p,
            cleanup: async () => {
                await rm(dir, { recursive: true, force: true });
            },
        };
    }
    async allocate(ctx) {
        const bare = this.repoBarePath(ctx.repoFullName);
        const wt = this.sessionWorktreePath(ctx.sessionId);
        if (existsSync(wt)) {
            throw new Error(`worktree already exists at ${wt}; refusing to reuse without explicit release`);
        }
        const ask = await this.makeAskpass(ctx.ghToken);
        try {
            // beta.24 fix: use a token-embedded URL for the INITIAL clone.
            //
            // Askpass alone is insufficient for private repos because GitHub
            // returns 404 (not 401) when an unauthenticated request hits a
            // private repo -- git never gets prompted for credentials because
            // it doesn't recognise 404 as an auth failure. Staging's beta.23
            // Thanos smoke session `b499a9cf` hit exactly this: 61s clone,
            // 'Repository not found', no auth prompt ever fired.
            //
            // Fix: embed the token in the URL for the clone/fetch operations
            // so the request is authenticated from byte one. GitHub then
            // returns real 200/401 responses. Public repos are unaffected (the
            // token is still valid; askpass helper also stays wired as a
            // second belt-and-suspenders channel if git ever prompts).
            //
            // AFTER clone succeeds, we `remote set-url` back to the plain URL
            // so the token is NOT persisted in .git/config on disk. Subsequent
            // fetch/push operations rely on GIT_ASKPASS to re-inject the token
            // per-invocation, which works because by then git already knows
            // the remote is authenticated.
            const plainUrl = `https://github.com/${ctx.repoFullName}.git`;
            const authedUrl = buildAuthedCloneUrl(ctx.repoFullName, ctx.ghToken);
            if (!existsSync(bare)) {
                await mkdir(dirname(bare), { recursive: true });
                await this.run(["clone", "--bare", "--filter=blob:none", authedUrl, bare], undefined, ask.path);
                // Scrub the token out of the on-disk config immediately after
                // clone succeeds. Belt-and-suspenders: the plain remote set-url
                // below covers the worktree config, but the BARE clone also has
                // its own remote config that gets the authed URL by default.
                await this.run(["-C", bare, "remote", "set-url", "origin", plainUrl]);
                // beta.34: install the persistent cred helper (token-less; reads
                // $OAH_GH_TOKEN at invocation). Makes every subsequent origin op
                // auth automatically, incl. git-spawned promisor fetches.
                await this.installCredHelper(bare);
            }
            else {
                // beta.34: ensure the helper exists on pre-beta.34 bare repos too.
                await this.installCredHelper(bare).catch(() => { });
            }
            // beta.46: ALWAYS refresh into REMOTE-TRACKING refs (refs/remotes/origin/*),
            // NOT local branch heads (refs/heads/*), on BOTH the fresh-clone and
            // existing-bare paths.
            //
            // The old existing-bare mirror refspec `+refs/heads/*:refs/heads/*`
            // force-updated every LOCAL branch head, and git REFUSES to update a head
            // currently checked out in a worktree:
            //   fatal: refusing to fetch into branch 'refs/heads/<b>'
            //          checked out at '<worktree>'
            // On a revise the pinned branch is (or, via a leftover pending-<ts>
            // worktree from a prior aborted run, was) checked out, so the mirror fetch
            // aborted the whole run during planning (Staging session dab303e8, PR #858,
            // worktree pending-1784500729321). Fetching into remote-tracking refs never
            // touches local heads, so it can never be refused on account of a checkout.
            //
            // A fresh `git clone --bare` mirrors into LOCAL refs/heads/* and configures
            // NO remote-tracking refspec, so `origin/<branch>` would not resolve. We
            // therefore run this fetch on the fresh path too so that `origin/<branch>`
            // exists uniformly and the reuse/base checkouts below can rely on it.
            // GIT_ASKPASS injects creds per-invocation (remote URL is the plain form).
            await this.run(["-C", bare, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], undefined, ask.path, ctx.ghToken);
            // beta.29 fix: `worktree add` must run WITH the askpass helper.
            //
            // The bare clone above uses `--filter=blob:none` (partial clone /
            // promisor remote), so blobs are fetched lazily. Checking out files
            // during `worktree add` triggers a promisor fetch back to origin. By
            // this point we've `remote set-url` to the plain (token-less) URL, and
            // the previous code ran `worktree add` with NO askpass -> git had no
            // credential source, tried to prompt, and failed with
            //   `fatal: could not read Username for 'https://github.com': No such device or address`
            //   `fatal: could not fetch <sha> from promisor remote`
            // (Staging ProjectThanos session 781a9532.) Initial clone worked only
            // because askpass WAS wired there. Thread the same helper through the
            // worktree-add blob fetch. GIT_TERMINAL_PROMPT=0 in the helper env also
            // turns a would-be hang into a fast, diagnosable failure.
            // beta.38: reconcile any pre-existing checkout of this branch BEFORE
            // adding. A `git worktree add -B <branch>` fails hard if <branch> is
            // already checked out in ANOTHER worktree:
            //   fatal: '<branch>' is already checked out at '<other-worktree>'
            // This happens when a prior worktree for the same branch was left on
            // disk (e.g. a crashed/interrupted run, or a re-driven session). Prune
            // dangling admin state, then locate and release any live worktree still
            // holding this branch so the add can proceed cleanly.
            await this.reconcileBranchWorktrees(bare, ctx.sessionBranch, wt);
            if (ctx.reuseExistingBranch) {
                // beta.44 revise: check out the EXISTING branch at the pushed PR head so
                // the prior session's commits are preserved (new work stacks on the PR
                // head).
                //
                // beta.46: with the remote-tracking fetch above, the PR head lives at
                // `origin/<branch>` (the prior run pushed it -- that is why the PR
                // exists). Create/reset the local branch to that ref with `-B ... <wt>
                // origin/<branch>`. `-B` is safe here because reconcileBranchWorktrees
                // already released any OTHER worktree holding the branch, and
                // origin/<branch> IS the authoritative PR head, so the reset preserves
                // (does not discard) the prior commits. If the remote branch is gone
                // (deleted between ship and revise), fall back to creating it from base
                // so revise still produces a usable worktree.
                const remoteRef = `origin/${ctx.sessionBranch}`;
                try {
                    await this.run(["-C", bare, "worktree", "add", "-B", ctx.sessionBranch, wt, remoteRef], undefined, ask.path, ctx.ghToken);
                }
                catch {
                    await this.run(["-C", bare, "worktree", "add", "-B", ctx.sessionBranch, wt, ctx.baseBranch], undefined, ask.path, ctx.ghToken);
                }
            }
            else {
                // beta.46: base checkout resolves from the remote-tracking ref too.
                await this.run(["-C", bare, "worktree", "add", "-B", ctx.sessionBranch, wt, `origin/${ctx.baseBranch}`], undefined, ask.path, ctx.ghToken);
            }
            await this.run(["-C", wt, "config", "user.name", ctx.commitIdentity.name]);
            await this.run(["-C", wt, "config", "user.email", ctx.commitIdentity.email]);
            // Ensure the worktree remote is the plain URL (no token on disk).
            await this.run(["-C", wt, "remote", "set-url", "origin", plainUrl]);
        }
        finally {
            await ask.cleanup();
        }
        // beta.53 (P3/P4): bootstrap node dependencies ONCE at worktree creation,
        // BEFORE any worker turn. This is the eradicator for the "Monitor event"
        // env-wait hallucination class: across beta.51 (seq-3, tsc) and beta.52
        // (seq-5, eslint) the trigger was ALWAYS the same -- a worker hit an
        // un-installed tool mid-turn, tried to install, then hallucinated waiting
        // for a nonexistent completion event. If node_modules is already complete
        // when the worker starts, it never needs to install and never reaches for
        // the wait crutch. Also cuts the typical run's cost (~$0.50 on the Staging
        // #858 smoke) since workers stop re-running npm ci mid-turn. Best-effort:
        // a failed install must NOT block allocation (the worker can still fall
        // back to its own inline `npm ci`); we log + continue.
        if (this.opts.bootstrapDeps !== false) {
            await this.bootstrapWorktreeDeps(wt);
        }
        return wt;
    }
    /**
     * beta.53: install node deps in a freshly-allocated worktree when a
     * package.json is present and node_modules is missing/empty. Prefers a
     * clean `npm ci` (respects the lockfile) and falls back to `npm install`
     * when there is no lockfile. Bounded + best-effort: never throws.
     */
    async bootstrapWorktreeDeps(worktreePath) {
        try {
            const hasPkg = existsSync(join(worktreePath, "package.json"));
            if (!hasPkg)
                return;
            const nm = join(worktreePath, "node_modules");
            // If node_modules already has content, assume it's usable (checked-in or
            // from a prior allocation) and skip -- avoids a slow redundant install.
            if (existsSync(nm)) {
                try {
                    if (readdirSync(nm).length > 0)
                        return;
                }
                catch { /* fall through to install */ }
            }
            const hasLock = existsSync(join(worktreePath, "package-lock.json")) || existsSync(join(worktreePath, "npm-shrinkwrap.json"));
            const args = hasLock ? ["ci"] : ["install"];
            this.opts.logger?.info?.(`[git-worktree] bootstrapping deps (npm ${args[0]}) in ${worktreePath}`);
            await this.runCmd("npm", args, worktreePath, this.opts.bootstrapTimeoutMs ?? 600_000);
            this.opts.logger?.info?.(`[git-worktree] deps bootstrap complete in ${worktreePath}`);
        }
        catch (err) {
            // Best-effort: log and continue. Worker can still self-install inline.
            this.opts.logger?.warn?.(`[git-worktree] deps bootstrap failed (non-fatal): ${String(err)}`);
        }
    }
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
    async robustRemoveDir(dir) {
        if (!existsSync(dir))
            return;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
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
    async reconcileBranchWorktrees(bare, branch, targetPath) {
        try {
            await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
            const listing = await this.run(["-C", bare, "worktree", "list", "--porcelain"]).catch(() => "");
            // Porcelain groups are separated by blank lines; each has a `worktree <path>`
            // and, when on a branch, a `branch refs/heads/<name>` line.
            const groups = listing.split(/\n\n+/);
            const ref = `refs/heads/${branch}`;
            for (const g of groups) {
                const pathMatch = g.match(/^worktree\s+(.+)$/m);
                const branchMatch = g.match(/^branch\s+(.+)$/m);
                if (!pathMatch || !branchMatch)
                    continue;
                const wtPath = pathMatch[1].trim();
                const wtRef = branchMatch[1].trim();
                if (wtRef !== ref)
                    continue;
                if (resolve(wtPath) === resolve(targetPath))
                    continue; // it's our target; leave it
                this.opts.logger.warn("[git] reconcile: branch already checked out in another worktree; releasing it", {
                    branch,
                    staleWorktree: wtPath,
                    targetPath,
                });
                await this.run(["-C", bare, "worktree", "remove", "--force", wtPath]).catch(async (err) => {
                    this.opts.logger.warn("[git] reconcile: git worktree remove failed; robust rm fallback", { wtPath, err: String(err) });
                    await this.robustRemoveDir(wtPath).catch(() => undefined);
                });
                if (existsSync(wtPath))
                    await this.robustRemoveDir(wtPath).catch(() => undefined);
            }
            await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
        }
        catch (err) {
            this.opts.logger.warn("[git] reconcileBranchWorktrees failed (non-fatal)", { branch, err: String(err) });
        }
    }
    async releaseByPath(worktreePath, repoFullName) {
        if (!worktreePath)
            return { ok: false, path: worktreePath, error: "worktreePath is empty" };
        if (!existsSync(worktreePath))
            return { ok: true, path: worktreePath, error: "worktree already gone" };
        const bare = this.repoBarePath(repoFullName);
        try {
            // Best-effort: git worktree remove. Uses --force so uncommitted state
            // doesn't block a terminal-session cleanup.
            await this.run(["-C", bare, "worktree", "remove", "--force", worktreePath]);
            // Confirm the physical path is actually gone. `git worktree remove`
            // sometimes only unregisters the worktree (e.g. if the gitdir link
            // is broken). Follow up with rm -rf when the dir survives.
            if (existsSync(worktreePath)) {
                await this.robustRemoveDir(worktreePath);
            }
            // Also prune any dangling worktree admin state in the bare repo.
            await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
            return { ok: true, path: worktreePath };
        }
        catch (err) {
            this.opts.logger.warn("[git] worktree remove failed; falling back to rm -rf", { err: String(err), worktreePath });
            try {
                await this.robustRemoveDir(worktreePath);
                // Prune the bare admin state so a subsequent `git fetch` doesn't
                // choke on "refusing to fetch into branch checked out at ...".
                await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
                return { ok: true, path: worktreePath, error: `git worktree remove failed, fallback rm -rf succeeded: ${String(err)}` };
            }
            catch (rmErr) {
                return { ok: false, path: worktreePath, error: `git worktree remove AND rm -rf failed: ${String(err)} | ${String(rmErr)}` };
            }
        }
    }
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
    async release(sessionId, repoFullName, worktreePath) {
        const wt = worktreePath && worktreePath.length > 0 ? worktreePath : this.sessionWorktreePath(sessionId);
        return this.releaseByPath(wt, repoFullName);
    }
    /**
     * beta.17: enumerate leftover worktrees under the root that look like
     * per-session allocations (`pending-<timestamp>` or DB-session UUIDs).
     * Used by the startup self-heal path.
     */
    async listWorktreeDirs() {
        const root = this.expand(this.opts.worktreesRoot);
        try {
            const { readdir } = await import("node:fs/promises");
            const entries = await readdir(root, { withFileTypes: true });
            return entries
                .filter((e) => e.isDirectory() && e.name !== ".repos")
                .map((e) => resolve(root, e.name));
        }
        catch {
            return [];
        }
    }
    async baseSha(worktreePath) {
        return (await this.run(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
    }
    async listChangedFiles(worktreePath, base) {
        const out = await this.run(["-C", worktreePath, "diff", "--name-only", base, "HEAD"]);
        return out.split("\n").map((l) => l.trim()).filter(Boolean);
    }
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
    async statusPorcelain(worktreePath) {
        const out = await this.run(["-C", worktreePath, "status", "--porcelain"]).catch(() => "");
        // porcelain v1: `XY <path>` (or `XY <old> -> <new>` for renames). Strip the
        // 2-char status + space and take the destination path for renames.
        return Array.from(new Set(out.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean).map((l) => {
            const rest = l.slice(3);
            const arrow = rest.indexOf(" -> ");
            return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
        }).filter(Boolean)));
    }
    /**
     * beta.10: files touched by commits in `base..HEAD`.
     * Unlike `listChangedFiles` (`git diff`) this includes files reachable via
     * multi-commit history even if the net diff is empty; unlike `git diff` it
     * still ignores untracked files.
     * Used by the `file_committed` verify probe.
     */
    async listCommittedFiles(worktreePath, base) {
        // If HEAD == base (no new commits) return empty; git log would return empty anyway.
        if (!base)
            return [];
        const out = await this.run([
            "-C", worktreePath, "log", `${base}..HEAD`, "--name-only", "--pretty=format:",
        ]).catch(() => "");
        return Array.from(new Set(out.split("\n").map((l) => l.trim()).filter(Boolean)));
    }
    /**
     * beta.10: query the remote for a branch's tip SHA via `git ls-remote`.
     * Returns `undefined` when the branch does not exist on the remote (or the
     * lookup errors out; the caller treats those the same).
     * Used by the `remote_branch_exists` / `commit_sha_matches` verify probes.
     */
    async remoteBranchSha(worktreePath, remote, branch, ghToken) {
        const ref = `refs/heads/${branch}`;
        const ask = ghToken ? await this.makeAskpass(ghToken) : undefined;
        try {
            const out = await this.run(["-C", worktreePath, "ls-remote", remote, ref], undefined, ask?.path).catch(() => "");
            // `<sha>\t<ref>` on match; empty on no such branch.
            const line = out.split("\n").map((l) => l.trim()).find(Boolean);
            if (!line)
                return undefined;
            const [sha] = line.split(/\s+/);
            return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
        }
        finally {
            await ask?.cleanup();
        }
    }
    async commit(worktreePath, message, identity) {
        await this.run(["-C", worktreePath, "add", "-A"]);
        const status = await this.run(["-C", worktreePath, "status", "--porcelain"]);
        if (!status.trim())
            return null;
        await this.run([
            "-C", worktreePath,
            "-c", `user.name=${identity.name}`,
            "-c", `user.email=${identity.email}`,
            "commit", "-m", message,
        ]);
        return (await this.run(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
    }
    async pushBranch(worktreePath, remote, branch, ghToken) {
        const ask = await this.makeAskpass(ghToken);
        try {
            await this.run(["-C", worktreePath, "push", remote, `${branch}:${branch}`], undefined, ask.path, ghToken);
        }
        catch (err) {
            // beta.34: push-exit-code assertion. Turn a generic non-zero-exit push
            // failure into a CLEAR auth error when the stderr shows the classic
            // credential-less symptoms. Before beta.33 a cred-less push failed
            // silently and only surfaced downstream as a remote-404 verify miss;
            // now the harness raises a precise, greppable error the loop can act
            // on (retry with fresh creds / abort with a real reason) instead of a
            // vague "verify failed".
            const msg = String(err);
            if (/could not read Username|Authentication failed|terminal prompts disabled|fatal: could not read|Invalid username or password|Permission to .* denied/i.test(msg)) {
                throw new Error(`git push authentication failed for ${remote}/${branch}: ${msg.slice(0, 300)}. ` +
                    `The push had no usable credentials (askpass/env/cred-helper all missing or the token is invalid/lacks 'contents:write').`);
            }
            throw err;
        }
        finally {
            await ask.cleanup();
        }
    }
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
    async revertCommits(repoFullName, shas, ghToken, opts) {
        const bare = this.repoBarePath(repoFullName);
        const baseBranch = opts?.baseBranch ?? "main";
        const revertBranch = opts?.revertBranch ?? `harness/deploy-repair-revert-${Date.now()}`;
        const ask = await this.makeAskpass(ghToken);
        const scratch = resolve(this.expand(this.opts.worktreesRoot), `revert-${Date.now()}`);
        try {
            // Make sure the bare repo has the freshest main (repair PRs merged since
            // allocation).
            // beta.46: fetch base into a remote-tracking ref (never refuses on a
            // checkout) and branch the scratch worktree off `origin/<base>`, matching
            // the allocate() refspec change. Guards against the same
            // "refusing to fetch into branch ... checked out" failure if base is ever
            // held by a worktree.
            await this.run(["-C", bare, "fetch", "--prune", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], undefined, ask.path, ghToken);
            // Scratch worktree on a fresh revert branch pointing at latest main.
            await this.run(["-C", bare, "worktree", "add", "-B", revertBranch, scratch, `origin/${baseBranch}`], undefined, ask.path, ghToken);
            // Set a commit identity for the revert commits (worktree-local).
            await this.run(["-C", scratch, "config", "user.name", "openclaw-agent-harness"]);
            await this.run(["-C", scratch, "config", "user.email", "harness@openclaw.local"]);
            const reverted = [];
            for (const sha of shas) {
                if (!sha)
                    continue;
                // --no-edit keeps the default "Revert ..." message; -m not needed for
                // single-parent squash commits. If a revert conflicts we abort and
                // surface a clear error — a conflicted auto-revert must not be pushed.
                try {
                    await this.run(["-C", scratch, "revert", "--no-edit", sha]);
                    reverted.push(sha);
                }
                catch (err) {
                    await this.run(["-C", scratch, "revert", "--abort"]).catch(() => { });
                    throw new Error(`revert of ${sha.slice(0, 12)} conflicted; aborting auto-revert (main left untouched by this method): ${String(err).slice(0, 200)}`);
                }
            }
            // Try direct push to main first.
            try {
                await this.run(["-C", scratch, "push", "origin", `HEAD:${baseBranch}`], undefined, ask.path, ghToken);
                return { pushedToMain: true, branch: revertBranch, worktreePath: scratch, revertedShas: reverted };
            }
            catch (pushErr) {
                // Branch protection (or non-fast-forward). Fall back to a revert branch
                // + PR. Push the branch so the caller can open the PR.
                await this.run(["-C", scratch, "push", "origin", `${revertBranch}:${revertBranch}`], undefined, ask.path, ghToken);
                void pushErr;
                return { pushedToMain: false, branch: revertBranch, worktreePath: scratch, revertedShas: reverted };
            }
        }
        finally {
            await ask.cleanup();
        }
    }
    async formatPatch(worktreePath, base, outFile) {
        const patch = await this.run(["-C", worktreePath, "format-patch", `${base}..HEAD`, "--stdout"]);
        await mkdir(dirname(outFile), { recursive: true });
        await writeFile(outFile, patch, "utf8");
    }
    async diff(worktreePath, base) {
        return this.run(["-C", worktreePath, "diff", base, "HEAD"]);
    }
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
    async installCredHelper(bareRepoPath) {
        const dir = join(bareRepoPath, "oah-cred");
        await mkdir(dir, { recursive: true });
        const helper = join(dir, "credential-helper.sh");
        // Only `get` needs to answer; store/erase are no-ops. No token in here.
        const script = `#!/bin/sh
case "$1" in
  get)
    printf 'username=x-access-token\\n'
    printf 'password=%s\\n' "$OAH_GH_TOKEN"
    ;;
esac
`;
        await writeFile(helper, script, "utf8");
        await chmod(helper, 0o700);
        // Point github.com credential lookups at the helper. Absolute path so it
        // works regardless of git's cwd. Overwrite (--replace-all) to stay idempotent.
        await this.run(["-C", bareRepoPath, "config", "--replace-all", "credential.https://github.com.helper", helper]);
        await this.run(["-C", bareRepoPath, "config", "credential.https://github.com.useHttpPath", "false"]);
    }
    run(args, _cwd, askpassPath, token) {
        return new Promise((resolveP, rejectP) => {
            const env = { ...process.env };
            if (askpassPath) {
                env.GIT_ASKPASS = askpassPath;
                env.GIT_TERMINAL_PROMPT = "0";
                env.GCM_INTERACTIVE = "never";
            }
            // beta.34: expose the token to the persistent cred-helper (which reads
            // $OAH_GH_TOKEN). Never logged, never persisted; lives only in this
            // child process env.
            if (token)
                env.OAH_GH_TOKEN = token;
            const proc = spawn("git", args, { env });
            let out = "";
            let err = "";
            proc.stdout.on("data", (c) => (out += c.toString()));
            proc.stderr.on("data", (c) => (err += c.toString()));
            proc.on("error", rejectP);
            proc.on("close", (code) => {
                if (code === 0)
                    resolveP(out);
                else
                    rejectP(new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`));
            });
        });
    }
    /**
     * beta.53: run an arbitrary command (e.g. `npm ci`) in `cwd` with a hard
     * timeout. Used by worktree dep bootstrap. Rejects on non-zero exit, spawn
     * error, or timeout (the caller treats all as non-fatal best-effort).
     */
    runCmd(cmd, args, cwd, timeoutMs) {
        return new Promise((resolveP, rejectP) => {
            const proc = spawn(cmd, args, { cwd, env: { ...process.env } });
            let out = "";
            let err = "";
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                try {
                    proc.kill("SIGKILL");
                }
                catch { /* ignore */ }
                rejectP(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
            proc.stdout?.on("data", (c) => (out += c.toString()));
            proc.stderr?.on("data", (c) => (err += c.toString()));
            proc.on("error", (e) => { if (!settled) {
                settled = true;
                clearTimeout(timer);
                rejectP(e);
            } });
            proc.on("close", (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (code === 0)
                    resolveP(out);
                else
                    rejectP(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err.trim().slice(0, 500)}`));
            });
        });
    }
}
//# sourceMappingURL=git-worktree.js.map