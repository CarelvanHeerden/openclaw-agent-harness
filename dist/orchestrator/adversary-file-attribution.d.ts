/**
 * beta.91 (F1 companion): require `file` on diff-addressable adversary findings.
 *
 * F1 revise-cycle scoping can only skip an already-correct sub-task when it
 * knows which file each finding targets. When findings are file-less (b90
 * DR/BCP: targetCount:0 on all 12 cycle-2 sub-tasks) scoping is inert -- the
 * "fix visible in code, invisible in behaviour" b89 mistake. So we require the
 * adversary to name the file on any finding that points at a concrete code
 * defect, validate at parse, and re-prompt ONCE when it doesn't.
 *
 * Diff-addressable dimensions here (the ReviewFinding.dimension enum is
 * spec|fit|quality|security|runtime): a `medium`+ finding in spec / quality /
 * security names a concrete code defect the worker fixes by editing THIS diff,
 * so it MUST carry a file. `fit` (convention/architecture) + `runtime`
 * (deploy/observability) are meta and may omit it.
 *
 * SECOND-FAILURE POLICY (Staging's spec #3): reject + re-prompt ONCE; if the
 * re-prompt still returns unfiled diff-addressable findings, KEEP them (do NOT
 * hard-fail the whole review) -- F1 will treat that cycle as unscopable and run
 * everything (safe). A missing file is a lost optimisation, never a lost review.
 *
 * Pure/deterministic.
 */
export interface AttribFinding {
    dimension: string;
    severity: string;
    file?: string | null;
    title?: string;
}
/**
 * A finding that MUST carry a file: diff-addressable dimension AND >= medium.
 *
 * rc.4: this read a local `AT_LEAST_MEDIUM` set through a hand-rolled
 * `(f.severity ?? "").toLowerCase()`. rc.3 consolidated the ship gate and the
 * merge gate onto `isAtLeastMedium` and left this site behind, which left one
 * value disagreeing: `unknown`. An unreadable severity blocked the ship but was
 * not required to name a file, so it could never be attributed, never scoped to
 * a worker, and the revise loop burned to `max_cycles` on a finding nothing
 * could be assigned to fix. Blocking and unfixable is the wrong pair.
 */
export declare function requiresFile(f: AttribFinding): boolean;
/** True when the finding is one that requires a file but has none. */
export declare function isUnfiledDiffAddressable(f: AttribFinding): boolean;
/** The subset of findings that violate the file-attribution requirement. */
export declare function findingsMissingFile(findings: AttribFinding[]): AttribFinding[];
/**
 * Re-prompt nudge appended to the adversary system prompt when >= 1
 * diff-addressable finding came back without a file. Names the offenders.
 */
export declare function buildFileAttributionRetryNudge(missing: AttribFinding[]): string;
//# sourceMappingURL=adversary-file-attribution.d.ts.map