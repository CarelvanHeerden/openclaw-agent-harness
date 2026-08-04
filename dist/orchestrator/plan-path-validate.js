/**
 * beta.101: PLAN-TIME DETECTION OF FICTIONAL PATHS.
 *
 * The b100 smoke's whole failure cascade started with one invented path. The
 * lead planned "add a GRC sidebar nav entry" against
 * `src/components/layout/grc-nav.tsx` -- a file that does not exist in a
 * directory that does not exist. The worker did the right thing (found the real
 * nav in `src/components/ui/sidebar.tsx` and edited it correctly), verification
 * failed against the fictional contract path, and the run burned a
 * clarification round-trip, a re-plan and a review turn on a plan defect that
 * was detectable before any worker started.
 *
 * The discriminator is the PARENT DIRECTORY, not the file. A plan naming a file
 * that does not exist yet is completely normal -- most sub-tasks create files.
 * A plan naming a file whose parent directory ALSO does not exist is either
 * inventing a convention the repo does not use, or genuinely creating a new
 * module. Distinguishing those two needs intent, so this never blocks: it flags
 * the path so the worker's brief can carry "this path is unverified; locate the
 * real one before assuming it".
 */
function normalise(p) {
    return p.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}
function parentDir(p) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "" : p.slice(0, i);
}
/**
 * Pure: given plan paths and the repo's tracked file list, return the paths
 * whose file is absent AND whose parent directory contains nothing at all.
 *
 * Paths at the repo root are never flagged (the root always exists), and a path
 * that names an existing file is never flagged regardless of anything else.
 */
export function findSuspectPlanPaths(planPaths, repoFiles) {
    const files = new Set();
    const dirs = new Set();
    for (const raw of repoFiles) {
        const f = normalise(typeof raw === "string" ? raw : "");
        if (!f)
            continue;
        files.add(f);
        // Register every ancestor directory so a deep file proves its whole chain.
        let d = parentDir(f);
        while (d) {
            if (dirs.has(d))
                break;
            dirs.add(d);
            d = parentDir(d);
        }
    }
    if (files.size === 0)
        return []; // No repo listing -> no opinion. Fail open.
    const seen = new Set();
    const out = [];
    for (const raw of planPaths) {
        const p = normalise(typeof raw === "string" ? raw : "");
        // A glob or a bare directory hint is not a file claim; skip it.
        if (!p || p.includes("*") || seen.has(p))
            continue;
        seen.add(p);
        if (files.has(p) || dirs.has(p))
            continue;
        const dir = parentDir(p);
        if (!dir)
            continue; // repo root always exists
        if (dirs.has(dir))
            continue; // plausible new file in a real directory
        out.push({ path: p, missingDir: dir });
    }
    return out;
}
/**
 * Advisory note folded into the worker dispatch context. Phrased to redirect
 * rather than forbid: the path may be a legitimately new module, and the worker
 * is the one with the repo in front of it.
 */
export function describeSuspectPlanPaths(suspects) {
    const lines = suspects.map((s) => `  - ${s.path} (no such directory: ${s.missingDir}/)`);
    return (`PLAN PATH WARNING: the plan names ${suspects.length} path(s) that do not exist, in directories that do not ` +
        `exist either:\n${lines.join("\n")}\n` +
        `Treat these as GUESSES, not instructions. Before creating them, search the repo for where this kind of code ` +
        `actually lives and follow that convention. If you place the work somewhere else, say so explicitly in your ` +
        `final message and name the path you used.`);
}
//# sourceMappingURL=plan-path-validate.js.map