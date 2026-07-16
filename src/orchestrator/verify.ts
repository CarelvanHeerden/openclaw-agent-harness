/**
 * Sub-task output verification (beta.7 fix #1).
 *
 * The Claude Agent SDK reports a `stopReason`. For pure-reasoning sub-tasks
 * that's an acceptable "done" signal. But for sub-tasks with OBSERVABLE side
 * effects (push a branch, open a PR, write a file) the SDK can report
 * `end_turn: completed` while having produced nothing on the remote or disk.
 *
 * Smoke test on beta.6 caught exactly this: sub-tasks "push branch" and
 * "open draft PR" both returned completed and burned $1.02 combined, yet no
 * ref and no PR ever existed. Only the adversary caught it (by independently
 * querying the remote).
 *
 * This module runs AFTER the worker's SDK turn and BEFORE the sub-task is
 * marked completed. Any failed check flips the sub-task to `failed` and the
 * spend is tagged as wasted. The results also feed the review as local
 * "runtime data" so the adversary's `runtime: no runtime data` gap closes
 * for tasks with observable outputs.
 *
 * Kept as pure logic (`evaluateVerification`) + injected probes so it is
 * unit-testable without a live git remote.
 *
 * beta.9: extended with 6 new contract kinds and split `file_written` to use
 * fs.stat instead of git diff, fixing the untracked-file bug from beta.8.
 */

import type { SubTaskVerify } from "./fable5-lead.js";

export interface VerifyProbeResult {
  kind: SubTaskVerify["kind"];
  passed: boolean;
  detail: string;
}

export interface VerifyOutcome {
  /** True only if every requested check passed. */
  ok: boolean;
  /** Per-check results, suitable for audit + runtime-data surfacing. */
  results: VerifyProbeResult[];
  /** One-line human summary. */
  summary: string;
}

/**
 * Injected probes. Real impls wrap git / the provider REST API / fs.stat.
 * All return a plain boolean + detail string so the pure evaluator can stay
 * side-effect-free and fully unit-tested.
 *
 * beta.8 probes are REQUIRED (all existing callers provide them).
 * beta.9 probes are OPTIONAL — when absent the relevant kind gracefully falls
 * back to the closest beta.8 probe or skips with a warning in `detail`.
 * This preserves backward compat for test doubles that predate beta.9.
 */
export interface VerifyProbes {
  // ---- beta.8 probes (required, all callers must provide) ----

  /** Does `branch` exist on origin? (GET refs/heads/{branch} == 200) */
  remoteBranchExists: (branch: string) => Promise<{ exists: boolean; detail: string }>;
  /** Was a PR URL captured for this session/branch? */
  prUrlPresent: () => Promise<{ present: boolean; url?: string; detail: string }>;
  /**
   * Was `path` written after `sinceMs` with a non-empty diff vs base?
   * beta.8 implementation uses git diff — EXCLUDES untracked files.
   * beta.9: `file_written` kind switches to `fileExistsOnDisk` when available;
   * this probe is kept for backward compat and for callers that still need it.
   */
  fileWrittenSince: (path: string, sinceMs: number) => Promise<{ written: boolean; detail: string }>;
  /** Is there a new commit vs the sub-task's base sha? */
  commitMadeSince: (baseSha: string) => Promise<{ made: boolean; detail: string }>;

  // ---- beta.9 probes (optional — backward compat when absent) ----

  /**
   * Does `path` exist on the worktree filesystem and is it non-empty?
   * Fixes the beta.8 `file_written` bug: untracked files are now visible.
   * When absent, `file_written` falls back to `fileWrittenSince` (beta.8 behaviour).
   */
  fileExistsOnDisk?: (path: string) => Promise<{ exists: boolean; nonEmpty: boolean; detail: string }>;

  /**
   * Does `path` appear in `git log <baseSha>..HEAD --name-only`?
   * Used by the `file_committed` contract kind.
   */
  fileCommittedSince?: (path: string, baseSha: string) => Promise<{ committed: boolean; detail: string }>;

  /**
   * What is the tip SHA of `branch` on the remote?
   * Used by `remote_branch_exists` (SHA field) and `commit_sha_matches`.
   */
  remoteBranchSha?: (branch: string) => Promise<{ sha: string | undefined; detail: string }>;

  /**
   * Does `path` exist in remote `branch` contents (GET /contents/{path}?ref={branch})?
   * Used by `file_pushed`.
   */
  remoteFileExists?: (path: string, branch: string) => Promise<{ exists: boolean; detail: string }>;

  /**
   * List open/closed PRs for `branch`. Returns count + per-PR metadata.
   * Used by `pr_opened` (when available, supercedes `prUrlPresent`), `pr_state`, and `file_in_pr`.
   */
  prForBranch?: (branch: string) => Promise<{
    count: number;
    prs: Array<{ number: number; state: string; draft: boolean; url: string }>;
    detail: string;
  }>;

  /**
   * List files changed in PR `prNumber`.
   * Used by `file_in_pr`.
   */
  prFiles?: (prNumber: number) => Promise<{ files: Array<{ filename: string }>; detail: string }>;

  /**
   * What is the current worktree HEAD sha?
   * Used by `commit_sha_matches`.
   */
  localHeadSha?: () => Promise<{ sha: string; detail: string }>;
}

/**
 * Pure evaluator: given per-check booleans, decide overall pass/fail and
 * build the summary. Separated so tests don't need real probes.
 */
export function evaluateVerification(results: VerifyProbeResult[]): VerifyOutcome {
  if (results.length === 0) {
    return { ok: true, results, summary: "no observable checks (SDK signal trusted)" };
  }
  const failed = results.filter((r) => !r.passed);
  const ok = failed.length === 0;
  const summary = ok
    ? `all ${results.length} observable check(s) passed`
    : `${failed.length}/${results.length} observable check(s) FAILED: ${failed
        .map((f) => `${f.kind} (${f.detail})`)
        .join("; ")}`;
  return { ok, results, summary };
}

/**
 * Run all `verify` contracts for a sub-task via the injected probes.
 *
 * beta.9: handles 8 contract kinds. New kinds use new optional probes
 * (graceful fallback when absent). Backward compat: old kinds still work
 * exactly as in beta.8 when only beta.8 probes are provided.
 */
export async function verifySubTaskOutput(
  verify: SubTaskVerify[] | undefined,
  ctx: { defaultBranch: string; subTaskStartMs: number; baseSha: string },
  probes: VerifyProbes,
): Promise<VerifyOutcome> {
  if (!verify || verify.length === 0) return evaluateVerification([]);

  const results: VerifyProbeResult[] = [];
  for (const v of verify) {
    switch (v.kind) {
      // ---- beta.8 kinds ----
      case "branch_pushed": {
        const branch = v.branch ?? ctx.defaultBranch;
        const r = await probes.remoteBranchExists(branch);
        results.push({ kind: v.kind, passed: r.exists, detail: r.detail });
        break;
      }
      case "pr_opened": {
        // beta.9: prefer prForBranch (richer API check) over prUrlPresent (session-local)
        if (probes.prForBranch) {
          const r = await probes.prForBranch(ctx.defaultBranch);
          const passed = r.count >= 1;
          const url = r.prs[0]?.url;
          results.push({ kind: v.kind, passed, detail: passed ? `PR ${url ?? r.prs[0]?.number}` : r.detail });
        } else {
          const r = await probes.prUrlPresent();
          results.push({ kind: v.kind, passed: r.present, detail: r.url ? `PR ${r.url}` : r.detail });
        }
        break;
      }
      case "file_written": {
        // beta.9 FIX: use fs.stat (includes untracked files) when probe available.
        // Falls back to git-diff-based probe for backward compat with beta.8 test doubles.
        if (probes.fileExistsOnDisk) {
          const r = await probes.fileExistsOnDisk(v.path);
          const passed = r.exists && r.nonEmpty;
          results.push({ kind: v.kind, passed, detail: r.detail });
        } else {
          // Backward compat: beta.8 behaviour (git diff, excludes untracked)
          const r = await probes.fileWrittenSince(v.path, ctx.subTaskStartMs);
          results.push({ kind: v.kind, passed: r.written, detail: r.detail });
        }
        break;
      }
      case "commit_made": {
        const r = await probes.commitMadeSince(ctx.baseSha);
        results.push({ kind: v.kind, passed: r.made, detail: r.detail });
        break;
      }

      // ---- beta.9 kinds ----
      case "file_committed": {
        if (probes.fileCommittedSince) {
          const r = await probes.fileCommittedSince(v.path, ctx.baseSha);
          results.push({ kind: v.kind, passed: r.committed, detail: r.detail });
        } else {
          // Graceful skip: probe not provided; trust SDK signal for this check.
          results.push({ kind: v.kind, passed: true, detail: "fileCommittedSince probe not provided; check skipped (SDK trusted)" });
        }
        break;
      }
      case "remote_branch_exists": {
        const branch = v.branch ?? ctx.defaultBranch;
        // Use remoteBranchSha for richer detail when available; fall back to remoteBranchExists.
        if (probes.remoteBranchSha) {
          const r = await probes.remoteBranchSha(branch);
          const passed = r.sha !== undefined;
          results.push({ kind: v.kind, passed, detail: r.detail });
        } else {
          const r = await probes.remoteBranchExists(branch);
          results.push({ kind: v.kind, passed: r.exists, detail: r.detail });
        }
        break;
      }
      case "file_pushed": {
        const branch = v.branch ?? ctx.defaultBranch;
        if (probes.remoteFileExists) {
          const r = await probes.remoteFileExists(v.path, branch);
          results.push({ kind: v.kind, passed: r.exists, detail: r.detail });
        } else {
          // Graceful skip: probe not provided.
          results.push({ kind: v.kind, passed: true, detail: "remoteFileExists probe not provided; check skipped (SDK trusted)" });
        }
        break;
      }
      case "pr_state": {
        if (probes.prForBranch) {
          const r = await probes.prForBranch(ctx.defaultBranch);
          if (r.count === 0) {
            results.push({ kind: v.kind, passed: false, detail: `no PR found for branch; ${r.detail}` });
          } else {
            const pr = r.prs[0]!;
            // Map GitHub state + draft flag to our state vocabulary.
            const effectiveState = pr.draft ? "draft" : pr.state === "closed" ? "merged" : pr.state;
            const passed = effectiveState === v.state;
            results.push({ kind: v.kind, passed, detail: `PR #${pr.number} state=${effectiveState} (expected ${v.state})` });
          }
        } else {
          results.push({ kind: v.kind, passed: true, detail: "prForBranch probe not provided; check skipped (SDK trusted)" });
        }
        break;
      }
      case "file_in_pr": {
        if (probes.prFiles && v.prNumber !== undefined) {
          const r = await probes.prFiles(v.prNumber);
          const present = r.files.some((f) => f.filename === v.path || f.filename.endsWith(`/${v.path}`));
          results.push({ kind: v.kind, passed: present, detail: present ? `${v.path} in PR #${v.prNumber} files` : `${v.path} not found in PR #${v.prNumber} files; ${r.detail}` });
        } else if (probes.prForBranch && probes.prFiles) {
          // Look up prNumber from branch if not specified.
          const pr = await probes.prForBranch(ctx.defaultBranch);
          const prNum = pr.prs[0]?.number;
          if (!prNum) {
            results.push({ kind: v.kind, passed: false, detail: `no open PR found to check file in; ${pr.detail}` });
          } else {
            const r = await probes.prFiles(prNum);
            const present = r.files.some((f) => f.filename === v.path || f.filename.endsWith(`/${v.path}`));
            results.push({ kind: v.kind, passed: present, detail: present ? `${v.path} in PR #${prNum} files` : `${v.path} not found in PR #${prNum}; ${r.detail}` });
          }
        } else {
          results.push({ kind: v.kind, passed: true, detail: "prFiles probe not provided; check skipped (SDK trusted)" });
        }
        break;
      }
      case "commit_sha_matches": {
        const branch = v.branch ?? ctx.defaultBranch;
        if (probes.localHeadSha && probes.remoteBranchSha) {
          const [local, remote] = await Promise.all([probes.localHeadSha(), probes.remoteBranchSha(branch)]);
          if (!remote.sha) {
            results.push({ kind: v.kind, passed: false, detail: `remote branch ${branch} not found; ${remote.detail}` });
          } else {
            const passed = local.sha === remote.sha;
            results.push({ kind: v.kind, passed, detail: passed ? `SHA matches: ${local.sha.slice(0, 12)}` : `SHA mismatch: local=${local.sha.slice(0, 12)} remote=${remote.sha.slice(0, 12)}` });
          }
        } else {
          results.push({ kind: v.kind, passed: true, detail: "localHeadSha/remoteBranchSha probes not provided; check skipped (SDK trusted)" });
        }
        break;
      }
    }
  }
  return evaluateVerification(results);
}
