import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { HarnessConfig } from "../config.js";
import type { GitAdapter } from "../adapters/git-worktree.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { LeadPlan } from "./fable5-lead.js";
import type { VerifyProbes } from "./verify.js";
import { resolveContractPath } from "./path-match.js";

/**
 * beta.123: the verification probes, lifted out of createRuntime so a test can
 * hold the REAL ones.
 *
 * They lived inline in index.ts, closed over `git`/`pat`/`config`, and were
 * therefore unreachable from any test -- every suite that drives the loop had
 * to hand it a stub whose answers were decided by the test. So the probes were
 * covered by exactly nothing, and `file_committed` reading a `git mv` as "you
 * did not do the work" survived to kill the b122 smoke on its last sub-task.
 *
 * Nothing here changed in the lift. The factory takes what the closure used to
 * capture and returns the same builder the runtime passes to the loop.
 */
export interface VerifyProbeContext {
  git: GitAdapter;
  pat: PatRouter;
  config: HarnessConfig;
  /**
   * Stays a callback rather than moving with the probes: it closes over the
   * credential adapter and the runtime logger, and a test that wants real git
   * behaviour against a local bare repo needs no token at all.
   */
  resolveGitToken: (resolution: ReturnType<PatRouter["resolve"]>) => Promise<string>;
}

export interface BuildVerifyProbesArgs {
  plan: LeadPlan;
  requester: string;
  worktreePath: string;
  baseSha: string;
}

export function createVerifyProbes(
  ctx: VerifyProbeContext,
): (args: BuildVerifyProbesArgs) => VerifyProbes {
  const { git, pat, config, resolveGitToken } = ctx;
  return ({ plan, requester, worktreePath, baseSha }: BuildVerifyProbesArgs): VerifyProbes => {
    const resolution = pat.resolve({
      slackUserId: requester ?? config.slack.authorised_users[0]!,
      gitHubUser: plan.repo.split("/")[0]!,
      repoFullName: plan.repo,
    });
    return {
      remoteBranchExists: async (branch: string) => {
        const b = branch || plan.branch;
        try {
          const ghToken = await resolveGitToken(resolution);
          const [owner, repoName] = plan.repo.split("/");
          let url: string;
          if (resolution.provider === "gitlab") {
            const projectId = encodeURIComponent(`${owner}/${repoName}`);
            url = `${resolution.apiBase}/projects/${projectId}/repository/branches/${encodeURIComponent(b)}`;
          } else {
            url = `${resolution.apiBase}/repos/${owner}/${repoName}/git/refs/heads/${b}`;
          }
          const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
          return { exists: res.status === 200, detail: `${resolution.provider} ref lookup HTTP ${res.status} for ${b}` };
        } catch (err) {
          return { exists: false, detail: `ref lookup error: ${String(err)}` };
        }
      },
      prUrlPresent: async () => {
        // Independently query the provider for an OPEN/ANY PR whose head is
        // this branch. Do NOT trust a persisted URL alone.
        try {
          const ghToken = await resolveGitToken(resolution);
          const [owner, repoName] = plan.repo.split("/");
          if (resolution.provider === "gitlab") {
            const projectId = encodeURIComponent(`${owner}/${repoName}`);
            const url = `${resolution.apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(plan.branch)}&state=all`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
            const arr = (await res.json().catch(() => [])) as unknown[];
            const present = Array.isArray(arr) && arr.length > 0;
            return { present, url: present ? (arr[0] as { web_url?: string }).web_url : undefined, detail: `gitlab MR count ${Array.isArray(arr) ? arr.length : 0}` };
          }
          const url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls?head=${owner}:${encodeURIComponent(plan.branch)}&state=all`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
          const arr = (await res.json().catch(() => [])) as unknown[];
          const present = Array.isArray(arr) && arr.length > 0;
          return { present, url: present ? (arr[0] as { html_url?: string }).html_url : undefined, detail: `github PR count ${Array.isArray(arr) ? arr.length : 0}` };
        } catch (err) {
          return { present: false, detail: `PR lookup error: ${String(err)}` };
        }
      },
      fileWrittenSince: async (path: string, sinceMs: number) => {
        try {
          // beta.51: structural path resolution (see path-match.ts) so a
          // route-semantics contract path matches the real committed/changed
          // filesystem path.
          const changed = await git.listChangedFiles(worktreePath, baseSha || (await git.baseSha(worktreePath)));
          // beta.59: per-sub-task-scoped diff (base = worker-session-start SHA),
          // so a basename-unique fallback is safe here (a lone same-basename
          // file in this tiny diff is the file this sub-task just wrote).
          const match = resolveContractPath(changed, path, { allowBasenameFallback: true, allowTestFileFallback: true });
          if (!match) {
            return { written: false, detail: `file not in diff vs base (${changed.length} changed: ${changed.slice(0, 8).join(", ")})` };
          }
          if (sinceMs === 0) {
            return { written: true, detail: `file changed vs base (${match.file} via ${match.rule} match)` };
          }
          const abs = resolve(worktreePath, match.file);
          const st = await stat(abs);
          const freshEnough = st.mtimeMs >= sinceMs - 1000;
          return { written: freshEnough, detail: freshEnough ? `file changed vs base (${match.file} via ${match.rule} match)` : `${match.file} mtime predates sub-task start` };
        } catch (err) {
          return { written: false, detail: `stat error: ${String(err)}` };
        }
      },
      commitMadeSince: async (base: string) => {
        try {
          const head = await git.baseSha(worktreePath);
          const made = !!base && head !== base;
          return { made, detail: made ? `HEAD ${head.slice(0, 7)} != base ${base.slice(0, 7)}` : `no new commit (HEAD ${head.slice(0, 7)} == base ${(base || "").slice(0, 7)})` };
        } catch (err) {
          return { made: false, detail: `rev-parse error: ${String(err)}` };
        }
      },

      // ---- beta.10 optional probes (fully wired) ----

      /** file_written kind: fs.stat on the worktree. Includes untracked files (fixes beta.8 bug). */
      fileExistsOnDisk: async (path: string, sinceMs?: number) => {
        // beta.51: literal-path primary (untracked files aren't in git diff),
        // structural committed-file fallback for route-group / prefix drift.
        const tryStat = async (rel: string) => {
          const abs = resolve(worktreePath, rel);
          const st = await stat(abs);
          return { isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
        };
        try {
          const s = await tryStat(path);
          // beta.57 (P1): freshness check. A file that merely PRE-EXISTED the
          // sub-task must not vacuously satisfy `file_written`. Fresh = mtime
          // at/after the sub-task start (2s clock slack), which also covers
          // untracked just-written files that git diff can't see.
          if (s.isFile && sinceMs && sinceMs > 0 && s.mtimeMs < sinceMs - 2000) {
            return {
              exists: true,
              nonEmpty: false,
              // beta.105: distinguish stale from empty. `nonEmpty: false`
              // carries both, and only the stale case can be answered by
              // asking git whether this sub-task renamed the file into place.
              stale: true,
              detail: `file present (${s.size} bytes) but its mtime predates the sub-task start -- pre-existing, not written by this sub-task`,
            };
          }
          return {
            exists: s.isFile,
            nonEmpty: s.size > 0,
            detail: s.isFile ? (s.size > 0 ? `file present (${s.size} bytes)` : "file present but empty") : "path exists but is not a regular file",
          };
        } catch {
          try {
            const committed = await git.listCommittedFiles(worktreePath, baseSha).catch(() => [] as string[]);
            // beta.59: per-sub-task-scoped commit list -> basename-unique fallback safe.
            // beta.76: + test-file-unique for a descriptively-named test file.
            const match = resolveContractPath(committed, path, { allowBasenameFallback: true, allowTestFileFallback: true });
            if (match) {
              const s = await tryStat(match.file);
              return {
                exists: s.isFile,
                nonEmpty: s.size > 0,
                detail: s.isFile ? `file present via ${match.rule} match (${match.file}, ${s.size} bytes)` : "matched path is not a regular file",
              };
            }
            return { exists: false, nonEmpty: false, detail: `no file matching contract path (checked literal + ${committed.length} committed)` };
          } catch (err2) {
            const msg = err2 instanceof Error ? err2.message : String(err2);
            return { exists: false, nonEmpty: false, detail: `stat error: ${msg}` };
          }
        }
      },

      /**
       * file_committed kind: file appears in `git log base..HEAD --name-only`.
       *
       * beta.84 (#1): GROUND-TRUTH hardening. Two changes that together kill
       * the cyc2-seq7 false-positive (a `route.ts` contract that basename-
       * unique-matched its `download/route.ts` sibling and reported PASS):
       *   1. STRICT-CONTRACT resolution -- only structural matches (exact /
       *      route-group / suffix / basename-dir, all of which require real
       *      directory context); the fuzzy `basename-unique` / `test-file-
       *      unique` fallbacks are DISABLED here. Topology drift is now cured
       *      structurally by the beta.76 contract-rederive pass that runs
       *      BEFORE verification, so file_committed no longer needs the nets.
       *   2. NON-ZERO DIFF gate -- once a structural match is found, the
       *      EXACT resolved path must have >=1 line changed in base..HEAD
       *      (`git diff --numstat`). A commit that renames/touches a sibling
       *      but leaves the contract file untouched no longer passes.
       */
      fileCommittedSince: async (path: string, base: string) => {
        /**
         * beta.123: was the contract path renamed away inside this window, to
         * something that survived? A pure rename changes zero lines, so both
         * of the gates below read it as "no work done" -- which is how the b122
         * smoke failed its last sub-task for doing exactly what the review had
         * asked. The rename must come from git's own `R` record within the same
         * range AND the destination must be in the committed set, so this
         * cannot be used to pass off an unrelated move as the work.
         */
        const renamedAway = async (contractPath: string, committed: string[]) => {
          const moved = await git
            .pathRenamedAwaySince(worktreePath, base, contractPath)
            .catch(() => ({ renamed: false, to: "", score: "", detail: "" }));
          if (!moved.renamed || !moved.to) return null;
          const destCommitted = committed.some(
            (f) => f === moved.to || f.endsWith(`/${moved.to}`) || moved.to.endsWith(`/${f}`),
          );
          if (!destCommitted) return null;
          // Appearing in the window is not the same as surviving it: a file
          // renamed and then deleted is reported at both paths, and accepting
          // that would turn "the work moved" into "the work is gone".
          try {
            const st = await stat(resolve(worktreePath, moved.to));
            if (!st.isFile() || st.size === 0) return null;
          } catch {
            return null;
          }
          return moved;
        };
        try {
          const files = await git.listCommittedFiles(worktreePath, base);
          const match = resolveContractPath(files, path, { strictContract: true });
          const matchedFile = match?.file;
          const matchedRule = match?.rule ?? null;
          if (matchedRule === null || !matchedFile) {
            // beta.123: the usual shape of a rename. `git log --name-only`
            // reports only the DESTINATION, so a contract naming the old path
            // matches nothing at all and never reaches the diff gate below --
            // the probe-level test for the b122 defect fails here, two steps
            // before the place the smoke log pointed at.
            const movedUnmatched = await renamedAway(path, files);
            if (movedUnmatched) {
              return {
                committed: true,
                diffLines: 0,
                detail: `contract path ${path} was RENAMED to ${movedUnmatched.to} (${movedUnmatched.score}) in ${base ? base.slice(0, 7) : "base"}..HEAD -- a pure rename changes 0 lines by construction; the work is at the new path`,
              };
            }
            return {
              committed: false,
              diffLines: 0,
              detail: `contract path not committed via a structural (non-fuzzy) match (${files.length} file(s) in ${base ? base.slice(0, 7) : "base"}..HEAD: ${files.slice(0, 8).join(", ")})`,
            };
          }
          // beta.84 (#1): the file is in the commit range structurally -- now
          // require it to actually have a non-empty diff for the EXACT matched
          // path. This is the un-fuzzable predicate.
          const diffLines = await git.fileDiffLineCount(worktreePath, base, matchedFile).catch(() => 0);
          if (diffLines > 0) {
            return {
              committed: true,
              diffLines,
              detail: `file appears in ${base ? base.slice(0, 7) : "base"}..HEAD via ${matchedRule} match (${matchedFile}; +/-${diffLines} lines; ${files.length} file(s) total)`,
            };
          }
          // beta.123: a pure rename is zero changed lines BY CONSTRUCTION, so
          // the b84 non-zero-diff gate reads `git mv` as "you did not do the
          // work". On the b122 smoke the adversary had explicitly asked for
          // the rename, the worker committed a clean R100, and this gate
          // failed the sub-task and killed a run holding 14 good commits.
          //
          // Ask git the question the line count cannot answer. This does not
          // widen the gate: the rename must be reported BY GIT within the
          // same window, and the destination must itself be in the committed
          // set, so a worker cannot dodge verification by renaming something
          // unrelated. Anything else still fails exactly as before.
          const moved = await renamedAway(matchedFile, files);
          if (moved) {
            return {
              committed: true,
              diffLines,
              detail: `contract file ${matchedFile} was RENAMED to ${moved.to} (${moved.score}) in ${base ? base.slice(0, 7) : "base"}..HEAD -- a pure rename changes 0 lines by construction; the work is at the new path`,
            };
          }
          return {
            committed: false,
            diffLines,
            detail: `contract file matched ${matchedFile} via ${matchedRule} but its diff in ${base ? base.slice(0, 7) : "base"}..HEAD is EMPTY (0 lines changed) -- the commit did not modify this file`,
          };
        } catch (err) {
          return { committed: false, diffLines: 0, detail: `git log error: ${String(err)}` };
        }
      },

      /**
       * beta.85: file present on disk AND committed anywhere in the BRANCH
       * range `branchBaseSha..HEAD`. Powers the revise-relaxed acceptance of
       * a not-targeted contract file (already shipped in a prior cycle, the
       * worker correctly left it alone). Structural match (route-group/prefix
       * drift ok) + a disk-presence check so an accidentally-deleted file
       * still fails.
       */
      /**
       * beta.105: did THIS sub-task put the file at this path? Answers the
       * question `file_written`'s mtime check is a proxy for, from git, so a
       * correct `git mv` (which preserves mtime) stops producing a
       * `file_committed` PASS and a `file_written` FAIL on the same file in
       * the same commit. See VerifyProbes.filePathIntroducedSince.
       */
      filePathIntroducedSince: async (path: string, baseSha: string) => {
        try {
          const introduced = await git.pathIntroducedSince(worktreePath, baseSha, path);
          return introduced;
        } catch (err) {
          return { introduced: false, changeType: "", detail: `git log error: ${String(err)}` };
        }
      },
      fileCommittedInBranch: async (path: string, branchBaseSha: string) => {
        try {
          const files = await git.listCommittedFiles(worktreePath, branchBaseSha);
          // beta.87 (Staging deep-dive [3]): STRICT structural match only. The
          // relaxed path must NOT accept the fuzzy basename-unique fallback --
          // that is the exact matcher that produced the 1c744d70 sibling
          // false-positive and that beta.84 hardened `fileCommittedSince` away
          // from. A not-targeted revise file must be matched by real directory
          // context (exact/route-group/suffix/basename-dir), never by a lone
          // same-basename sibling. Route-group/prefix drift is still covered
          // by the structural rules.
          const match = resolveContractPath(files, path, { strictContract: true });
          if (!match) {
            return { present: false, detail: `not committed in branch ${branchBaseSha ? branchBaseSha.slice(0, 7) : "base"}..HEAD (${files.length} file(s))` };
          }
          try {
            const st = await stat(resolve(worktreePath, match.file));
            if (!st.isFile() || st.size === 0) {
              return { present: false, detail: `committed in branch via ${match.rule} (${match.file}) but not present/non-empty on disk now` };
            }
          } catch {
            return { present: false, detail: `committed in branch via ${match.rule} (${match.file}) but missing on disk now` };
          }
          return { present: true, detail: `present + committed in branch via ${match.rule} match (${match.file})` };
        } catch (err) {
          return { present: false, detail: `git log error: ${String(err)}` };
        }
      },

      /** remote_branch_exists / commit_sha_matches: tip SHA of `branch` on origin via git ls-remote. */
      remoteBranchSha: async (branch: string) => {
        try {
          const ghToken = await resolveGitToken(resolution).catch(() => undefined);
          const sha = await git.remoteBranchSha(worktreePath, "origin", branch, ghToken);
          return {
            sha,
            detail: sha ? `origin/${branch} tip ${sha.slice(0, 12)}` : `origin has no ref for ${branch}`,
          };
        } catch (err) {
          return { sha: undefined, detail: `ls-remote error: ${String(err)}` };
        }
      },

      /** file_pushed: GET /repos/{owner}/{repo}/contents/{path}?ref={branch}. Provider-aware. */
      remoteFileExists: async (path: string, branch: string) => {
        try {
          const ghToken = await resolveGitToken(resolution);
          const [owner, repoName] = plan.repo.split("/");
          let url: string;
          if (resolution.provider === "gitlab") {
            const projectId = encodeURIComponent(`${owner}/${repoName}`);
            url = `${resolution.apiBase}/projects/${projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
          } else {
            url = `${resolution.apiBase}/repos/${owner}/${repoName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
          }
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
          });
          return {
            exists: res.status === 200,
            detail: `${resolution.provider} contents lookup HTTP ${res.status} for ${path}@${branch}`,
          };
        } catch (err) {
          return { exists: false, detail: `contents lookup error: ${String(err)}` };
        }
      },

      /** pr_opened / pr_state / file_in_pr helper: PRs whose head is `branch`. Provider-aware. */
      prForBranch: async (branch: string) => {
        try {
          const ghToken = await resolveGitToken(resolution);
          const [owner, repoName] = plan.repo.split("/");
          if (resolution.provider === "gitlab") {
            const projectId = encodeURIComponent(`${owner}/${repoName}`);
            const url = `${resolution.apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
            const arr = (await res.json().catch(() => [])) as Array<{ iid?: number; state?: string; draft?: boolean; work_in_progress?: boolean; web_url?: string }>;
            const prs = Array.isArray(arr)
              ? arr
                  .filter((m) => typeof m.iid === "number")
                  .map((m) => ({
                    number: m.iid as number,
                    state: m.state ?? "unknown",
                    draft: !!(m.draft || m.work_in_progress),
                    url: m.web_url ?? "",
                  }))
              : [];
            return { count: prs.length, prs, detail: `gitlab MR count ${prs.length} for source_branch=${branch}` };
          }
          const url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
          const arr = (await res.json().catch(() => [])) as Array<{ number?: number; state?: string; draft?: boolean; html_url?: string; merged_at?: string | null }>;
          const prs = Array.isArray(arr)
            ? arr
                .filter((p) => typeof p.number === "number")
                .map((p) => ({
                  number: p.number as number,
                  state: p.state ?? "unknown",
                  draft: !!p.draft,
                  url: p.html_url ?? "",
                  // beta.57 (P1): GitHub state is "closed" for BOTH merged and
                  // rejected PRs; merged_at disambiguates for pr_state.
                  merged: !!p.merged_at,
                }))
            : [];
          return { count: prs.length, prs, detail: `github PR count ${prs.length} for head=${owner}:${branch}` };
        } catch (err) {
          return { count: 0, prs: [], detail: `PR lookup error: ${String(err)}` };
        }
      },

      /** file_in_pr: GET /repos/.../pulls/{n}/files. Provider-aware. */
      prFiles: async (prNumber: number) => {
        try {
          const ghToken = await resolveGitToken(resolution);
          const [owner, repoName] = plan.repo.split("/");
          let url: string;
          if (resolution.provider === "gitlab") {
            const projectId = encodeURIComponent(`${owner}/${repoName}`);
            url = `${resolution.apiBase}/projects/${projectId}/merge_requests/${prNumber}/changes`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
            const j = (await res.json().catch(() => ({}))) as { changes?: Array<{ new_path?: string; old_path?: string }> };
            const files = (j.changes ?? [])
              .map((c) => ({ filename: c.new_path ?? c.old_path ?? "" }))
              .filter((f) => f.filename);
            return { files, detail: `gitlab MR !${prNumber} changes ${files.length}` };
          }
          url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/files?per_page=100`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
          const arr = (await res.json().catch(() => [])) as Array<{ filename?: string }>;
          const files = Array.isArray(arr)
            ? arr.filter((f) => typeof f.filename === "string").map((f) => ({ filename: f.filename as string }))
            : [];
          return { files, detail: `github PR #${prNumber} files ${files.length}` };
        } catch (err) {
          return { files: [], detail: `PR files lookup error: ${String(err)}` };
        }
      },

      /** commit_sha_matches helper: local worktree HEAD SHA. */
      localHeadSha: async () => {
        try {
          const sha = await git.baseSha(worktreePath);
          return { sha, detail: `worktree HEAD ${sha.slice(0, 12)}` };
        } catch (err) {
          return { sha: "", detail: `rev-parse error: ${String(err)}` };
        }
      },
    };
  };
}
