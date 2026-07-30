/**
 * beta.76 (Option 1 -- "the real cure"): contract-path RE-DERIVATION.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every path-match heuristic shipped since beta.50 (route-group, suffix,
 * basename-dir, basename-unique, test-file-unique) is a WORKAROUND for a single
 * root defect: the lead authors a sub-task's contract path (via `verify` or
 * `filesLikelyTouched`) as a GUESS, BEFORE the observe probe has discovered the
 * repo's real layout. When the guess drifts from the worker's real committed
 * path, the verifier false-fails a correct commit -- and we patch it with one
 * more tolerant match rule. That is whack-a-mole: there is always one more path
 * shape, and each new repo (Rust, Django, monorepo) re-opens the class.
 *
 * Carel's concern (2026-07-27): "all these edge cases are becoming specific to
 * the project. What happens when we dev against another repo?" The rules are
 * generic, but the reactive discover-one-at-a-time loop is not the cure.
 *
 * THE CURE
 * --------
 * Stop verifying against the lead's stale guess. As the run proceeds, the files
 * the workers ACTUALLY touch are GROUND TRUTH for the repo's real directory
 * conventions. Learn a small set of directory-prefix REMAPPINGS from those real
 * paths, then rewrite a downstream sub-task's stale contract path THROUGH those
 * remappings before it is verified. The verifier then compares against a
 * reality-corrected path instead of a pre-probe guess -- so drift is corrected
 * at the source, and the match rules become a rarely-needed backstop.
 *
 * MECHANISM (bounded + repo-agnostic + false-positive-safe)
 * ---------------------------------------------------------
 * A remapping is learned ONLY from empirical evidence: a real touched file
 * whose path shares a trailing directory chain (>=1 segment) with a stale
 * contract path, but under a DIFFERENT leading prefix. e.g.
 *
 *   stale contract dir : tests/api/grc
 *   real touched file  : src/__tests__/api/grc/evidence-fileurl-validation.test.ts
 *   shared tail        : api/grc
 *   learned remap      : tests/  ->  src/__tests__/   (for the api/grc subtree)
 *
 * We only ever remap the LEADING prefix up to the shared tail; the tail + the
 * basename the lead specified are preserved (or, for the test-file case, the
 * basename is left to the downstream test-file-unique rule). A remap requires a
 * NON-empty shared tail so we never collapse two unrelated trees. When no
 * remapping applies, the path is returned UNCHANGED -- re-derivation never
 * makes verification stricter, only more accurate.
 *
 * This module is PURE (no fs/git) so it is unit-testable and cannot itself
 * false-green anything: it only produces a corrected candidate path that the
 * real probes still have to satisfy.
 *
 * beta.93 (false-positive cure -- session de0cba9f)
 * -------------------------------------------------
 * beta.76's aggressive prefix-remapper mis-fired: it learned a
 * `src/components -> src/lib` remap from ONE sub-task's touched file
 * (`src/lib/grc/continuity-exercises.ts`) and applied it to a DIFFERENT,
 * already-correct contract (`src/components/grc/poi-attachment-upload.tsx`)
 * purely because both share the trailing dir `grc`. The worker had committed
 * that file at EXACTLY its declared path, yet re-derivation moved the goalpost
 * to a non-existent `src/lib/...` path and the strict file_committed check then
 * false-failed a correct commit as "confabulation". Two generic (repo-agnostic)
 * invariants close this whole class:
 *
 *   GUARD (a) -- exact-match short-circuit. If the contract path is ALREADY one
 *     of the real touched files, the worker put the file exactly where the plan
 *     said. A byte-exact-present path needs no correction; return it unchanged.
 *     This demotes re-derivation to what it was always meant to be: a LAST
 *     RESORT that only fires when the declared path is genuinely absent from
 *     what the run actually touched.
 *
 * GUARD (a) is the true, minimal cure for the de0cba9f class: the worker had
 * committed `src/components/grc/poi-attachment-upload.tsx` at EXACTLY its
 * declared path (so it was in the run's real-touched set at re-derive time),
 * yet beta.92 re-derived it anyway (learning `src/components -> src/lib` from
 * an UNRELATED sub-task's `src/lib/grc/continuity-exercises.ts` on the shared
 * `grc` tail) and moved the goalpost off a correct commit. Short-circuiting on
 * an exact touched-path match closes that class outright AND demotes
 * re-derivation to a last-resort. GUARD (a) is a universal truth (a file that
 * exists exactly where the plan said needs no correction, in ANY repo), so it
 * ends the false-positive class without adding a per-repo edge-case rule.
 *
 * NOTE we deliberately do NOT add a same-basename requirement: the beta.76 cure
 * legitimately relies on a DIFFERENT-basename sibling in the real target dir as
 * evidence of a prefix drift (e.g. real `src/components/grc/widget.tsx` proves
 * a stale `components/grc/other.tsx` should be `src/components/grc/other.tsx`).
 * Guard (a) alone is sufficient because the de0cba9f file was committed at its
 * exact declared path -- a genuinely-drifted path (absent from the touched set)
 * still gets the beta.76 correction.
 */
/** A learned leading-prefix remapping, scoped to a shared trailing subtree. */
export interface PrefixRemap {
    /** Leading prefix in the STALE (lead-guessed) path, e.g. `tests`. */
    from: string;
    /** Leading prefix in the REAL (worker-touched) path, e.g. `src/__tests__`. */
    to: string;
    /** The shared trailing directory chain that anchored the remap, e.g. `api/grc`. */
    tail: string;
}
/**
 * Learn directory-prefix remappings from the set of real paths the run has
 * touched so far, relative to a stale contract directory. Returns at most one
 * remap per distinct (from,to) pair, preferring the LONGEST shared tail (most
 * specific / least ambiguous).
 *
 * `staleDir` is the directory portion of a stale contract path (no basename).
 * `realFiles` are actual touched/committed file paths (ground truth).
 */
export declare function learnRemapsForDir(staleDir: string, realFiles: string[]): PrefixRemap[];
/**
 * Re-derive a single stale contract path against the run's real touched files.
 * Returns the corrected path (leading prefix remapped to the discovered
 * convention, tail + basename preserved) or the ORIGINAL path unchanged when no
 * evidence-backed remap applies.
 *
 * When multiple remaps apply, the one with the LONGEST shared tail wins (most
 * specific). Ties are broken deterministically by the corrected string.
 */
export declare function rederiveContractPath(contract: string, realFiles: string[]): {
    path: string;
    remapped: boolean;
    via?: PrefixRemap;
};
//# sourceMappingURL=contract-rederive.d.ts.map