/**
 * rc.3: a finding has an identity, and it keeps it across chunks and cycles.
 *
 * Before this, a finding was a bare object in an array. Two consequences, both
 * visible on StitchGuard PR #1168:
 *
 * The chunked adversary path (`runAdversarySdk`, for a diff too large to review
 * in one call) does `findings.push(...)` per chunk with no dedup at all. Each
 * chunk is shown the prior chunks' findings and asked not to repeat them, which
 * is a request, not a mechanism -- so the same schema/migration complaint, the
 * same request-race, the same validation gap and the same credential-scope
 * concern each arrived two or three times, and each copy was counted as a
 * separate blocker and routed to a separate worker.
 *
 * And every cycle re-derived its finding set from nothing. A defect fixed in
 * cycle 2 could be re-raised in cycle 3 by a differently-worded finding, while
 * the run had no record that it had ever been closed. Later cycles kept
 * discovering new medium concerns in feature code nobody had touched since
 * cycle 1, so the loop chased a target that grew as fast as it was hit.
 *
 * Identity here is deliberately two-tier. An exact fingerprint over the
 * normalised (source, dimension, file, relatedFiles, title, detail) catches the
 * literal repeats. Equivalence -- same dimension, same primary file, strong
 * distinctive-token overlap in the title -- catches the rewordings, which is
 * most of what a chunked review produces. Both require the FILE to agree, which
 * is the property `isRecycledFinding` lacks and must not pass on: a matcher
 * that ignores the file will happily call two different defects the same one.
 */
import type { ReviewFinding } from "./adversary.js";
/**
 * Where a finding is in its life.
 *
 *  - `open`               live defect, drives repair cycles and blocks merge
 *  - `late_discovery`     open, but first raised after cycle 1 against code
 *                         this run had not changed; admitted under the policy
 *                         below and carrying the reason it qualified
 *  - `resolved`           seen in an earlier cycle, absent now, and the file
 *                         has not changed since -- it stays closed
 *  - `stale`              raised again but not admissible: a re-raise of a
 *                         resolved finding with no regression behind it, or a
 *                         late discovery that did not meet the bar. Still shown
 *                         on the PR; no longer drives cycles
 *  - `accepted`           a human decided to ship with it
 *  - `dispositioned`      answered some other way (skipped sub-task, scope call)
 *  - `environment_blocked` nothing a worker can edit will fix it
 */
export type FindingLifecycleState = "open" | "resolved" | "stale" | "accepted" | "dispositioned" | "environment_blocked" | "late_discovery";
/** States in which a finding still argues for another repair cycle. */
export declare const CYCLE_DRIVING_STATES: ReadonlySet<FindingLifecycleState>;
export interface FindingRecord {
    fingerprint: string;
    state: FindingLifecycleState;
    severity: string;
    dimension: string;
    source?: string | null;
    file?: string | null;
    relatedFiles: string[];
    title: string;
    detail: string;
    firstSeenCycle: number;
    lastSeenCycle: number;
    resolvedCycle?: number | null;
    lateDiscoveryReason?: string | null;
}
/**
 * Text reduced to what two people describing the same defect would agree on.
 *
 * Digits go because a finding that names a line number is the same finding when
 * the line moves; back-ticks and quotes go because a model fences identifiers
 * inconsistently between calls.
 */
export declare function normaliseFindingText(s: string | null | undefined): string;
/** A repo-relative path reduced to a comparable form. */
export declare function normaliseFindingPath(p: string | null | undefined): string;
/** Distinctive words in a title, used for the equivalence tier. */
export declare function titleTokens(title: string): Set<string>;
/**
 * A short stable hash of everything that makes this finding this finding.
 *
 * Deliberately not a cryptographic identity -- it is a dictionary key, and a
 * collision costs one merged finding, not a security property. FNV-1a keeps it
 * dependency-free and stable across processes, which `Math.random`-seeded or
 * insertion-ordered alternatives are not.
 */
export declare function findingFingerprint(f: ReviewFinding): string;
/**
 * Two findings that a reviewer would call the same complaint.
 *
 * Same dimension, same primary file, and enough shared distinctive title
 * tokens. The file agreement is not negotiable: "missing tenant scope" in the
 * credentials route and "missing tenant scope" in the connections route are two
 * defects and two repairs.
 */
export declare function findingsAreEquivalent(a: ReviewFinding, b: ReviewFinding): boolean;
export interface DuplicateRecord {
    fingerprint: string;
    duplicateOfFingerprint: string;
    title: string;
    file: string | null;
    dimension: string;
    reason: "identical" | "equivalent";
}
/**
 * Collapse equivalent findings into one, keeping the most severe reading.
 *
 * Order is preserved: the surviving finding sits where the first of its group
 * sat, so a report does not reshuffle itself because a later chunk repeated
 * something. `relatedFiles` are unioned -- a duplicate that named one more file
 * the fix needs is the reason to merge rather than discard.
 */
export declare function dedupeFindings(findings: ReviewFinding[]): {
    kept: ReviewFinding[];
    duplicates: DuplicateRecord[];
};
/**
 * Whether a finding first raised after cycle 1, against code this run has not
 * changed, is admissible -- and if so, why.
 *
 * Cycle 1 is the full baseline review. After it, later cycles are for verifying
 * the previous cycle's fixes and reviewing what changed. A new medium concern
 * about untouched feature code is how a repair loop turns into whack-a-mole:
 * on #1168 each cycle found a few more, and the count of things to fix never
 * fell. High, critical and security findings are always admitted, because
 * "we did not notice it in cycle 1" is not a reason to ship a vulnerability.
 */
export declare function lateDiscoveryReason(f: ReviewFinding, exposedByPreviousFix: boolean): string | null;
export interface ReconcileInput {
    cycle: number;
    /** The deduped findings this cycle produced. */
    current: ReviewFinding[];
    /** Everything already known about this session, keyed by fingerprint. */
    prior: FindingRecord[];
    /** Repo-relative files this cycle's workers actually committed. */
    changedThisCycle: string[];
}
export interface ReconcileResult {
    /** The findings as the run should now see them, each carrying its state. */
    findings: ReviewFinding[];
    /** Rows to write back, including prior findings that just closed. */
    records: FindingRecord[];
    /** State transitions worth an audit line. */
    transitions: Array<{
        fingerprint: string;
        title: string;
        file: string | null;
        from: FindingLifecycleState | "new";
        to: FindingLifecycleState;
        reason: string;
    }>;
    /** Late discoveries, admitted or not. */
    lateDiscoveries: Array<{
        fingerprint: string;
        title: string;
        file: string | null;
        severity: string;
        admitted: boolean;
        reason: string;
    }>;
}
/**
 * Fold this cycle's findings into what the session already knows.
 *
 * The two rules that matter: a finding the adversary stopped raising is
 * resolved, and a resolved finding is only reopened when the file it names has
 * actually changed since. Without the second, one re-worded re-raise undoes a
 * fix that is still in the tree, and the run is back where cycle 2 started.
 */
export declare function reconcileFindings(input: ReconcileInput): ReconcileResult;
/** A stored row read back as a finding, so the equivalence test can take it. */
export declare function recordAsFinding(r: FindingRecord): ReviewFinding;
//# sourceMappingURL=finding-lifecycle.d.ts.map