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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface GitAdapterOptions {
  worktreesRoot: string;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
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
      const url = `https://github.com/${ctx.repoFullName}.git`;
      if (!existsSync(bare)) {
        await mkdir(dirname(bare), { recursive: true });
        await this.run(["clone", "--bare", "--filter=blob:none", url, bare], undefined, ask.path);
      } else {
        await this.run(["-C", bare, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], undefined, ask.path);
      }
      await this.run(["-C", bare, "worktree", "add", "-B", ctx.sessionBranch, wt, ctx.baseBranch]);
      await this.run(["-C", wt, "config", "user.name", ctx.commitIdentity.name]);
      await this.run(["-C", wt, "config", "user.email", ctx.commitIdentity.email]);
      // Ensure the worktree remote points at github over https so push works.
      await this.run(["-C", wt, "remote", "set-url", "origin", url]);
    } finally {
      await ask.cleanup();
    }

    return wt;
  }

  async release(sessionId: string, repoFullName: string): Promise<void> {
    const wt = this.sessionWorktreePath(sessionId);
    if (!existsSync(wt)) return;
    const bare = this.repoBarePath(repoFullName);
    try {
      await this.run(["-C", bare, "worktree", "remove", "--force", wt]);
    } catch (err) {
      this.opts.logger.warn("[git] worktree remove failed; falling back to rm -rf", { err: String(err) });
      await rm(wt, { recursive: true, force: true });
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
