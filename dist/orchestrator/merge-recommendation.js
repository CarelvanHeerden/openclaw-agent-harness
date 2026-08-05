/**
 * beta.34: post-ship merge recommendation.
 *
 * After the harness opens the PR (`loop.shipped`), it emits a human-facing
 * MERGE / DO-NOT-MERGE recommendation. This is NOT a second model review --
 * it is DERIVED from signals the harness already has: the adversary verdict,
 * the review findings, whether the loop reached a clean pass (vs. shipping at
 * max cycles), and (optionally) CI check status on the PR head.
 *
 * Design intent (Carel): a DO-NOT-MERGE recommendation should be structurally
 * RARE. If the adversarial reviewer looped (up to max_cycles) and signed off
 * with `pass`, the PR is clean by definition. A do-not-merge therefore means
 * one of:
 *   - the loop shipped WITHOUT a clean pass (e.g. ran out of cycles), or
 *   - a blocking-severity finding survived into the final review, or
 *   - CI is red on the PR head.
 * These feed the HARD GATE in harness_merge_pr: if the recommendation is
 * do_not_merge, the merge tool refuses (no override; use the GitHub UI).
 */
const BLOCKING_SEVERITIES = new Set(["block", "blocker", "critical", "high"]);
/**
 * beta.109: the severities that keep a review cycling.
 *
 * Deliberately WIDER than BLOCKING_SEVERITIES above, which omits `medium`. The
 * rest of the harness -- isBlockingFinding, the adversary's file-attribution
 * gate -- has always treated medium as actionable, and shipping a PR carrying
 * open mediums on the strength of a high-only test would be a loosening nobody
 * asked for. This set is used only to describe WHY a do-not-merge stands.
 */
const AT_LEAST_MEDIUM = new Set(["medium", "high", "critical", "block", "blocker"]);
function ciNote(ciStatus) {
    return ciStatus === "success"
        ? " CI is green."
        : ciStatus === "pending"
            ? " CI is still running (not yet green) -- the merge will proceed on your say-so, but you may prefer to wait."
            : ciStatus === "none"
                ? " No CI checks are configured on this repo."
                : "";
}
/**
 * Pure derivation. No I/O.
 */
export function deriveMergeRecommendation(input) {
    const { review, reachedCleanPass, ciStatus } = input;
    // 1. No review at all -> cannot recommend merge.
    if (!review) {
        return {
            recommendation: "do_not_merge",
            reason: "No adversary review was produced for this session, so the change is unverified. Not safe to auto-merge.",
        };
    }
    // 2. `block` is an explicit withhold and is never overridable.
    if (review.verdict === "block") {
        return {
            recommendation: "do_not_merge",
            reason: `The adversary's final verdict was "block". The review loop actively withheld sign-off on this change.`,
        };
    }
    // 2b. Verdict is not a clean pass.
    //
    // beta.109: but "not pass" is not the same as "not mergeable". Step 4 below
    // has always let a PASSING review ship carrying informational and low
    // findings -- it says so in the reason string it writes. This branch used to
    // return before severity was ever consulted, so the identical set of findings
    // produced opposite recommendations depending only on whether the adversary
    // wrote "pass" or "revise".
    //
    // ProjectThanos PR #932 is the case that made this visible. Three runs and
    // roughly $23 of revise spend later its final review carried ten low, six
    // informational and one low convention finding -- nothing at medium or above
    // -- and the harness still said do_not_merge. Another cycle could not have
    // changed that, because a cycle only ever closes findings, and the verdict
    // stays "revise" for as long as ANY finding remains. This module's own header
    // says a do-not-merge should be "structurally RARE"; it had fired on three
    // runs out of three.
    //
    // `blockingFindings` is counted by the caller with isBlockingFinding (diff-
    // addressable AND medium or above), the same predicate the loop already uses
    // to decide whether a convention finding is worth another cycle. Left
    // undefined -- older callers, unit tests -- the pre-b109 behaviour stands.
    if (review.verdict !== "pass") {
        const blockingCount = input.blockingFindings;
        if (blockingCount === 0) {
            if (ciStatus === "failure") {
                return {
                    recommendation: "do_not_merge",
                    reason: "CI checks are failing on the PR head commit. Not safe to merge until CI is green.",
                };
            }
            const residual = review.findings.length;
            return {
                recommendation: "merge",
                reason: `The adversary's final verdict was "${review.verdict}", but nothing blocking remains: ` +
                    `${residual === 0 ? "no findings" : `${residual} finding(s)`}, none at medium severity or above. ` +
                    `Another review cycle could only close low-severity items, and the verdict stays "${review.verdict}" ` +
                    `while any finding at all is open.${ciNote(ciStatus)} Recommended to merge; ` +
                    "run `harness_revise` first if you want the remaining nits closed.",
            };
        }
        const worst = review.findings
            .filter((f) => AT_LEAST_MEDIUM.has((f.severity || "").toLowerCase()))
            .map((f) => f.title || f.dimension || "(untitled)")
            .slice(0, 3)
            .join("; ");
        return {
            recommendation: "do_not_merge",
            reason: `The adversary's final verdict was "${review.verdict}", not "pass". The review loop did not sign off on this change.` +
                (blockingCount === undefined
                    ? ""
                    : ` ${blockingCount} finding(s) at medium severity or above are still open${worst ? `: ${worst}` : ""}.`),
        };
    }
    // 3. Verdict is pass but the loop shipped without actually reaching a clean
    //    pass (e.g. hit max cycles). Treat the "pass" as unreliable.
    if (!reachedCleanPass) {
        return {
            recommendation: "do_not_merge",
            reason: "The review loop shipped at its cycle/budget limit without a clean adversary sign-off. The pass is not trustworthy.",
        };
    }
    // 4. A blocking-severity finding survived into the final (passing) review.
    const blocking = review.findings.filter((f) => BLOCKING_SEVERITIES.has((f.severity || "").toLowerCase()));
    if (blocking.length > 0) {
        const titles = blocking.map((f) => f.title || f.dimension || "(untitled)").slice(0, 3).join("; ");
        return {
            recommendation: "do_not_merge",
            reason: `The final review passed but carries ${blocking.length} blocking-severity finding(s): ${titles}. Resolve before merge.`,
        };
    }
    // 5. CI is explicitly failing on the PR head.
    if (ciStatus === "failure") {
        return {
            recommendation: "do_not_merge",
            reason: "CI checks are failing on the PR head commit. Not safe to merge until CI is green.",
        };
    }
    // 6. Clean pass, no blockers, CI not failing -> MERGE.
    const infoCount = review.findings.length;
    return {
        recommendation: "merge",
        reason: `The adversary looped to a clean pass with no blocking findings` +
            (infoCount ? ` (${infoCount} informational/low finding(s), none blocking)` : "") +
            `.${ciNote(ciStatus)} Recommended to merge.`,
    };
}
//# sourceMappingURL=merge-recommendation.js.map