/**
 * beta.92: DETERMINISTIC finding -> sub-task mapping (replaces the LLM
 * revise-spec turn).
 *
 * ROOT CAUSE this closes (three consecutive smokes b89/b90/b91): the cycle-2
 * revise-spec LLM turn (beta.67) kept exceeding `revise_spec_timeout_seconds`
 * (the beta.73 cron-nested-lane signature). On timeout it fell back to a RAW
 * 10-finding dump handed to EVERY sub-task (`reviseSpecApplied:false`), so:
 *   - F1 revise-scoping could not target (no per-sub-task file signal),
 *   - every sub-task got findings that mostly don't concern it, and
 *   - overwhelmed workers confabulated "already correct, one narrow change"
 *     answers that don't match their contract (the b91 seq-6 confab).
 *
 * FIX (b92 charter, agreed with Staging 2026-07-30): DELETE the LLM turn.
 * Cycle 2 already knows which sub-task owns which files (`filesLikelyTouched`
 * from the lead plan + `codeExcerpts[].path` from workerContext). Map each
 * diff-addressable finding (dimensions spec|quality|security, where `.file` is
 * required per b91) to the sub-task(s) that own its file, DETERMINISTICALLY,
 * using the same strict `resolveContractPath` structural machinery b87/b88
 * hardened. No LLM turn => no timeout => no raw-dump => no confab-inducing
 * overload.
 *
 * RULES (the charter's explicit ruleset):
 *   - DIFF-ADDRESSABLE (spec|quality|security): map to the sub-task(s) whose
 *     files structurally match the finding's `.file`. A filed finding with NO
 *     structural match to ANY sub-task is a MAPPING MISS -> attach to EVERY
 *     sub-task as context (never dropped, never "run-all the whole cycle"),
 *     and surface `loop.finding_mapping_miss`. A finding lost is never
 *     acceptable; an extra bit of context is.
 *   - META (fit|runtime): cross-cutting guidance ("add ActivityLog to every
 *     state-changing route", "triage preview deploy errors") that fans out to
 *     ALL sub-tasks. Broadcast verbatim as shared context to every sub-task,
 *     and EXEMPT from the F1 unscopable gate (a meta finding without `.file`
 *     must NOT force the whole cycle unscopable).
 *
 * All pure/deterministic. No fs, no git, no SDK. The structural matcher is
 * injected (the loop passes resolveContractPath) so this module has no import
 * cycle with path-match and stays trivially unit-testable.
 */
/** Diff-addressable dimensions (must carry a `.file` per beta.91). */
export const DIFF_ADDRESSABLE = new Set(["spec", "quality", "security"]);
/** Meta dimensions: cross-cutting, `.file` optional, broadcast to all. */
export const META_DIMENSIONS = new Set(["fit", "runtime"]);
function dim(f) {
    return (f.dimension ?? "").toLowerCase();
}
function fileOf(f) {
    return (f.file ?? "").trim();
}
/** Is this a diff-addressable finding (spec|quality|security)? */
export function isDiffAddressable(f) {
    return DIFF_ADDRESSABLE.has(dim(f));
}
/** Is this a meta finding (fit|runtime) -> broadcast, exempt from unscopable gate? */
export function isMetaFinding(f) {
    return META_DIMENSIONS.has(dim(f));
}
/** Render one finding as a worker-facing hint line (mirrors buildReviseDispatchHint). */
export function renderFindingLine(f) {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    return `- [${f.severity}/${f.dimension}] ${f.title ?? "(untitled)"}${loc}: ${f.detail ?? ""}`.slice(0, 600);
}
/**
 * Deterministically map the previous review's findings onto the plan sub-tasks.
 *
 * @param subTasks    cycle-2 plan sub-tasks (raw lead plan; NO LLM refresh)
 * @param findings    the previous review's findings
 * @param match       injected strict structural matcher (resolveContractPath)
 */
export function mapFindingsToSubTasks(subTasks, findings, match) {
    const list = findings ?? [];
    const assignments = subTasks.map((s) => ({
        seq: s.seq,
        targeted: [],
        broadcast: [],
        targetedFiles: [],
    }));
    const bySeq = new Map(assignments.map((a) => [a.seq, a]));
    const meta = [];
    const misses = [];
    let anyTargeted = false;
    for (const f of list) {
        // Meta findings (fit|runtime) always broadcast, regardless of `.file`.
        if (isMetaFinding(f)) {
            meta.push(f);
            continue;
        }
        // Diff-addressable: need a file to structurally target.
        const file = fileOf(f);
        if (isDiffAddressable(f) && file) {
            const owners = [];
            for (const st of subTasks) {
                const owned = [
                    ...(st.filesLikelyTouched ?? []),
                    ...(st.contextPaths ?? []),
                ]
                    .map((p) => (typeof p === "string" ? p.trim() : ""))
                    .filter(Boolean);
                if (owned.length === 0)
                    continue;
                if (match(owned, file))
                    owners.push(st.seq);
            }
            if (owners.length > 0) {
                anyTargeted = true;
                for (const seq of owners) {
                    const a = bySeq.get(seq);
                    if (a) {
                        a.targeted.push(f);
                        if (!a.targetedFiles.includes(file))
                            a.targetedFiles.push(file);
                    }
                }
                continue;
            }
            // MAPPING MISS: a filed diff-addressable finding matched NO sub-task.
            // Never drop it -> attach to every sub-task as broadcast context.
            misses.push(f);
            continue;
        }
        // Diff-addressable but file-less, or an unknown dimension -> treat as
        // broadcast (safe: it reaches every worker as context, never dropped).
        misses.push(f);
    }
    // Broadcast meta + misses to every sub-task.
    const broadcastAll = [...meta, ...misses];
    for (const a of assignments)
        a.broadcast = broadcastAll;
    return { assignments, mappingMisses: misses, metaBroadcast: meta, anyTargeted };
}
/**
 * Build the per-sub-task revise dispatch hint from a deterministic assignment.
 * Replaces the reviseSpecApplied warm-context render + the raw-dump fallback:
 * each worker now sees ONLY the findings that target its files, plus the
 * cross-cutting broadcast guidance -- never the full untargeted 10-finding dump.
 */
export function buildScopedReviseHint(verdict, summary, a) {
    const targetedLines = a.targeted.map(renderFindingLine);
    const broadcastLines = a.broadcast.map(renderFindingLine);
    const parts = [
        `REVISION CYCLE: an adversarial reviewer examined the previous cycle's diff and returned verdict "${verdict}".`,
        `Reviewer summary: ${(summary ?? "").slice(0, 800)}`,
    ];
    if (targetedLines.length > 0) {
        parts.push(`Findings that target THIS sub-task's files (fix these):`, ...targetedLines);
    }
    else {
        parts.push(`No finding targets this sub-task's files directly.`);
    }
    if (broadcastLines.length > 0) {
        parts.push(``, `Cross-cutting guidance (applies across the change; apply the parts that fall in THIS sub-task's files):`, ...broadcastLines);
    }
    parts.push(``, `Address ONLY the findings above that fall inside THIS sub-task's files/scope. If none of them apply to this sub-task, make NO changes and end your turn -- do not redo work that is already correct.`);
    return parts.join("\n");
}
//# sourceMappingURL=revise-mapping.js.map