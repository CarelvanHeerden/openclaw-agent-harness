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
export function stripRouteGroups(p: string): string {
  return normalisePath(p)
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");
}

/** Normalise separators + strip a leading `./` and any leading/trailing `/`. */
export function normalisePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/+/g, "/");
}

/** basename of a normalised path. */
function baseName(p: string): string {
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
export function pathMatchRule(committed: string, contract: string): string | null {
  const c = normalisePath(committed);
  const t = normalisePath(contract);
  if (!c || !t) return null;

  // 1. exact
  if (c === t) return "exact";

  // 2. route-group-normalised (strip `(name)` on both sides)
  const cg = stripRouteGroups(c);
  const tg = stripRouteGroups(t);
  if (cg === tg) return "route-group";

  // 3. suffix: committed ends with the (group-normalised) contract path,
  //    on a segment boundary (contract omits a leading prefix like packages/*).
  if (cg.endsWith(`/${tg}`)) return "suffix";

  // 4. basename + trailing-dir context. Same filename AND every directory of
  //    the contract (group-normalised) appears in order as a suffix of the
  //    committed dir chain. Requires >=1 shared parent dir when the contract
  //    has one, so a bare `page.tsx` doesn't match an unrelated `page.tsx`.
  if (baseName(cg) === baseName(tg)) {
    const cDirs = cg.split("/").slice(0, -1);
    const tDirs = tg.split("/").slice(0, -1);
    if (tDirs.length === 0) return "basename"; // contract had no dir context
    // tDirs must be a contiguous suffix of cDirs.
    if (tDirs.length <= cDirs.length) {
      const tail = cDirs.slice(cDirs.length - tDirs.length);
      if (tail.every((d, i) => d === tDirs[i])) return "basename-dir";
    }
  }

  return null;
}

/** Boolean convenience wrapper. */
export function pathMatches(committed: string, contract: string): boolean {
  return pathMatchRule(committed, contract) !== null;
}

/** True if ANY committed file satisfies the contract path. */
export function anyPathMatches(committedFiles: string[], contract: string): boolean {
  return committedFiles.some((f) => pathMatches(f, contract));
}

/**
 * beta.51: resolve a lead-authored contract path to the ACTUAL repo-relative
 * file among a list of real files (from `git diff --name-only` /
 * `git log --name-only`). Returns the best structural match, preferring the
 * strictest rule. This lets every path-resolving verifier (file_written,
 * file_committed, file_exists, file_pushed) share ONE normalization instead of
 * each doing its own exact `resolve()` compare -- the beta.50 miss was fixing
 * only `file_committed` and leaving `file_written` on exact-match, so seq 4 of
 * the #858 revise passed file_committed (via route-group) but died on
 * file_written (stat of the literal brief path ENOENT'd).
 *
 * Returns { file, rule } for the best match, or null if none match.
 */
const RULE_RANK: Record<string, number> = {
  exact: 0,
  "route-group": 1,
  suffix: 2,
  "basename-dir": 3,
  basename: 4,
  "basename-unique": 5,
};
export function resolveContractPath(
  realFiles: string[],
  contract: string,
  opts: { allowBasenameFallback?: boolean } = {},
): { file: string; rule: string } | null {
  let best: { file: string; rule: string } | null = null;
  for (const f of realFiles) {
    const rule = pathMatchRule(f, contract);
    if (!rule) continue;
    if (rule === "exact") return { file: f, rule };
    if (best === null || (RULE_RANK[rule] ?? 9) < (RULE_RANK[best.rule] ?? 9)) {
      best = { file: f, rule };
    }
  }
  if (best) return best;

  // beta.59 (D-path-drift): last-resort BASENAME-UNIQUE fallback.
  //
  // ROOT CAUSE (b55-drop10 #858, session 1db243c1, seq 4): the lead bakes a
  // contract path from the crystallised brief's stale filesLikelyTouched hints
  // BEFORE the observe probe runs. seq 4's contract was
  // `components/governance-risk/risks/taxonomy-filter-dropdown.tsx`, but the
  // worker (correctly, using the probe's discovered layout) committed
  // `src/components/grc/taxonomy-filter-dropdown.tsx`. Different directory
  // TOPOLOGY (`grc` vs `governance-risk/risks`), so exact/route-group/suffix/
  // basename-dir ALL miss -- there is no common trailing path. A correct,
  // committed change failed verification.
  //
  // Fallback: when the contract has directory context AND exactly ONE candidate
  // file in `realFiles` shares the contract's basename, accept it. SAFETY: this
  // is only sound because callers pass a PER-SUB-TASK-scoped file list (the
  // `git log/diff base..HEAD` since the sub-task's own worker-session-start
  // SHA), NOT the whole repo -- so a lone same-basename file in that tiny set
  // is demonstrably the file THIS sub-task just wrote. The uniqueness guard
  // means an ambiguous multi-file basename collision falls through to a real
  // failure rather than guessing. Opt-in (`allowBasenameFallback`) so
  // repo-wide callers (e.g. file_in_pr over the whole PR file list) never enable
  // it. `commit_made` still independently proves a real commit happened.
  if (opts.allowBasenameFallback) {
    const t = normalisePath(contract);
    const tHasDir = t.includes("/");
    if (tHasDir) {
      const bn = baseName(t);
      const hits = realFiles.filter((f) => baseName(f) === bn);
      if (hits.length === 1) return { file: hits[0]!, rule: "basename-unique" };
    }
  }
  return null;
}
