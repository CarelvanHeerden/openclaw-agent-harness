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
import { anyPathMatches } from "./path-match.js";
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
 *
 * beta.9: handles 8 contract kinds. New kinds use new optional probes
 * (graceful fallback when absent). Backward compat: old kinds still work
 * exactly as in beta.8 when only beta.8 probes are provided.
 */
export async function verifySubTaskOutput(verify, ctx, probes) {
    if (!verify || verify.length === 0)
        return evaluateVerification([]);
    // beta.95: on a revise cycle (cycle > 1), a TARGETED file (reviseRelaxed NOT
    // set -- the review DID target it, so the worker was expected to re-touch it)
    // is legitimately older-than-this-sub-task (cycle 1 wrote it first) and its
    // cycle-1 commit sits OUTSIDE worker-session-start..HEAD. Verifying it against
    // the BRANCH fork-point window (plan_base_sha) + committed-in-branch presence
    // is the property that is actually true, and cures the mtime + strict-match
    // false-positives without weakening cycle-1 (fresh-write) verification.
    const reviseCycle = (ctx.cycle ?? 1) > 1 && ctx.reviseTargetedPlanbaseWindow !== false;
    const planBaseWindow = ctx.branchBaseSha ?? ctx.baseSha;
    const results = [];
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
                }
                else {
                    const r = await probes.prUrlPresent();
                    results.push({ kind: v.kind, passed: r.present, detail: r.url ? `PR ${r.url}` : r.detail });
                }
                break;
            }
            case "file_written": {
                // beta.85: REVISE-RELAXED. On a revise cycle, a contract file the review
                // did NOT target was already shipped correctly in a prior cycle; the
                // worker correctly left it untouched. Requiring a fresh mtime this
                // sub-task false-fails it (the 1c744d70/696226e4 class). Accept it when
                // it is present + committed anywhere in the branch range. A TARGETED
                // file keeps the strict fresh-write requirement below.
                if (v.reviseRelaxed && probes.fileCommittedInBranch) {
                    const r = await probes.fileCommittedInBranch(v.path, ctx.branchBaseSha ?? ctx.baseSha);
                    results.push({ kind: v.kind, passed: r.present, detail: `revise-relaxed (not targeted this cycle): ${r.detail}`, path: v.path });
                    break;
                }
                // beta.95: TARGETED file on a revise cycle. The strict fresh-write path
                // below (mtime >= subTaskStartMs) false-fails a file cycle-1 already
                // wrote (its mtime predates cycle-2's sub-task start). Verify instead
                // that it is present + committed in the BRANCH window (plan_base_sha..
                // HEAD) -- true for both cycle-1's original write and any cycle-2 edit.
                // Still fails a genuinely-missing/empty file (fileCommittedInBranch does
                // a disk-presence check). cycle 1 keeps the strict fresh-write path.
                if (reviseCycle && probes.fileCommittedInBranch) {
                    const r = await probes.fileCommittedInBranch(v.path, planBaseWindow);
                    results.push({ kind: v.kind, passed: r.present, detail: `revise-targeted (plan-base window): ${r.detail}`, path: v.path });
                    break;
                }
                // beta.9 FIX: use fs.stat (includes untracked files) when probe available.
                // Falls back to git-diff-based probe for backward compat with beta.8 test doubles.
                if (probes.fileExistsOnDisk) {
                    // beta.57 (P1): thread the sub-task start time so the probe can
                    // reject a stale pre-existing file (freshness enforced probe-side).
                    const r = await probes.fileExistsOnDisk(v.path, ctx.subTaskStartMs);
                    let passed = r.exists && r.nonEmpty;
                    let detail = r.detail;
                    // beta.105: THE `git mv` CONTRADICTION. mtime is a proxy for "this
                    // sub-task authored this path", and `git mv` breaks the proxy: it
                    // preserves the blob's mtime, so a worker that correctly MOVES a file
                    // to the path the contract asks for fails the freshness check while
                    // `file_committed` on the very same file, in the very same commit,
                    // passes. b103 smoke seq 3 died on exactly that split verdict.
                    //
                    // So when mtime says no, ask git directly: was this path ADDED or
                    // RENAMED-TO inside THIS sub-task's commit range? That is a stronger
                    // authorship signal than mtime, not a weaker one -- it is scoped to
                    // the sub-task's own commits, so a file that merely pre-existed the
                    // sub-task still fails. Presence + non-emptiness on disk are still
                    // required; this only replaces the freshness half.
                    if (!passed && r.exists && r.stale && ctx.acceptRenameAsWrite && probes.filePathIntroducedSince) {
                        const introduced = await probes.filePathIntroducedSince(v.path, ctx.baseSha);
                        if (introduced.introduced) {
                            passed = true;
                            detail = `path introduced by this sub-task (${introduced.changeType}); mtime predates it (git mv preserves mtime): ${introduced.detail}`;
                        }
                    }
                    results.push({ kind: v.kind, passed, detail, path: v.path });
                }
                else {
                    // Backward compat: beta.8 behaviour (git diff, excludes untracked)
                    const r = await probes.fileWrittenSince(v.path, ctx.subTaskStartMs);
                    results.push({ kind: v.kind, passed: r.written, detail: r.detail, path: v.path });
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
                // beta.85: REVISE-RELAXED (same rationale as file_written above): a
                // not-targeted revise file passes on present+committed-in-branch.
                if (v.reviseRelaxed && probes.fileCommittedInBranch) {
                    const r = await probes.fileCommittedInBranch(v.path, ctx.branchBaseSha ?? ctx.baseSha);
                    results.push({ kind: v.kind, passed: r.present, detail: `revise-relaxed (not targeted this cycle): ${r.detail}`, path: v.path });
                    break;
                }
                // beta.95: TARGETED file on a revise cycle. `fileCommittedSince(baseSha)`
                // uses the worker-session-start SHA, so cycle-1's commit of this file
                // sits OUTSIDE the range and the strict structural match sees only
                // cycle-2's diff (on 98cea58f that was the two `.commit-msg` scratch
                // files -> false-fail). Widen to the BRANCH window (plan_base_sha..HEAD)
                // via fileCommittedSince so the file's real commit is in-range AND the
                // beta.84 non-zero-diff gate still applies. The listCommittedFiles noise
                // filter (beta.95) also strips the `.commit-msg` scratch files.
                if (reviseCycle && probes.fileCommittedSince) {
                    const r = await probes.fileCommittedSince(v.path, planBaseWindow);
                    results.push({ kind: v.kind, passed: r.committed, detail: `revise-targeted (plan-base window): ${r.detail}`, path: v.path });
                    break;
                }
                if (probes.fileCommittedSince) {
                    const r = await probes.fileCommittedSince(v.path, ctx.baseSha);
                    // beta.84 (#1): carry the exact contract path on the result so a
                    // post-mortem no longer has to reconstruct the mapping from row
                    // order (Staging's QoL nit -- `path` was merged/empty before).
                    results.push({ kind: v.kind, passed: r.committed, detail: r.detail, path: v.path });
                }
                else {
                    // beta.57 (P1): FAIL CLOSED. A missing probe used to skip-pass,
                    // which meant a mis-wired caller silently green-lit every contract
                    // of this kind. Production wires all probes; a missing one is a bug.
                    results.push({ kind: v.kind, passed: false, detail: "fileCommittedSince probe not provided; failing closed (cannot verify)" });
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
                }
                else {
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
                }
                else {
                    // beta.57 (P1): fail closed on a missing probe.
                    results.push({ kind: v.kind, passed: false, detail: "remoteFileExists probe not provided; failing closed (cannot verify)" });
                }
                break;
            }
            case "pr_state": {
                if (probes.prForBranch) {
                    const r = await probes.prForBranch(ctx.defaultBranch);
                    if (r.count === 0) {
                        results.push({ kind: v.kind, passed: false, detail: `no PR found for branch; ${r.detail}` });
                    }
                    else {
                        const pr = r.prs[0];
                        // beta.57 (P1): "closed" is NOT "merged". GitHub reports state
                        // "closed" for BOTH merged and rejected PRs; the old mapping
                        // treated a closed-without-merge PR as merged. Use the explicit
                        // `merged` flag when the probe supplies it (GitHub: merged_at;
                        // GitLab: state === 'merged'); a probe without the flag maps
                        // closed to "closed" and a `merged` expectation fails honestly.
                        const effectiveState = pr.draft
                            ? "draft"
                            : pr.merged === true || pr.state === "merged"
                                ? "merged"
                                : pr.state;
                        const passed = effectiveState === v.state;
                        results.push({ kind: v.kind, passed, detail: `PR #${pr.number} state=${effectiveState} (expected ${v.state})` });
                    }
                }
                else {
                    // beta.57 (P1): fail closed on a missing probe.
                    results.push({ kind: v.kind, passed: false, detail: "prForBranch probe not provided; failing closed (cannot verify)" });
                }
                break;
            }
            case "file_in_pr": {
                if (probes.prFiles && v.prNumber !== undefined) {
                    const r = await probes.prFiles(v.prNumber);
                    // beta.51: structural match so a route-semantics contract path finds
                    // the real filesystem path in the PR file list (route group / prefix).
                    const present = anyPathMatches(r.files.map((f) => f.filename), v.path);
                    results.push({ kind: v.kind, passed: present, detail: present ? `${v.path} in PR #${v.prNumber} files` : `${v.path} not found in PR #${v.prNumber} files; ${r.detail}` });
                }
                else if (probes.prForBranch && probes.prFiles) {
                    // Look up prNumber from branch if not specified.
                    const pr = await probes.prForBranch(ctx.defaultBranch);
                    const prNum = pr.prs[0]?.number;
                    if (!prNum) {
                        results.push({ kind: v.kind, passed: false, detail: `no open PR found to check file in; ${pr.detail}` });
                    }
                    else {
                        const r = await probes.prFiles(prNum);
                        const present = anyPathMatches(r.files.map((f) => f.filename), v.path);
                        results.push({ kind: v.kind, passed: present, detail: present ? `${v.path} in PR #${prNum} files` : `${v.path} not found in PR #${prNum}; ${r.detail}` });
                    }
                }
                else {
                    // beta.57 (P1): fail closed on a missing probe.
                    results.push({ kind: v.kind, passed: false, detail: "prFiles probe not provided; failing closed (cannot verify)" });
                }
                break;
            }
            case "commit_sha_matches": {
                const branch = v.branch ?? ctx.defaultBranch;
                if (probes.localHeadSha && probes.remoteBranchSha) {
                    const [local, remote] = await Promise.all([probes.localHeadSha(), probes.remoteBranchSha(branch)]);
                    if (!remote.sha) {
                        results.push({ kind: v.kind, passed: false, detail: `remote branch ${branch} not found; ${remote.detail}` });
                    }
                    else {
                        const passed = local.sha === remote.sha;
                        results.push({ kind: v.kind, passed, detail: passed ? `SHA matches: ${local.sha.slice(0, 12)}` : `SHA mismatch: local=${local.sha.slice(0, 12)} remote=${remote.sha.slice(0, 12)}` });
                    }
                }
                else {
                    // beta.57 (P1): fail closed on missing probes.
                    results.push({ kind: v.kind, passed: false, detail: "localHeadSha/remoteBranchSha probes not provided; failing closed (cannot verify)" });
                }
                break;
            }
        }
    }
    return evaluateVerification(results);
}
//# sourceMappingURL=verify.js.map