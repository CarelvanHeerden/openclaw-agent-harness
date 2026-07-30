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
import { normalisePath } from "./path-match.js";
function dirSegments(p) {
    const n = normalisePath(p);
    const segs = n.split("/");
    return segs.slice(0, -1); // drop the basename
}
/**
 * Longest common SUFFIX of two segment arrays (the shared trailing dir chain).
 * Returns the shared segments in order (possibly empty).
 */
function commonDirSuffix(a, b) {
    const out = [];
    let i = a.length - 1;
    let j = b.length - 1;
    while (i >= 0 && j >= 0 && a[i] === b[j]) {
        out.unshift(a[i]);
        i--;
        j--;
    }
    return out;
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
export function learnRemapsForDir(staleDir, realFiles) {
    const sd = normalisePath(staleDir);
    if (!sd)
        return [];
    const staleSegs = sd.split("/");
    const best = new Map(); // key = `${from}=>${to}`
    for (const f of realFiles) {
        const realSegs = dirSegments(f);
        if (realSegs.length === 0)
            continue;
        const tail = commonDirSuffix(staleSegs, realSegs);
        if (tail.length === 0)
            continue; // no shared subtree -> unrelated, skip
        const fromPrefix = staleSegs.slice(0, staleSegs.length - tail.length).join("/");
        const toPrefix = realSegs.slice(0, realSegs.length - tail.length).join("/");
        if (fromPrefix === toPrefix)
            continue; // no drift on this path
        const key = `${fromPrefix}=>${toPrefix}`;
        const candidate = { from: fromPrefix, to: toPrefix, tail: tail.join("/") };
        const existing = best.get(key);
        // Prefer the longest tail (most specific evidence).
        if (!existing || candidate.tail.length > existing.tail.length)
            best.set(key, candidate);
    }
    return [...best.values()];
}
/**
 * Re-derive a single stale contract path against the run's real touched files.
 * Returns the corrected path (leading prefix remapped to the discovered
 * convention, tail + basename preserved) or the ORIGINAL path unchanged when no
 * evidence-backed remap applies.
 *
 * When multiple remaps apply, the one with the LONGEST shared tail wins (most
 * specific). Ties are broken deterministically by the corrected string.
 */
export function rederiveContractPath(contract, realFiles) {
    const c = normalisePath(contract);
    if (!c || !c.includes("/"))
        return { path: contract, remapped: false };
    // beta.93 GUARD (a): exact-match short-circuit. If the worker actually touched
    // the contract path VERBATIM, the file is exactly where the plan declared --
    // there is nothing to correct, and re-deriving it can only MOVE the goalpost
    // off a correct commit (the session de0cba9f false-positive). This also
    // demotes re-derivation to a genuine last-resort: it now fires ONLY when the
    // declared path is absent from what the run touched.
    for (const f of realFiles) {
        if (normalisePath(f) === c)
            return { path: contract, remapped: false };
    }
    const segs = c.split("/");
    const dir = segs.slice(0, -1);
    const base = segs[segs.length - 1];
    const staleDir = dir.join("/");
    const remaps = learnRemapsForDir(staleDir, realFiles);
    if (remaps.length === 0)
        return { path: contract, remapped: false };
    // Apply the remap whose `from` prefix actually leads staleDir (defensive:
    // learnRemapsForDir already derived `from` from staleDir, but a path may have
    // an empty from-prefix meaning "prepend to"). Choose the longest-tail winner.
    const sorted = [...remaps].sort((a, b) => {
        if (b.tail.length !== a.tail.length)
            return b.tail.length - a.tail.length;
        return `${a.from}=>${a.to}`.localeCompare(`${b.from}=>${b.to}`);
    });
    for (const rm of sorted) {
        // staleDir must equal `${from}/${tail}` (or `${tail}` when from is empty).
        const expectStale = rm.from ? `${rm.from}/${rm.tail}` : rm.tail;
        if (normalisePath(expectStale) !== staleDir)
            continue;
        const newDir = rm.to ? `${rm.to}/${rm.tail}` : rm.tail;
        const corrected = normalisePath(`${newDir}/${base}`);
        if (corrected === c)
            return { path: contract, remapped: false };
        return { path: corrected, remapped: true, via: rm };
    }
    return { path: contract, remapped: false };
}
//# sourceMappingURL=contract-rederive.js.map