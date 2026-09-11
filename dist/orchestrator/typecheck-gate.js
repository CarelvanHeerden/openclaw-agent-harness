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
 * rc.6 (#1184): the diagnostics of a check-script run, from the WHOLE capture.
 *
 * This exists as its own function because the rule it encodes is one sentence
 * long and was previously spelled out at each call site as
 * `parseTscErrors(r.outputTail)` -- reading the last 4,000 characters of a
 * compiler run and treating the result as its errors. On StitchGuard #1184 that
 * turned 40 diagnostics across three changed files into one, and three revise
 * cycles were spent repairing the single file the tail happened to end in.
 *
 * `outputTail` is for display and for model prompts, which must stay bounded.
 * Analysis reads `output`. The fallback covers a caller that predates the split
 * (and callers that synthesise a result), and is the only reason a truncated
 * stream can still reach the parser.
 */
export function diagnosticsFrom(result) {
    return parseTscErrors(result.output ?? result.outputTail ?? "");
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
    // rc.6 (#1184): every affected file survives into the finding.
    //
    // The compiler reported 40 errors across three changed test files. This
    // finding named the first file and listed the first ten errors, so repair was
    // routed at one file three cycles running while two others stayed broken --
    // and the CI reporting downstream summarised the lot as "1 CI finding(s)
    // across 1 file(s)". `file` still has to be a single path (it is what scoping
    // keys on), but `relatedFiles` carries the rest into routing, and the detail
    // below accounts for every file rather than the first ten errors.
    const byFile = new Map();
    for (const e of errors) {
        const list = byFile.get(e.file) ?? [];
        list.push(e);
        byFile.set(e.file, list);
    }
    const files = [...byFile.keys()];
    // A bounded sample that still reaches every file: take errors round-robin, so
    // a file holding 38 of the 40 cannot crowd the other two out of the listing.
    const SAMPLE_MAX = 10;
    const sample = [];
    for (let depth = 0; sample.length < SAMPLE_MAX && depth < errors.length; depth++) {
        for (const f of files) {
            const e = byFile.get(f)?.[depth];
            if (e && sample.length < SAMPLE_MAX)
                sample.push(e);
        }
    }
    const shown = sample.length > 0 ? sample : errors.slice(0, SAMPLE_MAX);
    const rest = errors.length - shown.length;
    // One line, so naming every file cannot itself blow the review prompt.
    const FILES_MAX = 12;
    const perFile = files.slice(0, FILES_MAX).map((f) => `${f} (${byFile.get(f)?.length ?? 0})`).join(", ") +
        (files.length > FILES_MAX ? `, and ${files.length - FILES_MAX} more file(s)` : "");
    return {
        dimension: "quality",
        severity: "high",
        // rc.6: the other affected files, so a repair that only fixes `file` cannot
        // be reported as having addressed this finding.
        ...(files.length > 1 ? { relatedFiles: files.slice(1) } : {}),
        // beta.116: name a file. This finding knows exactly where the errors are,
        // and emitting it unfiled made it the most expensive kind of finding there
        // is: `quality` is diff-addressable, so an unfiled one trips
        // `anyFindingUnfiled` and the whole revise cycle abandons scoping and
        // re-runs every sub-task. That is what happened in b115's cycle 2 -- six
        // sub-tasks re-run because the one finding that could have targeted them
        // declined to say where. Errors are sorted by file, so the first is a
        // stable choice, and every error is listed in `detail` regardless.
        file: errors[0]?.file,
        line: errors[0]?.line,
        title: `Branch does not typecheck: ${errors.length} error(s) from \`${script}\` across ` +
            `${files.length} file(s) this branch changed`,
        detail: `\`${script}\` reported ${errors.length} error(s) in ${files.length} file(s) this branch touched. These ` +
            `were introduced or left behind by this work, and the branch will not compile.\n\n` +
            `Every affected file must be fixed, not just the first — ${perFile}\n\n` +
            shown.map((e) => `  ${e.file}(${e.line},${e.column}): ${e.code}: ${e.message}`).join("\n") +
            (rest > 0 ? `\n  ... and ${rest} more, spread across the files listed above` : "") +
            `\n\nErrors in files this branch did NOT touch are ignored, so this is not pre-existing breakage. ` +
            `Fix these before merge.`,
    };
}
//# sourceMappingURL=typecheck-gate.js.map