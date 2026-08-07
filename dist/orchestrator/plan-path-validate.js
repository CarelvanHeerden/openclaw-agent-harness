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
        // beta.112: is this a new directory the repo's own layout predicts?
        //
        // Both real cases are one level below a directory that exists, so depth
        // alone cannot tell them apart:
        //
        //   src/app/api/grc/exceptions/stats/route.ts   correct, has two siblings
        //   src/components/layout/grc-nav.tsx           invented (b100)
        //
        // What separates them is precedent. `stats/` already exists under
        // `src/app/api/grc/` as `key-management/stats/`, so a new one is the repo
        // repeating itself. Nothing named `layout/` exists anywhere near
        // `src/components/`, so that directory was made up.
        let ancestor = parentDir(dir);
        let depth = 1;
        while (ancestor && !dirs.has(ancestor)) {
            depth += 1;
            ancestor = parentDir(ancestor);
        }
        const name = dir.slice(dir.lastIndexOf("/") + 1);
        // Search one level ABOVE the nearest real ancestor, because that is where a
        // sibling lives. For `src/app/api/grc/exceptions/stats`, the ancestor is
        // `.../exceptions` and the precedent is `.../key-management/stats` -- a
        // cousin, invisible from `exceptions/` itself. Widening to the whole repo
        // instead would let a stray `utils/` anywhere vouch for any `utils/`.
        const scope = ancestor ? parentDir(ancestor) : "";
        const prefix = scope ? `${scope}/` : "";
        let precedent;
        if (depth === 1) {
            for (const d of dirs) {
                if (d === dir || !d.startsWith(prefix))
                    continue;
                if (d.slice(prefix.length).split("/").includes(name)) {
                    precedent = d;
                    break;
                }
            }
        }
        out.push({ path: p, missingDir: dir, missingDepth: depth, precedent });
    }
    return out;
}
/**
 * Advisory note folded into the worker dispatch context. Phrased to redirect
 * rather than forbid: the path may be a legitimately new module, and the worker
 * is the one with the repo in front of it.
 */
export function describeSuspectPlanPaths(suspects) {
    // beta.112: "Treat these as GUESSES, not instructions" went to a worker whose
    // target was `src/app/api/grc/exceptions/stats/route.ts` -- a correct
    // instruction, matching the two existing `<resource>/stats/route.ts` siblings
    // it had been told to copy. The only thing wrong with the path was that its
    // directory did not exist yet, which is true of every new file. ProjectThanos
    // PR #952: the worker built it anyway, but the harness spent a dispatch hint
    // arguing against its own plan.
    //
    // Split on precedent, not depth: the b100 case
    // (`src/components/layout/grc-nav.tsx`, where nothing named `layout/` exists
    // near `src/components/`) is one level below a real directory too, and still
    // earns the strong wording.
    const shallow = suspects.filter((s) => !!s.precedent);
    const detached = suspects.filter((s) => !s.precedent);
    const parts = [];
    if (detached.length > 0) {
        parts.push(`PLAN PATH WARNING: the plan names ${detached.length} path(s) in directories that do not exist, and the ` +
            `repo has nothing of that name anywhere nearby to copy:\n` +
            detached.map((s) => `  - ${s.path} (no such directory: ${s.missingDir}/)`).join("\n") +
            `\nTreat these as GUESSES, not instructions. Before creating them, search the repo for where this kind of ` +
            `code actually lives and follow that convention. If you place the work somewhere else, say so explicitly ` +
            `in your final message and name the path you used.`);
    }
    if (shallow.length > 0) {
        parts.push(`NEW DIRECTORY NOTE: ${shallow.length} path(s) in the plan sit in a directory that does not exist yet, so ` +
            `you will be creating it:\n` +
            shallow
                .map((s) => `  - ${s.path} (new directory: ${s.missingDir}/, alongside the existing ${s.precedent}/)`)
                .join("\n") +
            `\nThat is expected for new work, and the repo already has a directory of that name in the same place, so ` +
            `the path follows an existing convention. Read that sibling before you write, and match how it is built. ` +
            `If you choose a different path anyway, name the one you used in your final message.`);
    }
    return parts.join("\n\n");
}
//# sourceMappingURL=plan-path-validate.js.map