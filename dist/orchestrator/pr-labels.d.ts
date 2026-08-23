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
export interface LabelableReview {
    verdict: string;
    findings?: unknown[];
    /** True when this `pass` was produced by the gate from the model's `revise`. */
    verdictDowngraded?: boolean;
}
export declare const LABEL_DO_NOT_MERGE = "do-not-merge";
export declare const LABEL_DOWNGRADED_PASS = "harness:downgraded-pass";
export declare const LABEL_UNREVIEWED = "harness:unreviewed";
export declare function prLabelsFor(review: LabelableReview): string[];
//# sourceMappingURL=pr-labels.d.ts.map