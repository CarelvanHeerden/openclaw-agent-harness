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
/**
 * beta.62: added `needs_human_review` -- set ONLY by the graceful-degradation
 * path in the loop when a cycle-N adversary review crashed but the underlying
 * work is complete + self-verified green (so the PR is opened for inspection
 * rather than discarded). It is distinct from `do_not_merge` (which means the
 * adversary produced a verdict that withheld sign-off): `needs_human_review`
 * means the adversary NEVER FINISHED, so there is no machine sign-off at all.
 * The harness_merge_pr HARD GATE treats it exactly like do_not_merge (refuse;
 * human merges via the GitHub UI) -- it is never auto-overridable.
 */
import { isAtLeastMedium } from "./finding-classify.js";
const BLOCKING_SEVERITIES = new Set(["block", "blocker", "critical", "high"]);
/**
 * beta.109: the severities that keep a review cycling.
 *
 * Deliberately WIDER than BLOCKING_SEVERITIES above, which omits `medium`. The
 * rest of the harness -- isBlockingFinding, the adversary's file-attribution
 * gate -- has always treated medium as actionable, and shipping a PR carrying
 * open mediums on the strength of a high-only test would be a loosening nobody
 * asked for.
 *
 * rc.3: that set is now `isAtLeastMedium` from finding-classify, so the ship
 * gate, this recommendation and `harness_merge_pr` cannot disagree about what
 * "blocking" means. The local copy also had no notion of an unreadable severity
 * and counted one as non-blocking.
 */
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
            .filter((f) => isAtLeastMedium(f.severity))
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
    // 4. A blocking finding survived into the final (passing) review.
    //
    // beta.112: this used to consult BLOCKING_SEVERITIES, which omits `medium`,
    // while the caller counted blocking findings with isBlockingFinding, which
    // does not. The same run therefore produced both of these, minutes apart:
    //
    //   loop.blocking_findings  cycle=2 verdict=pass findings=5 blockingFindings=1
    //   reason: "...clean pass with no blocking findings (5 informational/low
    //            finding(s), none blocking)"
    //
    // ProjectThanos PR #952. The finding being denied was a medium codebase-fit
    // one the adversary raised in cycle 1, the worker did not fix, and the
    // adversary re-raised in cycle 2 marked "recycled, still unfixed" -- a repo
    // convention requiring UI changes to update help content. It shipped with a
    // recommendation stating it did not exist.
    //
    // beta.109 already made this argument for the revise path: shipping a PR
    // carrying open mediums "would be a loosening nobody asked for". It never
    // applied it here, because a `revise` verdict returns earlier and #932 -- the
    // only PR being exercised at the time -- never produced a pass.
    //
    // One definition, no fallback. Keeping the old severity set alive for callers
    // that omit `blockingFindings` would leave exactly this bug in place for the
    // next caller to rediscover, and there is only one production caller.
    const blocking = review.findings.filter((f) => isAtLeastMedium(f.severity));
    const blockingCount = input.blockingFindings ?? blocking.length;
    if (blockingCount > 0 || blocking.length > 0) {
        const titles = blocking.map((f) => f.title || f.dimension || "(untitled)").slice(0, 3).join("; ");
        const n = Math.max(blockingCount, blocking.length);
        return {
            recommendation: "do_not_merge",
            reason: `The final review passed but carries ${n} blocking finding(s) at medium severity or above` +
                `${titles ? `: ${titles}` : ""}. A pass verdict does not clear these -- the adversary signed off on the ` +
                `change while these remained open. Resolve them, or run \`harness_revise\` to have the loop close them.`,
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