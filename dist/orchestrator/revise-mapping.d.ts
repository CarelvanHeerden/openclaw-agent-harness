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
/** ReviewFinding shape we read (structural, avoids a hard type import). */
export interface MapFinding {
    dimension: string;
    severity: string;
    title?: string;
    detail?: string;
    file?: string | null;
    line?: number;
}
/** Sub-task shape we read for mapping. */
export interface MapSubTask {
    seq: number;
    filesLikelyTouched?: string[];
    /** codeExcerpts[].path from workerContext, flattened by the caller. */
    contextPaths?: string[];
}
/**
 * A structural path matcher: returns a truthy matched path when `candidate`
 * (a finding file) structurally resolves against `owned` (a sub-task's files),
 * else falsy. The loop injects `resolveContractPath(owned, candidate,
 * {strictContract:true})` so the SAME strict rules b87/b88 use for contract
 * targeting drive the mapping (no bare-basename over-match).
 */
export type StructuralMatch = (owned: string[], candidate: string) => unknown;
/** Diff-addressable dimensions (must carry a `.file` per beta.91). */
export declare const DIFF_ADDRESSABLE: Set<string>;
/** Meta dimensions: cross-cutting, `.file` optional, broadcast to all. */
export declare const META_DIMENSIONS: Set<string>;
/** Is this a diff-addressable finding (spec|quality|security)? */
export declare function isDiffAddressable(f: MapFinding): boolean;
/** Is this a meta finding (fit|runtime) -> broadcast, exempt from unscopable gate? */
export declare function isMetaFinding(f: MapFinding): boolean;
/** Render one finding as a worker-facing hint line (mirrors buildReviseDispatchHint). */
export declare function renderFindingLine(f: MapFinding): string;
export interface SubTaskAssignment {
    seq: number;
    /** diff-addressable findings that structurally target THIS sub-task's files. */
    targeted: MapFinding[];
    /** meta + mapping-miss findings broadcast to THIS (and every) sub-task. */
    broadcast: MapFinding[];
    /** the union of file paths this sub-task should treat as its targeted set. */
    targetedFiles: string[];
}
export interface ReviseMappingResult {
    /** per-sub-task assignment, keyed by seq (in the sub-tasks' input order). */
    assignments: SubTaskAssignment[];
    /** diff-addressable findings that matched NO sub-task (attached to all). */
    mappingMisses: MapFinding[];
    /** meta findings broadcast to all. */
    metaBroadcast: MapFinding[];
    /** true when at least one diff-addressable finding mapped to a sub-task. */
    anyTargeted: boolean;
}
/**
 * Deterministically map the previous review's findings onto the plan sub-tasks.
 *
 * @param subTasks    cycle-2 plan sub-tasks (raw lead plan; NO LLM refresh)
 * @param findings    the previous review's findings
 * @param match       injected strict structural matcher (resolveContractPath)
 */
export declare function mapFindingsToSubTasks(subTasks: MapSubTask[], findings: MapFinding[] | undefined, match: StructuralMatch): ReviseMappingResult;
/**
 * Build the per-sub-task revise dispatch hint from a deterministic assignment.
 * Replaces the reviseSpecApplied warm-context render + the raw-dump fallback:
 * each worker now sees ONLY the findings that target its files, plus the
 * cross-cutting broadcast guidance -- never the full untargeted 10-finding dump.
 */
export declare function buildScopedReviseHint(verdict: string, summary: string | undefined, a: SubTaskAssignment): string;
//# sourceMappingURL=revise-mapping.d.ts.map