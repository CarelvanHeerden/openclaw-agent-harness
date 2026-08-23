/**
 * rc.3: the labels that say how far the harness is vouching for a PR.
 *
 * Until now the only marks on a PR the harness did not want merged were a
 * paragraph in the PR body and a column in the harness's own database. Both are
 * things a reviewer has to go and read, and the external review (§2) was right
 * that a stamp nobody is obliged to look at is a weak control. A label appears
 * in the PR list and in search, and a repo can require its absence in branch
 * protection -- so a team that wants the warning enforced rather than
 * advertised now has something to enforce against.
 *
 * Kept in its own module, free of the OpenClaw runtime imports that `index.ts`
 * pulls in, so it is directly testable.
 */
export const LABEL_DO_NOT_MERGE = "do-not-merge";
export const LABEL_DOWNGRADED_PASS = "harness:downgraded-pass";
export const LABEL_UNREVIEWED = "harness:unreviewed";
export function prLabelsFor(review) {
    const labels = [];
    if (review.verdict !== "pass")
        labels.push(LABEL_DO_NOT_MERGE);
    if (review.verdictDowngraded)
        labels.push(LABEL_DOWNGRADED_PASS);
    // A `revise` carrying no findings at all is the placeholder report the
    // salvage paths attach when a session ended without a verdict. "Nobody
    // reviewed this" and "the reviewer asked for changes" look identical on a PR
    // otherwise, and they are not the same thing to the person merging it.
    if (review.verdict === "revise" && (review.findings ?? []).length === 0) {
        labels.push(LABEL_UNREVIEWED);
    }
    return labels;
}
//# sourceMappingURL=pr-labels.js.map