/** Paths that look like they belong to the repo rather than to a tool. */
const PATH_RE = /\b((?:src|app|lib|test|tests|packages|apps|prisma|components|pages|server|scripts)\/[\w.@/-]+\.[a-z]{1,4})\b/gi;
/** A jest/vitest per-file failure header. */
const FAIL_FILE_RE = /^\s*(?:FAIL|✕\s+FAIL)\s+(\S+)/;
/** The test name jest prints under a failing file. */
const TEST_NAME_RE = /^\s*●\s+(.+?)\s*$/;
/** Lines that are jest's own epilogue rather than a failure. */
const EPILOGUE_RE = /^(Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites|Test results written)/;
function uniq(xs) {
    return [...new Set(xs.filter(Boolean))];
}
function pathsIn(text) {
    return uniq([...text.matchAll(PATH_RE)].map((m) => m[1]));
}
/**
 * Split a log excerpt into one block per failing test file.
 *
 * Falls back to a single unattributed block when the runner is not one we
 * recognise, which still produces a usable finding -- it just broadcasts
 * instead of routing.
 */
function splitByFailingFile(lines) {
    const blocks = [];
    let current = null;
    for (const line of lines) {
        const m = FAIL_FILE_RE.exec(line);
        if (m) {
            if (current)
                blocks.push(current);
            current = { file: m[1], body: [] };
            continue;
        }
        if (EPILOGUE_RE.test(line.trim())) {
            if (current) {
                blocks.push(current);
                current = null;
            }
            continue;
        }
        if (current)
            current.body.push(line);
    }
    if (current)
        blocks.push(current);
    return blocks;
}
/**
 * Build blocking findings from the failing-CI log excerpt.
 *
 * Each finding carries:
 *   - `file`: the failing TEST file, so the sub-task that owns it is targeted.
 *   - `relatedFiles`: every repo path named in the failure body, so co-fix
 *     routing can reach the source file when the test names it.
 *   - `detail`: the verbatim excerpt, because the worker needs the assertion,
 *     not a summary of it.
 *
 * When no file can be identified the finding is returned with no `file`, which
 * the mapper treats as a miss and broadcasts to every sub-task. That is the
 * right default: a red build is a property of the whole branch, and it is
 * better to show it to everyone than to route it confidently to the wrong
 * owner.
 */
export function buildCiFailureFindings(logs, opts = {}) {
    const max = opts.maxFindings ?? 6;
    const text = (logs ?? "").trim();
    if (!text)
        return [];
    const lines = text.split("\n");
    const blocks = splitByFailingFile(lines);
    const shaNote = opts.sha ? ` on ${opts.sha.slice(0, 8)}` : "";
    if (blocks.length === 0) {
        // Unrecognised runner, or a failure with no per-file structure (a build
        // step, a lint run, an install). Still blocking, just unrouted.
        const related = pathsIn(text);
        return [{
                source: "ci",
                dimension: "quality",
                severity: "high",
                title: `CI is failing${shaNote}`,
                detail: `GitHub CI failed on this branch. This is the repository's own pipeline running against ` +
                    `the exact commit this run produced, so it is not advisory.\n\n` +
                    `Failing output:\n${text.slice(0, 3000)}`,
                file: related[0] ?? null,
                relatedFiles: related.length > 1 ? related.slice(1, 8) : null,
            }];
    }
    const findings = [];
    for (const block of blocks.slice(0, max)) {
        const body = block.body.join("\n").trim();
        const testName = block.body.map((l) => TEST_NAME_RE.exec(l)?.[1]).find(Boolean);
        // The source files a fix probably lives in are the ones the failure text
        // names that are not the test file itself.
        const related = pathsIn(body).filter((p) => p !== block.file);
        findings.push({
            source: "ci",
            dimension: "quality",
            severity: "high",
            title: testName
                ? `CI: ${block.file} — ${testName.slice(0, 120)}`
                : `CI: ${block.file} is failing`,
            detail: `This test fails in GitHub CI${shaNote}. It ran against the exact commit this run produced, ` +
                `so it is a fact about the branch rather than a review opinion. Fix the cause; do not ` +
                `delete, skip or weaken the test to make it pass.\n\n` +
                `${body.slice(0, 2500)}`,
            file: block.file,
            relatedFiles: related.length > 0 ? related.slice(0, 8) : null,
        });
    }
    if (blocks.length > max) {
        findings.push({
            source: "ci",
            dimension: "quality",
            severity: "high",
            title: `CI has ${blocks.length} failing test files${shaNote}`,
            detail: `${blocks.length} test files are failing; the first ${max} are itemised as separate findings. ` +
                `A failure count this size usually has one shared cause -- look for it before fixing them one by one.\n\n` +
                `All failing files:\n${blocks.map((b) => `  - ${b.file}`).join("\n")}`,
            file: null,
            relatedFiles: null,
        });
    }
    return findings;
}
/**
 * A short, stable line for the audit trail and the ship note.
 */
export function describeCiFindings(findings) {
    if (findings.length === 0)
        return "no CI findings";
    const files = uniq(findings.map((f) => f.file ?? "").filter(Boolean));
    return files.length > 0
        ? `${findings.length} CI finding(s) across ${files.length} file(s): ${files.slice(0, 5).join(", ")}`
        : `${findings.length} CI finding(s), unrouted`;
}
//# sourceMappingURL=ci-findings.js.map