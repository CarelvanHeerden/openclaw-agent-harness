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
    /** Was `path` written after `sinceMs` with a non-empty diff vs base? */
    fileWrittenSince: (path: string, sinceMs: number) => Promise<{
        written: boolean;
        detail: string;
    }>;
    /** Is there a new commit vs the sub-task's base sha? */
    commitMadeSince: (baseSha: string) => Promise<{
        made: boolean;
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
 */
export declare function verifySubTaskOutput(verify: SubTaskVerify[] | undefined, ctx: {
    defaultBranch: string;
    subTaskStartMs: number;
    baseSha: string;
}, probes: VerifyProbes): Promise<VerifyOutcome>;
//# sourceMappingURL=verify.d.ts.map