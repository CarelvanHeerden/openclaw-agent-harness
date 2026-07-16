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
/**
 * Pure evaluator: given per-check booleans, decide overall pass/fail and
 * build the summary. Separated so tests don't need real probes.
 */
export function evaluateVerification(results) {
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
 */
export async function verifySubTaskOutput(verify, ctx, probes) {
    if (!verify || verify.length === 0)
        return evaluateVerification([]);
    const results = [];
    for (const v of verify) {
        switch (v.kind) {
            case "branch_pushed": {
                const branch = v.branch ?? ctx.defaultBranch;
                const r = await probes.remoteBranchExists(branch);
                results.push({ kind: v.kind, passed: r.exists, detail: r.detail });
                break;
            }
            case "pr_opened": {
                const r = await probes.prUrlPresent();
                results.push({ kind: v.kind, passed: r.present, detail: r.url ? `PR ${r.url}` : r.detail });
                break;
            }
            case "file_written": {
                const r = await probes.fileWrittenSince(v.path, ctx.subTaskStartMs);
                results.push({ kind: v.kind, passed: r.written, detail: r.detail });
                break;
            }
            case "commit_made": {
                const r = await probes.commitMadeSince(ctx.baseSha);
                results.push({ kind: v.kind, passed: r.made, detail: r.detail });
                break;
            }
        }
    }
    return evaluateVerification(results);
}
//# sourceMappingURL=verify.js.map