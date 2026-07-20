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
export declare function resolveContractPath(realFiles: string[], contract: string): {
    file: string;
    rule: string;
} | null;
//# sourceMappingURL=path-match.d.ts.map