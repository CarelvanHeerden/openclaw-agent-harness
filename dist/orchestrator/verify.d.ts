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
 * beta.9 probes are OPTIONAL in the type for test-double back-compat, but as
 * of beta.57 a kind whose probe is missing FAILS CLOSED (it used to skip-pass,
 * which let a mis-wired caller green-light contracts it could not verify).
 * The only graceful fallbacks left are ones that verify via ANOTHER probe
 * (`file_written` -> fileWrittenSince, `remote_branch_exists` -> remoteBranchExists,
 * `pr_opened` -> prUrlPresent).
 */
export interface VerifyProbes {
    /** Does `branch` exist on origin? (GET refs/heads/{branch} == 200) */
    remoteBranchExists: (branch: string) => Promise<{
        exists: boolean;
        detail: string;
    }>;
    /** Was a PR URL captured for this session/branch? */
    prUrlPresent: () => Promise<{
        present: boolean;
        url?: string;
        detail: string;
    }>;
    /**
     * Was `path` written after `sinceMs` with a non-empty diff vs base?
     * beta.8 implementation uses git diff — EXCLUDES untracked files.
     * beta.9: `file_written` kind switches to `fileExistsOnDisk` when available;
     * this probe is kept for backward compat and for callers that still need it.
     */
    fileWrittenSince: (path: string, sinceMs: number) => Promise<{
        written: boolean;
        detail: string;
    }>;
    /** Is there a new commit vs the sub-task's base sha? */
    commitMadeSince: (baseSha: string) => Promise<{
        made: boolean;
        detail: string;
    }>;
    /**
     * Does `path` exist on the worktree filesystem and is it non-empty?
     * Fixes the beta.8 `file_written` bug: untracked files are now visible.
     * When absent, `file_written` falls back to `fileWrittenSince` (beta.8 behaviour).
     *
     * beta.57 (P1): optional `sinceMs`. When > 0 the probe must ALSO check the
     * file is fresh (mtime >= sinceMs, or committed/changed since base) so a file
     * that merely PRE-EXISTED the sub-task can no longer vacuously satisfy a
     * `file_written` contract.
     */
    fileExistsOnDisk?: (path: string, sinceMs?: number) => Promise<{
        exists: boolean;
        nonEmpty: boolean;
        detail: string;
    }>;
    /**
     * Does `path` appear in `git log <baseSha>..HEAD --name-only`?
     * Used by the `file_committed` contract kind.
     */
    fileCommittedSince?: (path: string, baseSha: string) => Promise<{
        committed: boolean;
        detail: string;
    }>;
    /**
     * What is the tip SHA of `branch` on the remote?
     * Used by `remote_branch_exists` (SHA field) and `commit_sha_matches`.
     */
    remoteBranchSha?: (branch: string) => Promise<{
        sha: string | undefined;
        detail: string;
    }>;
    /**
     * Does `path` exist in remote `branch` contents (GET /contents/{path}?ref={branch})?
     * Used by `file_pushed`.
     */
    remoteFileExists?: (path: string, branch: string) => Promise<{
        exists: boolean;
        detail: string;
    }>;
    /**
     * List open/closed PRs for `branch`. Returns count + per-PR metadata.
     * Used by `pr_opened` (when available, supercedes `prUrlPresent`), `pr_state`, and `file_in_pr`.
     */
    prForBranch?: (branch: string) => Promise<{
        count: number;
        /** beta.57: `merged` distinguishes merged from closed-without-merge (GitHub state is "closed" for both). Optional for back-compat. */
        prs: Array<{
            number: number;
            state: string;
            draft: boolean;
            url: string;
            merged?: boolean;
        }>;
        detail: string;
    }>;
    /**
     * List files changed in PR `prNumber`.
     * Used by `file_in_pr`.
     */
    prFiles?: (prNumber: number) => Promise<{
        files: Array<{
            filename: string;
        }>;
        detail: string;
    }>;
    /**
     * What is the current worktree HEAD sha?
     * Used by `commit_sha_matches`.
     */
    localHeadSha?: () => Promise<{
        sha: string;
        detail: string;
    }>;
}
/**
 * Pure evaluator: given per-check booleans, decide overall pass/fail and
 * build the summary. Separated so tests don't need real probes.
 */
export declare function evaluateVerification(results: VerifyProbeResult[]): VerifyOutcome;
/**
 * Run all `verify` contracts for a sub-task via the injected probes.
 *
 * beta.9: handles 8 contract kinds. New kinds use new optional probes
 * (graceful fallback when absent). Backward compat: old kinds still work
 * exactly as in beta.8 when only beta.8 probes are provided.
 */
export declare function verifySubTaskOutput(verify: SubTaskVerify[] | undefined, ctx: {
    defaultBranch: string;
    subTaskStartMs: number;
    baseSha: string;
}, probes: VerifyProbes): Promise<VerifyOutcome>;
//# sourceMappingURL=verify.d.ts.map