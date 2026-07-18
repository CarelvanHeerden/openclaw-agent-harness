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
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface GitAdapterOptions {
  worktreesRoot: string;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
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
export function buildAuthedCloneUrl(repoFullName: string, token: string): string {
  const encoded = encodeURIComponent(token);
  return `https://x-access-token:${encoded}@github.com/${repoFullName}.git`;
}

export interface GitContext {
  repoFullName: string;
  baseBranch: string;
  sessionBranch: string;
  sessionId: string;
  ghToken: string;
  commitIdentity: { name: string; email: string };
}

export class GitAdapter {
  constructor(private readonly opts: GitAdapterOptions) {}

  private expand(p: string): string {
    return p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "") : p;
  }

  private repoBarePath(repoFullName: string): string {
    const [owner, repo] = repoFullName.split("/");
    return resolve(this.expand(this.opts.worktreesRoot), ".repos", owner!, `${repo!}.git`);
  }

  private sessionWorktreePath(sessionId: string): string {
    return resolve(this.expand(this.opts.worktreesRoot), sessionId);
  }

  /**
   * Writes a per-invocation askpass helper that prints the PAT on stdout.
   * The helper is chmod 0700 and lives in a fresh mkdtemp dir; caller
   * must clean it up.
   */
  private async makeAskpass(ghToken: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
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

  async allocate(ctx: GitContext): Promise<string> {
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
      } else {
        // For fetch on an existing bare, use askpass as before. The
        // remote URL is already the plain form; askpass injects creds.
        await this.run(["-C", bare, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], undefined, ask.path);
      }
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
      await this.run(["-C", bare, "worktree", "add", "-B", ctx.sessionBranch, wt, ctx.baseBranch], undefined, ask.path);
      await this.run(["-C", wt, "config", "user.name", ctx.commitIdentity.name]);
      await this.run(["-C", wt, "config", "user.email", ctx.commitIdentity.email]);
      // Ensure the worktree remote is the plain URL (no token on disk).
      await this.run(["-C", wt, "remote", "set-url", "origin", plainUrl]);
    } finally {
      await ask.cleanup();
    }

    return wt;
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
  async releaseByPath(worktreePath: string, repoFullName: string): Promise<{ ok: boolean; path: string; error?: string }> {
    if (!worktreePath) return { ok: false, path: worktreePath, error: "worktreePath is empty" };
    if (!existsSync(worktreePath)) return { ok: true, path: worktreePath, error: "worktree already gone" };
    const bare = this.repoBarePath(repoFullName);
    try {
      // Best-effort: git worktree remove. Uses --force so uncommitted state
      // doesn't block a terminal-session cleanup.
      await this.run(["-C", bare, "worktree", "remove", "--force", worktreePath]);
      // Confirm the physical path is actually gone. `git worktree remove`
      // sometimes only unregisters the worktree (e.g. if the gitdir link
      // is broken). Follow up with rm -rf when the dir survives.
      if (existsSync(worktreePath)) {
        await rm(worktreePath, { recursive: true, force: true });
      }
      // Also prune any dangling worktree admin state in the bare repo.
      await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
      return { ok: true, path: worktreePath };
    } catch (err) {
      this.opts.logger.warn("[git] worktree remove failed; falling back to rm -rf", { err: String(err), worktreePath });
      try {
        await rm(worktreePath, { recursive: true, force: true });
        // Prune the bare admin state so a subsequent `git fetch` doesn't
        // choke on "refusing to fetch into branch checked out at ...".
        await this.run(["-C", bare, "worktree", "prune"]).catch(() => "");
        return { ok: true, path: worktreePath, error: `git worktree remove failed, fallback rm -rf succeeded: ${String(err)}` };
      } catch (rmErr) {
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
  async release(sessionId: string, repoFullName: string, worktreePath?: string): Promise<{ ok: boolean; path: string; error?: string }> {
    const wt = worktreePath && worktreePath.length > 0 ? worktreePath : this.sessionWorktreePath(sessionId);
    return this.releaseByPath(wt, repoFullName);
  }

  /**
   * beta.17: enumerate leftover worktrees under the root that look like
   * per-session allocations (`pending-<timestamp>` or DB-session UUIDs).
   * Used by the startup self-heal path.
   */
  async listWorktreeDirs(): Promise<string[]> {
    const root = this.expand(this.opts.worktreesRoot);
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name !== ".repos")
        .map((e) => resolve(root, e.name));
    } catch {
      return [];
    }
  }

  async baseSha(worktreePath: string): Promise<string> {
    return (await this.run(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
  }

  async listChangedFiles(worktreePath: string, base: string): Promise<string[]> {
    const out = await this.run(["-C", worktreePath, "diff", "--name-only", base, "HEAD"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /**
   * beta.10: files touched by commits in `base..HEAD`.
   * Unlike `listChangedFiles` (`git diff`) this includes files reachable via
   * multi-commit history even if the net diff is empty; unlike `git diff` it
   * still ignores untracked files.
   * Used by the `file_committed` verify probe.
   */
  async listCommittedFiles(worktreePath: string, base: string): Promise<string[]> {
    // If HEAD == base (no new commits) return empty; git log would return empty anyway.
    if (!base) return [];
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
  async remoteBranchSha(
    worktreePath: string,
    remote: string,
    branch: string,
    ghToken?: string,
  ): Promise<string | undefined> {
    const ref = `refs/heads/${branch}`;
    const ask = ghToken ? await this.makeAskpass(ghToken) : undefined;
    try {
      const out = await this.run(
        ["-C", worktreePath, "ls-remote", remote, ref],
        undefined,
        ask?.path,
      ).catch(() => "");
      // `<sha>\t<ref>` on match; empty on no such branch.
      const line = out.split("\n").map((l) => l.trim()).find(Boolean);
      if (!line) return undefined;
      const [sha] = line.split(/\s+/);
      return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
    } finally {
      await ask?.cleanup();
    }
  }

  async commit(worktreePath: string, message: string, identity: { name: string; email: string }): Promise<string | null> {
    await this.run(["-C", worktreePath, "add", "-A"]);
    const status = await this.run(["-C", worktreePath, "status", "--porcelain"]);
    if (!status.trim()) return null;
    await this.run([
      "-C", worktreePath,
      "-c", `user.name=${identity.name}`,
      "-c", `user.email=${identity.email}`,
      "commit", "-m", message,
    ]);
    return (await this.run(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
  }

  async pushBranch(worktreePath: string, remote: string, branch: string, ghToken: string): Promise<void> {
    const ask = await this.makeAskpass(ghToken);
    try {
      await this.run(["-C", worktreePath, "push", remote, `${branch}:${branch}`], undefined, ask.path);
    } finally {
      await ask.cleanup();
    }
  }

  async formatPatch(worktreePath: string, base: string, outFile: string): Promise<void> {
    const patch = await this.run(["-C", worktreePath, "format-patch", `${base}..HEAD`, "--stdout"]);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, patch, "utf8");
  }

  async diff(worktreePath: string, base: string): Promise<string> {
    return this.run(["-C", worktreePath, "diff", base, "HEAD"]);
  }

  private run(args: string[], _cwd?: string, askpassPath?: string): Promise<string> {
    return new Promise((resolveP, rejectP) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (askpassPath) {
        env.GIT_ASKPASS = askpassPath;
        env.GIT_TERMINAL_PROMPT = "0";
        env.GCM_INTERACTIVE = "never";
      }
      const proc = spawn("git", args, { env });
      let out = "";
      let err = "";
      proc.stdout.on("data", (c) => (out += c.toString()));
      proc.stderr.on("data", (c) => (err += c.toString()));
      proc.on("error", rejectP);
      proc.on("close", (code) => {
        if (code === 0) resolveP(out);
        else rejectP(new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`));
      });
    });
  }
}
