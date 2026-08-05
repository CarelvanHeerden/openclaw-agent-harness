/**
 * beta.105: UPSTREAM basename-anchored remap generation.
 *
 * b103's `rederiveContractPath` is a CONSUMER of remaps. It corrects a
 * contract path only when some EARLIER sub-task in the same run already
 * committed a file that taught the loop the substitution -- `src/app/(app)` ->
 * `src/app/(portal)`, say. When that lesson exists the machinery is excellent:
 * the b103 smoke fired nine rederives, every one of them correct, every one
 * written back to the plan.
 *
 * It has no producer. On the b103 smoke, seq 9 was the FIRST sub-task in the
 * run to touch anything under `src/components/`, so when the lead's fictional
 * `src/components/layout/sidebar.tsx` met the worker's correct
 * `src/components/ui/sidebar.tsx`, there was no prior lesson to apply, no
 * rederive fired at all, and the run escalated to a human. The answer was
 * mechanically obvious -- same basename, plan directory does not exist, the
 * committed file's directory does -- and the clarification cost an hour of
 * dead time before anyone read it.
 *
 * This module is the producer. It proposes a remap from the mismatch itself,
 * under conditions strict enough that a proposal is evidence rather than a
 * guess. It only PROPOSES; the caller applies it through the same b103
 * rederive-and-writeback path, so a rescued path is corrected in the contract
 * and in the plan exactly like a learned one.
 *
 * Pure: takes the mismatch and a repo directory listing, returns a proposal or
 * nothing. No git, no fs, no I/O.
 */
function normalise(p) {
    return (p ?? "").trim().replace(/^\.?\//, "").replace(/\/+$/, "");
}
function dirnameOf(p) {
    const i = normalise(p).lastIndexOf("/");
    return i < 0 ? "" : normalise(p).slice(0, i);
}
function basenameOf(p) {
    const n = normalise(p);
    const i = n.lastIndexOf("/");
    return i < 0 ? n : n.slice(i + 1);
}
/**
 * Would a rescue be safe here, and if so what is it?
 *
 * Returns `undefined` -- meaning "escalate to a human, as before" -- unless
 * ALL of the following hold. Each one is load-bearing:
 *
 * 1. Exactly one expected path and exactly one actual path. A multi-file
 *    mismatch can be a genuinely wrong sub-task rather than a naming drift,
 *    and there is no unambiguous pairing to infer a substitution from.
 * 2. The two paths share a basename. This is the anchor: it is what makes
 *    "the same file, somewhere else" the overwhelmingly likely reading.
 * 3. The paths actually differ. Nothing to rescue otherwise.
 * 4. The expected DIRECTORY does not exist anywhere in the repo. If it does
 *    exist, the plan named a real location and the worker put the file
 *    somewhere else -- that is a real disagreement about where work belongs and
 *    a human should see it.
 * 5. The actual directory DOES exist in the repo. Confirms the worker landed
 *    somewhere real rather than inventing a second fiction.
 *
 * `repoDirs` is the set of directories present in the repo, derived from a
 * tracked-file listing by the caller.
 */
export function proposeBasenameRescue(input) {
    const expected = (input.expected ?? []).map(normalise).filter(Boolean);
    const actual = (input.actual ?? []).map(normalise).filter(Boolean);
    // (1) single-file mismatch only.
    if (expected.length !== 1 || actual.length !== 1)
        return undefined;
    const from = expected[0];
    const to = actual[0];
    // (3) and (2).
    if (from === to)
        return undefined;
    const base = basenameOf(from);
    if (!base || base !== basenameOf(to))
        return undefined;
    const fromDir = dirnameOf(from);
    const toDir = dirnameOf(to);
    if (fromDir === toDir)
        return undefined;
    // (4) the plan's directory must be fictional...
    if (input.repoDirs.has(fromDir))
        return undefined;
    // (5) ...and the worker's must be real.
    if (!input.repoDirs.has(toDir))
        return undefined;
    return {
        from,
        to,
        via: { from: fromDir, to: toDir, basename: base },
        reason: `single-file mismatch on basename '${base}'; planned directory '${fromDir}' does not exist in the repo ` +
            `and committed directory '${toDir}' does`,
    };
}
/** The set of directories implied by a tracked-file listing, including "". */
export function repoDirsFromFiles(files) {
    const dirs = new Set([""]);
    for (const f of files) {
        let d = dirnameOf(f);
        while (d) {
            dirs.add(d);
            d = dirnameOf(d);
        }
    }
    return dirs;
}
/** One line for the audit trail and the run log. */
export function describeBasenameRescue(r) {
    return `rescued contract path ${r.from} -> ${r.to} (${r.reason})`;
}
//# sourceMappingURL=basename-rescue.js.map