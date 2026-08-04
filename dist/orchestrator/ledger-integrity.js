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
/**
 * Pure: combine ledger sources, de-duplicated by sha, earlier sources winning
 * (they carry richer metadata like the sub-task title).
 *
 * beta.102: the guard MUST NOT read `sub_tasks` alone. Sub-task rows are keyed
 * `<session>-c<cycle>-s<seq>` and written with INSERT OR REPLACE, and a
 * clarification resume re-plans from cycle 1 -- so the new plan's seq 1 CLOBBERS
 * the original seq 1, silently erasing its `commit_sha`. A guard that only read
 * that table would go progressively blind exactly on the runs it exists to
 * protect. The `loop.worker_end_turn` audit event carries the same sha into an
 * append-only log, so unioning the two makes the ledger un-eraseable.
 */
export function mergeLedgerCommits(...sources) {
    const seen = new Set();
    const out = [];
    for (const src of sources) {
        for (const e of src) {
            const sha = typeof e?.commitSha === "string" ? e.commitSha.trim().toLowerCase() : "";
            if (!sha || seen.has(sha))
                continue;
            seen.add(sha);
            out.push({ ...e, commitSha: e.commitSha.trim() });
        }
    }
    return out;
}
/**
 * Pure: pair the ledger against the set of shas a reachability probe reported
 * as unreachable. Comparison is prefix-tolerant in both directions because the
 * ledger stores full shas while git output and audit payloads are frequently
 * abbreviated.
 */
export function buildLedgerIntegrityReport(ledger, unreachableShas) {
    const bad = unreachableShas.map((s) => (typeof s === "string" ? s.trim().toLowerCase() : "")).filter(Boolean);
    const checkable = ledger.filter((e) => typeof e.commitSha === "string" && e.commitSha.trim().length > 0);
    const unreachable = checkable.filter((e) => {
        const sha = e.commitSha.trim().toLowerCase();
        return bad.some((b) => sha.startsWith(b) || b.startsWith(sha));
    });
    return { checked: checkable.length, unreachable, ok: unreachable.length === 0 };
}
/**
 * Operator-facing explanation. Names the specific sub-tasks whose work is gone
 * so the failure is actionable without a log dive -- b100's equivalent finding
 * took a bespoke audit sub-task plus a manual `git cat-file` to establish.
 */
export function describeLedgerIntegrityFailure(report, headSha) {
    const lost = report.unreachable
        .map((e) => `seq ${e.seq} (${e.commitSha.slice(0, 7)}${e.title ? `: ${e.title}` : ""})`)
        .join(", ");
    return (`branch integrity check FAILED: ${report.unreachable.length} of ${report.checked} recorded sub-task commit(s) ` +
        `are not reachable from HEAD${headSha ? ` (${headSha.slice(0, 7)})` : ""}. Missing: ${lost}. ` +
        `The branch does not contain work this run already committed, so review and PR would both be operating on an ` +
        `incomplete diff. The commits themselves are intact as git objects (see the harness-rescue refs in the bare repo) ` +
        `and can be recovered with 'git branch <name> <sha>'.`);
}
//# sourceMappingURL=ledger-integrity.js.map