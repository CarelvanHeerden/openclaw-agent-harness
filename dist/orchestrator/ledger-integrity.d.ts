/**
 * beta.101: LEDGER-COMMIT REACHABILITY.
 *
 * Every sub-task that commits records its sha in `sub_tasks.commit_sha`. That
 * ledger is the harness's own record of the work it produced. If HEAD cannot
 * reach one of those shas, the work is NOT on the branch any more -- and every
 * downstream stage (adversary review, PR push) is then operating on a diff that
 * silently omits it.
 *
 * This is not hypothetical. In the b100 smoke (session 3c6c1608) six recorded
 * commits (`ce05f55f..88ce5f44`) were orphaned by a branch reset during a
 * clarification resume. Nothing noticed: the adversary was handed a diff
 * containing one unrelated docs commit, computed `suspicious: false` (its only
 * heuristic was "too MANY commits"), and spent a review turn producing findings
 * about missing work that had in fact been written correctly. The run had all
 * the evidence needed to detect this -- six populated commit_shas, none
 * reachable from head_sha -- and never cross-checked them.
 *
 * b101 fixes the reset itself (GitContext.preserveLocalBranch). This module is
 * the independent detector, so the NEXT way a commit goes missing is caught by
 * the harness rather than inferred by a confused reviewer.
 */
export interface LedgerCommit {
    seq: number;
    commitSha: string;
    title?: string;
}
export interface LedgerIntegrityReport {
    /** Ledger entries that carried a sha and were therefore checkable. */
    checked: number;
    /** Recorded commits HEAD cannot reach, in ledger order. */
    unreachable: LedgerCommit[];
    ok: boolean;
}
/**
 * Pure: pair the ledger against the set of shas a reachability probe reported
 * as unreachable. Comparison is prefix-tolerant in both directions because the
 * ledger stores full shas while git output and audit payloads are frequently
 * abbreviated.
 */
export declare function buildLedgerIntegrityReport(ledger: LedgerCommit[], unreachableShas: string[]): LedgerIntegrityReport;
/**
 * Operator-facing explanation. Names the specific sub-tasks whose work is gone
 * so the failure is actionable without a log dive -- b100's equivalent finding
 * took a bespoke audit sub-task plus a manual `git cat-file` to establish.
 */
export declare function describeLedgerIntegrityFailure(report: LedgerIntegrityReport, headSha?: string): string;
//# sourceMappingURL=ledger-integrity.d.ts.map