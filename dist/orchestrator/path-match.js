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
export function stripRouteGroups(p) {
    return normalisePath(p)
        .split("/")
        .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
        .join("/");
}
/** Normalise separators + strip a leading `./` and any leading/trailing `/`. */
export function normalisePath(p) {
    return p
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\/+/g, "/");
}
/** basename of a normalised path. */
function baseName(p) {
    const n = normalisePath(p);
    const i = n.lastIndexOf("/");
    return i === -1 ? n : n.slice(i + 1);
}
/**
 * Does `committed` (a real file path from `git log --name-only`) satisfy the
 * `contract` path a sub-task was authored with? Order matters: cheapest +
 * strictest first, most tolerant last. Returns the rule that matched (for
 * audit/debug) or null.
 */
export function pathMatchRule(committed, contract) {
    const c = normalisePath(committed);
    const t = normalisePath(contract);
    if (!c || !t)
        return null;
    // 1. exact
    if (c === t)
        return "exact";
    // 2. route-group-normalised (strip `(name)` on both sides)
    const cg = stripRouteGroups(c);
    const tg = stripRouteGroups(t);
    if (cg === tg)
        return "route-group";
    // 3. suffix: committed ends with the (group-normalised) contract path,
    //    on a segment boundary (contract omits a leading prefix like packages/*).
    if (cg.endsWith(`/${tg}`))
        return "suffix";
    // 4. basename + trailing-dir context. Same filename AND every directory of
    //    the contract (group-normalised) appears in order as a suffix of the
    //    committed dir chain. Requires >=1 shared parent dir when the contract
    //    has one, so a bare `page.tsx` doesn't match an unrelated `page.tsx`.
    if (baseName(cg) === baseName(tg)) {
        const cDirs = cg.split("/").slice(0, -1);
        const tDirs = tg.split("/").slice(0, -1);
        if (tDirs.length === 0)
            return "basename"; // contract had no dir context
        // tDirs must be a contiguous suffix of cDirs.
        if (tDirs.length <= cDirs.length) {
            const tail = cDirs.slice(cDirs.length - tDirs.length);
            if (tail.every((d, i) => d === tDirs[i]))
                return "basename-dir";
        }
    }
    return null;
}
/** Boolean convenience wrapper. */
export function pathMatches(committed, contract) {
    return pathMatchRule(committed, contract) !== null;
}
/** True if ANY committed file satisfies the contract path. */
export function anyPathMatches(committedFiles, contract) {
    return committedFiles.some((f) => pathMatches(f, contract));
}
//# sourceMappingURL=path-match.js.map