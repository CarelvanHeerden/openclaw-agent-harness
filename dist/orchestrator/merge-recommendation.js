import { isAtLeastMedium } from "./finding-classify.js";
/** A recommendation is mergeable only after a clean final pass and green CI. */
export function deriveMergeRecommendation(input) {
    const { review, reachedCleanPass, ciStatus } = input;
    if (!review)
        return { recommendation: "do_not_merge", reason: "No completed adversary review exists for the published head." };
    const passed = review.verdict === "pass";
    if (!passed)
        return { recommendation: "do_not_merge", reason: `The final adversary verdict was "${review.verdict}", not a pass.` };
    if (!reachedCleanPass)
        return { recommendation: "do_not_merge", reason: "The review did not finish with a clean final pass." };
    const severityBlocking = review.findings.filter((finding) => isAtLeastMedium(finding.severity));
    const blockingCount = input.mergeBlockingFindings ?? input.blockingFindings ?? severityBlocking.length;
    if (blockingCount !== 0) {
        const titles = (input.mergeBlockingTitles ?? severityBlocking.map((finding) => finding.title || finding.dimension || "(untitled)"))
            .slice(0, 3)
            .join("; ");
        return {
            recommendation: "do_not_merge",
            reason: `The final review retains ${blockingCount} blocking finding(s)${titles ? `: ${titles}` : ""}.`,
        };
    }
    if (ciStatus !== "success") {
        const state = ciStatus ?? "indeterminate";
        return { recommendation: "do_not_merge", reason: `Required CI on the exact published head is ${state}, not green.` };
    }
    return {
        recommendation: "merge",
        reason: "Final adversary pass, zero blockers, and required CI is green on the published head.",
    };
}
//# sourceMappingURL=merge-recommendation.js.map