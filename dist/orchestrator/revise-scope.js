/**
 * beta.91 (Fix 1): cycle-scoping for revise cycles.
 *
 * PROBLEM (Staging's beta.90 DR/BCP smoke, session baa8ba08): a revise cycle
 * (cycle > 1) re-ran ALL 12 sub-tasks even though 8 of them were
 * `subtask_revise_no_change` -- the worker re-checked an already-correct commit
 * and did nothing. That is ~5 min of pure "spin up a worker, confirm no change
 * needed, tear down" overhead per cycle, on top of a full adversary review that
 * scales with sub-task count.
 *
 * FIX: on a revise cycle, a sub-task whose file scope does NOT intersect ANY
 * finding's file is not something the current review is asking to change --
 * skip it (its prior-cycle commit is already correct and part of the branch).
 * Only re-run sub-tasks that a finding actually targets, PLUS anything the
 * skipped set depends on transitively is preserved (we never skip a sub-task a
 * KEPT sub-task depends on -- dependency safety first).
 *
 * SAFETY (why this can only reduce, never break, correctness):
 *   1. Scoped ONLY to cycle > 1 with review findings present. Cycle 1 is
 *      untouched.
 *   2. A finding with NO resolvable file (bare/absent `file`) makes the whole
 *      cycle UNSCOPABLE -> we skip the optimisation entirely and run every
 *      sub-task (matches beta.86 `strict_no_targets` conservatism -- we cannot
 *      prove a sub-task is irrelevant, so we run it).
 *   3. A sub-task with NO `filesLikelyTouched` is UNSCOPABLE for itself -> it is
 *      always KEPT (we cannot prove it is irrelevant).
 *   4. We NEVER skip a sub-task that a kept sub-task `dependsOn` (transitive) --
 *      the kept one may need its output committed/on-disk.
 *   5. This is purely which-sub-tasks-to-run; the adversary still reviews the
 *      WHOLE branch diff afterwards, so a wrongly-skipped file would still be
 *      caught by review, not silently shipped.
 *   6. (beta.91 QUESTION-8, Staging pass 1) An unscopable-for-itself sub-task S
 *      (empty filesLikelyTouched, e.g. a "verify feature complete" probe) that
 *      LOGICALLY reads state written by a skipped scaffolding sub-task is safe:
 *      the scaffolding sub-task's file is ALREADY COMMITTED from the prior
 *      cycle, so the branch on-disk state S reads is correct even though the
 *      scaffolding sub-task was not re-executed. And a cycle-1 sub-task that
 *      FAILED is forced back into re-execution by the loop's worker-deviation /
 *      failure path independent of scoping, so a stale file is never preserved.
 *      Hence dependency closure only needs the FORWARD dependsOn edges (below).
 *
 * All pure/deterministic. No fs, no git, no SDK.
 */
/**
 * beta.92 (charter item #3): meta dimensions (fit|runtime) are cross-cutting
 * and inherently often file-less (a `runtime` "preview deploy reports N errors"
 * finding has no single `.file`). They must NOT force the whole cycle
 * unscopable -- in the b91 smoke a SINGLE unfiled runtime finding tripped the
 * "ANY unfiled -> run everything" gate and F1 never engaged despite 10/11
 * findings being cleanly filed. So the unscopable gate now considers ONLY
 * DIFF-ADDRESSABLE (spec|quality|security) findings that lack a file; a
 * file-less meta finding is expected and broadcast elsewhere (revise-mapping).
 */
const META_DIMENSIONS = new Set(["fit", "runtime"]);
function isMetaDimension(f) {
    return META_DIMENSIONS.has((f.dimension ?? "").trim().toLowerCase());
}
/**
 * beta.113: a finding below medium cannot force the cycle unscopable.
 *
 * The DR/BCP run re-ran all EIGHT sub-tasks in cycle 2 and again in cycle 3.
 * Both times the gate tripped on the same two findings:
 *
 *   quality / info / file=NULL  "Test coverage gaps beyond the four required
 *                                categories"
 *   quality / info / file=NULL  "Remaining coverage gaps beyond the four
 *                                mandated categories (unchanged from prior)"
 *
 * `quality` is diff-addressable so b92's meta exemption did not apply, and
 * neither carried a file, so `anyFindingUnfiled` was true and the optimisation
 * switched itself off. The one finding that actually needed work in cycle 2 was
 * a single medium naming exactly one file.
 *
 * An `info` finding does not drive a revise: it is not blocking, no worker is
 * dispatched to close it, and the loop will ship with it open. Letting one
 * decide that every sub-task must re-run inverts its own severity. The cost was
 * not theoretical -- cycle 2 spent six minutes re-running eight sub-tasks to
 * change one file, and cycle 3 was re-running them again when a worker stalled
 * and took the whole 56-minute, $9.41 run down with it.
 *
 * Matches the severity floor used everywhere else (isBlockingFinding, b109's
 * cycling gate, b112's merge gate): medium and above is actionable.
 */
const BELOW_ACTIONABLE = new Set(["info", "informational", "low", "nit", "note"]);
function isBelowActionable(f) {
    const sev = (f.severity ?? "").trim().toLowerCase();
    // An absent severity is treated as actionable: unknown is not a licence to skip.
    return sev !== "" && BELOW_ACTIONABLE.has(sev);
}
/** Normalise a path for loose intersection: lowercase, strip leading ./, collapse slashes. */
function norm(p) {
    return p
        .trim()
        .replace(/^\.\//, "")
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .toLowerCase();
}
/** basename of a normalised path. */
function base(p) {
    const n = norm(p);
    const i = n.lastIndexOf("/");
    return i === -1 ? n : n.slice(i + 1);
}
/**
 * Does a sub-task's file scope intersect the finding-file set?
 *
 * Matching is PATH-STRUCTURAL (suffix either direction) for findings that carry
 * a directory component -- so a finding `src/app/api/.../route.ts` matches a
 * sub-task listing the same fuller path (or a partial adversary path that is a
 * suffix of it), but does NOT match a DIFFERENT `.../[id]/route.ts` sibling that
 * merely shares the `route.ts` basename. This is the beta.74/87 strict-contract
 * lesson: a bare basename over-targets siblings (route.ts / index.ts / page.tsx
 * are everywhere), so a basename-only match is used ONLY when the finding itself
 * is a bare filename with no directory (the adversary gave just a name). We err
 * toward keeping a sub-task on genuine ambiguity, never toward wrongly skipping.
 */
export function subTaskIntersectsFindings(files, findingFilesNorm, bareFindingBasenames) {
    for (const raw of files) {
        if (!raw)
            continue;
        const f = norm(raw);
        const b = base(raw);
        for (const ff of findingFilesNorm) {
            // suffix either direction (partial adversary path vs fuller plan path)
            if (f === ff || f.endsWith("/" + ff) || ff.endsWith("/" + f))
                return true;
        }
        // basename match ONLY against findings that were themselves BARE filenames
        // (no directory) -- prevents `.../route.ts` from over-matching sibling
        // route files. Requires a specific basename (has an extension).
        if (b.includes(".") && bareFindingBasenames.has(b))
            return true;
    }
    return false;
}
/**
 * Compute which sub-tasks to run vs skip on a revise cycle.
 *
 * @param subTasks the (revise-spec-refreshed or raw) plan sub-tasks
 * @param findings the previous review's findings
 * @param cycle current cycle (1-based)
 */
export function computeReviseScope(subTasks, findings, cycle) {
    const allSeqs = subTasks.map((s) => s.seq);
    if (cycle <= 1) {
        return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "not_revise_cycle", findingFiles: [] };
    }
    const fs = (findings ?? []).map((f) => (f.file ?? "").trim()).filter(Boolean);
    if (!findings || findings.length === 0) {
        return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "no_findings", findingFiles: [] };
    }
    // beta.92: only a DIFF-ADDRESSABLE (spec|quality|security) finding that lacks
    // a resolvable file makes the cycle unscopable -- those SHOULD carry a file
    // (b91 attribution requirement) so a missing one is genuine ambiguity. A
    // file-less META (fit|runtime) finding is expected + broadcast, NOT a reason
    // to run every sub-task. (Pre-b92 this considered ALL findings, so one
    // unfiled runtime finding nuked F1 scoping.)
    const anyFindingUnfiled = (findings ?? []).some((f) => !(f.file ?? "").trim() && !isMetaDimension(f) && !isBelowActionable(f));
    if (anyFindingUnfiled || fs.length === 0) {
        return {
            scoped: false,
            runSeqs: allSeqs,
            skipSeqs: [],
            reason: "unscopable_findings",
            findingFiles: fs,
        };
    }
    const findingFilesNorm = fs.map(norm);
    // Only findings that are BARE filenames (no directory) contribute a basename
    // match -- a full-path finding matches structurally (suffix) so it can't
    // over-target a same-basename sibling under a different directory.
    const bareFindingBasenames = new Set(fs.filter((p) => !norm(p).includes("/")).map(base));
    const bySeq = new Map(subTasks.map((s) => [s.seq, s]));
    // 1) Directly-relevant: intersects a finding, OR unscopable-for-itself
    //    (no filesLikelyTouched -> cannot prove irrelevant -> keep).
    const keep = new Set();
    for (const st of subTasks) {
        const files = (st.filesLikelyTouched ?? []).filter(Boolean);
        if (files.length === 0) {
            keep.add(st.seq); // unscopable-for-itself -> always keep
            continue;
        }
        if (subTaskIntersectsFindings(files, findingFilesNorm, bareFindingBasenames)) {
            keep.add(st.seq);
        }
    }
    // 2) Dependency closure: never skip something a KEPT sub-task depends on
    //    (transitively). Add deps of kept nodes until fixpoint.
    let changed = true;
    while (changed) {
        changed = false;
        for (const seq of [...keep]) {
            const st = bySeq.get(seq);
            for (const d of st?.dependsOn ?? []) {
                if (bySeq.has(d) && !keep.has(d)) {
                    keep.add(d);
                    changed = true;
                }
            }
        }
    }
    const runSeqs = allSeqs.filter((s) => keep.has(s));
    const skipSeqs = allSeqs.filter((s) => !keep.has(s));
    if (skipSeqs.length === 0) {
        return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "all_relevant", findingFiles: fs };
    }
    // beta.113: never scope a cycle down to nothing.
    //
    // Surfaced while fixing the severity gate above. On the DR/BCP run the only
    // actionable finding named `src/lib/help/help-content.ts`, which no sub-task
    // declared -- the same reason it was also reported out-of-scope. With the
    // gate correctly no longer tripping on the two `info` findings, scoping
    // engaged and selected ZERO sub-tasks: a cycle that dispatches nobody,
    // changes nothing, and (post-b108) exits early having burned a review.
    //
    // An empty selection is not evidence that there is no work; it is evidence
    // that we cannot tell whose work it is. Fall back to the unscoped set, which
    // is what the pre-b113 gate would have done anyway.
    if (runSeqs.length === 0) {
        return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "no_subtask_owns_the_findings", findingFiles: fs };
    }
    return { scoped: true, runSeqs, skipSeqs, findingFiles: fs };
}
//# sourceMappingURL=revise-scope.js.map