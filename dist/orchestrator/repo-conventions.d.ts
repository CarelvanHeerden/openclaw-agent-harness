/**
 * Repo-convention awareness (beta.63).
 *
 * Origin: Carel's PR #859 review of the b60 taxonomy-dropdown deliverable. The
 * change was good and passed CI, but violated the repo's `keep-okf-current`
 * rule (`npm run okf:check` reported 3 drift issues) — and CI does NOT run
 * `okf:check`, so nothing caught it. Root lesson: THE HARNESS ONLY RESPECTS
 * WHAT THE GATES ENFORCE.
 *
 * Two halves, both here:
 *   Fix 1 — Convention-as-CONTEXT: {@link ingestRepoConventions} reads the
 *     repo's declared convention files at brief build and returns a
 *     char-budgeted `repoConventions[]` that gets threaded into the lead +
 *     worker + adversary SDK prompts (which get NO OpenClaw context injection).
 *   Fix 2 — Convention-as-CHECK: {@link discoverCheckScripts} +
 *     {@link runCheckScripts} run the repo's declared check scripts inline +
 *     blocking in the final-verify sub-task; a non-zero exit becomes a
 *     REVISE-worthy finding (NOT a hard run-fail).
 */
import type { RepoConvention } from "../crystallise/prompt-refiner.js";
export type { RepoConvention } from "../crystallise/prompt-refiner.js";
/** Regex a package.json script NAME must match to be discovered (Fix 1/2). */
export declare const CHECK_SCRIPT_NAME_RE: RegExp;
/**
 * Fix 1: ingest the repo's declared convention files into a char-budgeted list
 * of `{ source, text }`. Over budget, the LONGEST sources are truncated first
 * (with a note) rather than dropping sources silently. Returns `[]` when the
 * repo declares nothing / the root does not exist. Never throws.
 */
export declare function ingestRepoConventions(repoRoot: string, charBudget?: number): RepoConvention[];
/**
 * Enforce the total char budget across all sources. Truncates the LONGEST
 * sources first (each gets an appended note) until the total fits. Never drops
 * a source entirely (it keeps at least a stub) so provenance survives.
 */
export declare function applyCharBudget(conventions: RepoConvention[], charBudget: number): RepoConvention[];
export interface CheckScript {
    name: string;
    command: string;
}
/**
 * Fix 1/2: discover repo-declared check scripts from `package.json#scripts`
 * whose NAME matches {@link CHECK_SCRIPT_NAME_RE}. Returns `[]` when there is
 * no package.json / no matching scripts. Never throws.
 */
export declare function discoverCheckScripts(repoRoot: string): CheckScript[];
export interface CheckScriptResult {
    script: string;
    ran: boolean;
    exitCode: number | null;
    /** Tail of combined stdout+stderr (bounded). */
    outputTail: string;
    /** Non-fatal reason the script was skipped (not on allowlist / unrunnable / timed out). */
    skippedReason?: string;
    /** True when the failure is a network/build limitation (non-fatal note, not a finding). */
    unrunnable?: boolean;
    /**
     * beta.70 (F4): true when the script died of a V8 heap OOM (exit 134 +
     * "Ineffective mark-compacts near heap limit"). Distinct from a real check
     * failure: on Thanos-scale repos `tsc --noEmit` OOMs at the default 4 GB
     * heap (PR #870 burned ~3.5 min crashing). The runner RETRIES ONCE with a
     * larger heap; if it still OOMs this stays true and the caller surfaces it
     * as a BLOCKING failure (a false-green shipped before this fix).
     */
    oom?: boolean;
    /** beta.70 (F4): true when the larger-heap retry was attempted for this script. */
    heapRetried?: boolean;
}
/** beta.70 (F4): V8 heap-OOM signature. exit 134 = SIGABRT; the message is the tell. */
export declare const HEAP_OOM_RE: RegExp;
/**
 * Fix 2: run the repo-declared check scripts, INLINE + BLOCKING, in the
 * worktree. Only scripts whose name is on `allowlist` are run (a discovered
 * script NOT on the list is NEVER run). Each is bounded by `timeoutSeconds`.
 *
 * Classification of a result:
 *   - exitCode === 0            -> ran, pass (no finding).
 *   - exitCode !== 0 (real)     -> ran, FAIL -> caller emits a REVISE-worthy
 *                                   `loop.convention_check_failed` finding.
 *   - timeout / spawn error /   -> `unrunnable: true` (non-fatal note, NOT a
 *     missing-tool signature         finding) per the beta.53 bootstrap lesson.
 *
 * Never throws. `runScript` is injectable for tests (defaults to spawnSync npm).
 */
export declare function runCheckScripts(params: {
    repoRoot: string;
    discovered: CheckScript[];
    allowlist: string[];
    timeoutSeconds: number;
    runScript?: (name: string, cwd: string, timeoutMs: number, heapMb?: number) => {
        status: number | null;
        stdout: string;
        stderr: string;
        error?: unknown;
        timedOut?: boolean;
    };
    /**
     * beta.70 (F4): heap ceiling (MB) applied to the check-script child via
     * NODE_OPTIONS on the RETRY after a heap OOM. Default 8192. The first run
     * uses the repo's own NODE_OPTIONS; the retry forces this.
     */
    heapRetryMb?: number;
}): CheckScriptResult[];
/**
 * Render the repoConventions block for an SDK system prompt. Shared by the
 * lead / worker / adversary prompt builders so all three carry the same text
 * (they get NO OpenClaw context injection). Returns "" when there are none.
 */
export declare function renderConventionsForPrompt(conventions: RepoConvention[] | undefined, role: "lead" | "worker" | "adversary"): string;
//# sourceMappingURL=repo-conventions.d.ts.map