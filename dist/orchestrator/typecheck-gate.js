/**
 * beta.111: make a branch that does not compile fail the review.
 *
 * ProjectThanos PR #932 has been through three revise runs. Its head does not
 * typecheck:
 *
 *   src/app/api/grc/continuity-exercises/[id]/route.ts(124,14): error TS2551:
 *   Property 'ownerUserId' does not exist on type 'ContinuityExerciseUpdateInput'.
 *
 * The b108 revise introduced it (`ac1dc948`, the ownerUserId reassignment
 * guard) and nothing has caught it since, because the adversary reviews the
 * DIFF, not the compiler. A worker's own verify sub-task did surface it, but
 * nothing gated on that, so it was a note in a report nobody acted on. CI is
 * green on the PR -- that repo's CI does not run a typecheck -- so "let CI
 * catch it" does not hold either.
 *
 * The cheap correct scope: report errors in files THIS BRANCH CHANGED. That
 * needs one typecheck run, not a second one at the base commit to diff
 * against, and it keeps a repo with pre-existing breakage usable -- #932 also
 * carries 71 unrelated failing tests from a React version mismatch, and a gate
 * that blocked on those would block every run forever. An error in a file you
 * just edited is yours to deal with either way.
 */
import { pathMatches } from "./path-match.js";
// tsc, both plain and pretty-disabled:
//   src/a/b.ts(124,14): error TS2551: Property 'x' does not exist on type 'Y'.
const TSC_LINE = /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<col>\d+)\):\s+error\s+(?<code>TS\d+):\s+(?<msg>.*)$/;
export function parseTscErrors(output) {
    const out = [];
    const seen = new Set();
    for (const raw of (output ?? "").split("\n")) {
        // Strip ANSI so a colourised run parses identically to a plain one.
        const line = raw.replace(/\u001B\[[0-9;]*m/g, "").trimEnd();
        const m = TSC_LINE.exec(line.trim());
        if (!m?.groups)
            continue;
        const g = m.groups;
        const file = g.file.trim().replace(/^\.\//, "");
        const key = `${file}:${g.line}:${g.col}:${g.code}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ file, line: Number(g.line), column: Number(g.col), code: g.code, message: g.msg.trim() });
    }
    return out;
}
/**
 * Errors in files this branch changed. Uses the shared tolerant matcher so a
 * route-group-normalised or differently-rooted path still lines up with the
 * committed-file list, the same way every other per-file check does.
 */
export function errorsInChangedFiles(errors, changedFiles) {
    if (errors.length === 0 || changedFiles.length === 0)
        return [];
    return errors.filter((e) => changedFiles.some((c) => pathMatches(c, e.file)));
}
/**
 * `high`, not `medium`. A branch that does not compile is not mergeable on
 * anybody's reading, and `high` is in merge-recommendation's blocking set, so
 * this blocks the merge even if the adversary passes. It is also
 * diff-addressable and above medium, so isBlockingFinding counts it and the
 * beta.109 no-blocking-findings gate keeps cycling instead of shipping.
 */
export function buildTypecheckFinding(errors, script) {
    const shown = errors.slice(0, 10);
    const rest = errors.length - shown.length;
    return {
        dimension: "quality",
        severity: "high",
        title: `Branch does not typecheck: ${errors.length} error(s) from \`${script}\` in file(s) this branch changed`,
        detail: `\`${script}\` reported ${errors.length} error(s) in files this branch touched. These were introduced or ` +
            `left behind by this work, and the branch will not compile:\n\n` +
            shown.map((e) => `  ${e.file}(${e.line},${e.column}): ${e.code}: ${e.message}`).join("\n") +
            (rest > 0 ? `\n  ... and ${rest} more` : "") +
            `\n\nErrors in files this branch did NOT touch are ignored, so this is not pre-existing breakage. ` +
            `Fix these before merge.`,
    };
}
//# sourceMappingURL=typecheck-gate.js.map