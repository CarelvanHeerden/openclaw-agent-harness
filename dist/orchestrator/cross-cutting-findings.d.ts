/**
 * beta.119: A FINDING WHOSE FIX NO SINGLE SUB-TASK CAN MAKE.
 *
 * The b118 OpenClaw smoke (session 4c6b04e9, ProjectThanos PR #986) raised the
 * same finding in all three cycles and never fixed it:
 *
 *   "Upload route discards the `kind` and `title` form fields the drawer sends"
 *   file: src/app/api/grc/continuity-exercises/[id]/files/route.ts
 *
 * Routing worked perfectly. The file belongs to sub-task 5 (the file routes),
 * the finding was targeted there, and sub-task 5 ran in both revise cycles. It
 * reported `no-change` both times -- and it was RIGHT to. The adversary's own
 * remedy was "either drop the kind/title UI from the drawer, or add kind/title
 * columns to ContinuityExerciseFile and persist them". The drawer belongs to
 * sub-task 8. The Prisma model belongs to sub-task 1 and its migration to
 * sub-task 2. Sub-task 5 owns the one file that CANNOT be changed alone: there
 * is no column to persist into and no way to remove a dropdown it does not own.
 *
 * So the worker declined, the loop read that as "already correct", the
 * adversary re-raised it, and three cycles bought nothing. This is a different
 * failure from b107/b116/b118 -- those were all MISROUTING, where the finding
 * reached the wrong owner or none. Here it reached exactly the right owner and
 * the owner was structurally incapable of acting alone.
 *
 * Two mechanisms close it:
 *
 *   1. CO-FIX FILES. The adversary now declares `relatedFiles` -- the other
 *      paths that must change for the fix to be complete. Routing targets the
 *      owners of `file` AND of every co-fix path, so the whole set of workers
 *      needed for the change is asked in the same cycle. `relatedFiles` is
 *      advisory from a model, so prose extraction backstops it: any repo path
 *      the finding's own text names is treated as a co-fix candidate.
 *
 *   2. STUCK DETECTION. A finding that survives a cycle in which its owner was
 *      asked to fix it is stuck. Stuck findings widen aggressively on the next
 *      cycle, and one that cannot be widened at all is surfaced on the PR
 *      rather than silently re-raised until the cycle ceiling.
 *
 * Pure and deterministic: no fs, no git, no SDK.
 */
/** The finding shape this module reads (structural, avoids a hard type import). */
export interface CcFinding {
    dimension?: string;
    severity?: string;
    title?: string;
    detail?: string;
    file?: string | null;
    /** beta.119: other paths that must ALSO change for the fix to be complete. */
    relatedFiles?: string[] | null;
}
/** Pull every plausible repo-relative path out of a finding's prose. */
export declare function extractRepoPaths(text: string | undefined | null): string[];
/**
 * Every path that must change for this finding to be resolved, EXCLUDING the
 * finding's own `file`. Declared `relatedFiles` first (the model was asked
 * directly), then anything its prose names.
 */
export declare function coFixFiles(f: CcFinding): string[];
/**
 * A stable identity string for a finding, used for audit records and for
 * set membership WITHIN one cycle. Note this is deliberately NOT the
 * cross-cycle matcher -- see `isSameFinding`, which the adversary's rewording
 * defeats any exact-string key.
 */
export declare function findingKey(f: CcFinding): string;
/**
 * Are these the same defect raised in two different cycles? Same dimension and
 * same file is necessary but nowhere near sufficient -- b118's upload route
 * carried three unrelated findings at once -- so the titles must also overlap
 * substantially.
 */
export declare function isSameFinding(a: CcFinding, b: CcFinding): boolean;
/** A finding the previous cycle also raised. */
export interface StuckFinding {
    finding: CcFinding;
    key: string;
    /** How many consecutive cycles it has now been raised in (>= 2). */
    occurrences: number;
}
/**
 * Findings in `current` that were also present in the previous cycle(s).
 *
 * `history` is the per-cycle findings list in cycle order, EXCLUDING `current`.
 * A finding is stuck once it appears in `current` and in the immediately
 * preceding cycle: the loop already ran a revise cycle against it and it
 * survived.
 */
export declare function detectStuckFindings(history: CcFinding[][], current: CcFinding[]): StuckFinding[];
/** A finding that has been raised repeatedly and that nobody could act on. */
export interface UnresolvableFinding {
    key: string;
    title: string;
    file: string;
    severity: string;
    occurrences: number;
    /** Paths the fix also needs, if the finding named any. */
    coFixFiles: string[];
}
/**
 * Render the operator-facing note for findings that survived every cycle. This
 * goes on the PR so a repeated-and-never-fixed finding is stated plainly rather
 * than being buried in a finding list that looks the same as cycle 1's.
 */
export declare function describeUnresolvable(items: UnresolvableFinding[]): string;
//# sourceMappingURL=cross-cutting-findings.d.ts.map