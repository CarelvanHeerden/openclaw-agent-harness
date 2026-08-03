/**
 * beta.50: verifier path matching for the `file_committed` (and, by reuse,
 * `file_written` / `file_pushed`) contract kinds.
 *
 * ROOT CAUSE (beta.49 #858 revise, session 20928481): the lead authors a
 * sub-task's contract path from ROUTE/URL semantics
 * (`src/app/governance-risk/taxonomy/page.tsx`) BEFORE the observe probe runs,
 * but the worker commits the real FILESYSTEM path
 * (`src/app/(portal)/governance-risk/taxonomy/page.tsx` -- `(portal)` is a
 * Next.js route group: parenthesised segments are routing-invisible but
 * filesystem-real). The old verifier did an exact string / resolve() equality
 * match, so the correct commit failed `file_committed` and the whole revise
 * died at sub-task 2 -- even though `commit_made` passed and C1 captured the
 * real commit SHA + filesTouched.
 *
 * This is one instance of a general class: lead-authored contract paths drift
 * from worker-written filesystem paths (route groups, monorepo `packages/*`
 * prefixes, `src/` insertion/omission, `pages/` vs `app/`). Rather than a
 * Next.js-specific `(name)` strip, we match by structural equivalence:
 *
 *   1. exact match (fast path, unchanged behaviour)
 *   2. route-group-normalised match: strip parenthesised path segments on both
 *      sides, then compare
 *   3. suffix match: the committed path ENDS WITH the contract path (handles a
 *      contract that omits a leading `packages/foo/` / `apps/web/` prefix)
 *   4. basename + trailing-dir match: same filename AND the contract's parent
 *      directory chain is a suffix of the committed one (handles inserted
 *      segments anywhere, e.g. the `(portal)` group, while still requiring the
 *      meaningful dir context so we don't match an unrelated `page.tsx`).
 *
 * A false NEGATIVE (fail a correct worker) is the fatal case we are fixing; a
 * false POSITIVE (accept a wrong file) is guarded against by requiring the
 * contract's directory context (rule 4 keeps >=1 parent dir when present), and
 * `commit_made` still independently proves a real commit happened. When the
 * contract path is a bare filename with no directory, rules 3/4 still require
 * the basename to match a committed file, which is the best that path alone
 * can assert.
 *
 * Pure + exported so it is unit-testable independently of git.
 */
/** Strip parenthesised (route-group) segments like `(portal)` from a path. */
export declare function stripRouteGroups(p: string): string;
/**
 * beta.98: strip a MIGRATION-TIMESTAMP / migration-hash prefix from each path
 * segment. Migration tooling stamps a dynamic, execution-time prefix onto the
 * migration DIRECTORY (Prisma / Rails / Django / Alembic), which the lead
 * cannot predict at planning time (the timestamp is generated minutes later
 * when the worker runs `migrate dev`). This defeated ALL FOUR structural rules
 * for the b96/b97 smoke: contract `prisma/migrations/continuity_resilience/migration.sql`
 * vs committed `prisma/migrations/20260803073723_continuity_resilience/migration.sql`
 * -> the `20260803073723_` prefix broke exact/route-group/suffix/basename-dir,
 * and `strictContract:true` (b84) disables the fuzzy fallbacks, so a correctly
 * generated + committed migration false-failed `file_committed`.
 *
 * Same CLASS as the b50 route-group / b76 drift bugs; new TRIGGER = dynamic
 * `<stamp>_` dir-segment prefixes. Supported prefix forms (all followed by
 * `_<name>`):
 *   - Prisma / Rails / Django-timestamp:  14-digit `YYYYMMDDHHmmss_`
 *   - Django sequential:                  `NNNN_` (1+ digits)
 *   - Alembic:                            12-hex-char revision id `abc123def456_`
 *
 * Deliberately conservative: only strips a prefix that is PURELY the stamp
 * followed by `_` and a non-empty remainder, so a legitimately-named segment
 * like `2024_report` (name that merely starts with digits) still keeps its
 * meaning where the remainder must still match. Because the rule requires the
 * REST of the path to match exactly after stripping on both sides, it cannot
 * introduce a fuzzy false-positive (unlike the `*-unique` fallbacks): a wrong
 * sibling with a different name-after-prefix still fails.
 */
export declare function stripMigrationTimestamp(p: string): string;
/** Normalise separators + strip a leading `./` and any leading/trailing `/`. */
export declare function normalisePath(p: string): string;
/**
 * Does `committed` (a real file path from `git log --name-only`) satisfy the
 * `contract` path a sub-task was authored with? Order matters: cheapest +
 * strictest first, most tolerant last. Returns the rule that matched (for
 * audit/debug) or null.
 */
export declare function pathMatchRule(committed: string, contract: string): string | null;
/** Boolean convenience wrapper. */
export declare function pathMatches(committed: string, contract: string): boolean;
/** True if ANY committed file satisfies the contract path. */
export declare function anyPathMatches(committedFiles: string[], contract: string): boolean;
/**
 * beta.76 (Defect A): is `p` a TEST/SPEC file, by any common convention?
 *   - `*.test.ts` / `*.spec.tsx` / `*.test.js` ...       (JS/TS Jest/Vitest)
 *   - `*_test.go` / `*_test.py`                          (Go / pytest)
 *   - `test_*.py`                                        (pytest)
 *   - a path segment named `__tests__`, `tests`, `test`, or `spec`
 *     (Jest `__tests__/`, Vitest/Node `test/`, RSpec `spec/`)
 *
 * Deliberately broad + repo-agnostic: the whole point of beta.76 is that a
 * test file's exact NAME and DIRECTORY are repo-convention details the lead
 * cannot reliably predict pre-probe (`tests/api/x.test.ts` guessed vs
 * `src/__tests__/api/x-feature.test.ts` real). What we CAN assert is "the
 * worker committed a test file, and there is exactly one in this sub-task's
 * scoped diff, so it is the test the sub-task asked for."
 */
export declare function isTestFilePath(p: string): boolean;
/**
 * beta.84 (#1): a STRUCTURAL match is one of the un-fuzzy rules that require
 * real directory context (`exact`, `route-group`, `timestamp-prefix` [b98],
 * `suffix`, `basename-dir`). The two `*-unique` fallbacks (`basename-unique`,
 * `test-file-unique`) are the FUZZY ones -- they match on filename/type alone
 * and are the source of the cyc2-seq7 false-positive (a lone same-basename
 * SIBLING satisfied the wrong contract entry). A caller that must not accept a
 * fuzzy match passes `strictContract: true`.
 */
export declare function isStructuralRule(rule: string | null): boolean;
export declare function resolveContractPath(realFiles: string[], contract: string, opts?: {
    allowBasenameFallback?: boolean;
    allowTestFileFallback?: boolean;
    strictContract?: boolean;
}): {
    file: string;
    rule: string;
} | null;
//# sourceMappingURL=path-match.d.ts.map