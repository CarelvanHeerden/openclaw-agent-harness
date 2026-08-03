/**
 * Fable-5 lead.
 *
 * Given a crystallised brief, produces:
 *   - a sub-task decomposition (ordered list of atomic units of work)
 *   - a risk assessment used to size the review effort
 *   - an initial repo/branch plan (repo name, branch name, worktree path)
 *
 * The lead never writes code itself. It only plans and delegates. It also
 * writes a "review checklist" that the adversary consumes on cycle N.
 */
import type { HarnessConfig } from "../config.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
/**
 * Observable side-effect a sub-task is expected to produce. The harness
 * verifies these AFTER the SDK reports `end_turn`, so a worker that
 * confabulates "done" without actually pushing / opening a PR / editing a
 * file is caught and the sub-task is marked `failed` instead of `completed`.
 *
 * beta.7 fix #1: the SDK's stop reason is no longer accepted as ground truth
 * for tasks with observable outputs.
 *
 * beta.9: split `file_written` into precise workspace-level vs git-level vs
 * remote-level contract kinds. `file_written` now uses `fs.stat` (includes
 * untracked files); old `branch_pushed` / `commit_made` / `pr_opened` kept
 * for backward compat alongside new precise kinds.
 */
export type SubTaskVerify = {
    kind: "branch_pushed";
    branch?: string;
} | {
    kind: "pr_opened";
    draft?: boolean;
} | {
    kind: "file_written";
    path: string;
    expectedContent?: string;
    reviseRelaxed?: boolean;
} | {
    kind: "commit_made";
} | {
    kind: "file_committed";
    path: string;
    reviseRelaxed?: boolean;
} | {
    kind: "remote_branch_exists";
    branch?: string;
} | {
    kind: "file_pushed";
    path: string;
    branch?: string;
} | {
    kind: "pr_state";
    state: "open" | "draft" | "merged";
} | {
    kind: "file_in_pr";
    path: string;
    prNumber?: number;
} | {
    kind: "commit_sha_matches";
    branch?: string;
};
/**
 * beta.14: authoritative scope declaration on each sub-task.
 *
 * The regex-based inference in `verify-contract.ts` has proved fragile
 * (beta.11 dedupe, beta.12 negation, beta.13 absence-assertion — all
 * whack-a-mole on the same class of "NLP-derived contract" bugs). The
 * lead planner ALREADY understands scope conceptually: it writes phrases
 * like "local-scope contract kinds" in its plan. Promote scope to a
 * first-class field so the model tells us directly.
 *
 * Semantics:
 * - `local`  → sub-task only touches the local worktree (write files,
 *              commit, verify local state). All remote-scope contract
 *              kinds (branch_pushed, remote_branch_exists,
 *              commit_sha_matches, pr_opened, pr_state, file_pushed,
 *              file_in_pr) are suppressed regardless of ambient wording.
 * - `remote` → sub-task pushes / opens PRs / interacts with the remote.
 *              Regex inference applies as before.
 * - `mixed`  → both local and remote operations in the same sub-task.
 *              Full inference applies (rare; lead should decompose
 *              instead if possible).
 *
 * Absent = fallback to beta.13 inference (negation-aware + absence-
 * assertion gating). Backward compatible with plans from beta.10–beta.13.
 */
export type ContractScope = "local" | "remote" | "mixed";
/**
 * beta.15: authoritative task-mode declaration.
 *
 * The beta.14 `contractScope` field closed the local/remote scope class.
 * The beta.14 happy-path smoke exposed a second scope class: observation
 * vs mutation. A pure observation sub-task ("verify local state, do not
 * mutate") had `commit_made` and `file_committed` inferred, then failed
 * verification because the observation-only worker (correctly) produced
 * no new commit. Same architectural pattern as beta.14: instead of
 * inferring the scope from NLP heuristics, ask the lead directly.
 *
 * Semantics:
 * - `observe` → sub-task is read-only. It does NOT produce new commits,
 *              files, pushes, or PRs. All mutation-scope contract kinds
 *              (file_written, commit_made, file_committed, branch_pushed,
 *              file_pushed, pr_opened) are suppressed. Only pure-state
 *              kinds may fire (remote_branch_exists, commit_sha_matches,
 *              pr_state, file_in_pr) — and even those only if the sub-task
 *              is asserting they DO exist, not that they do NOT.
 * - `mutate` → sub-task produces new artifacts. Full inference; matches
 *              beta.14 behaviour.
 * - `mixed`  → both observation and mutation. Rare; full inference.
 * - absent   → fallback to beta.14 inference (backward compat).
 *
 * Composition with `contractScope`: the two axes are orthogonal.
 *   contractScope=local,  taskMode=observe  → zero remote, zero mutation. Purest read-only local check.
 *   contractScope=local,  taskMode=mutate   → local writes/commits, no remote.
 *   contractScope=remote, taskMode=observe  → remote read-only (check state of remote things).
 *   contractScope=remote, taskMode=mutate   → push + PR + create commit.
 */
export type TaskMode = "observe" | "mutate" | "mixed";
/**
 * beta.66 (warm-worker-context): Fable's investigation handed forward to the
 * dev worker. THIS is the harness's founding goal (the ClaudeDevs
 * orchestrator-split): a smart, expensive lead investigates deeply, then hands
 * a CHEAP worker everything it needs to implement WITHOUT re-exploring the
 * repo. Without this, every worker starts cold and re-derives what Fable
 * already knew, burning tokens and forcing us onto opus workers.
 *
 * Optional + additive (same discipline as verify/contractScope/taskMode):
 * absent = the pre-beta.66 cold behaviour.
 *
 * HARD BOUNDARY: warm context flows lead -> DEV-WORKER ONLY. The adversary
 * (fable5-adversary.ts) stays cold + independent and NEVER receives this.
 */
export interface WorkerContext {
    /**
     * Fable's plain-language explanation of WHY this change is needed and HOW it
     * should be shaped -- the reasoning behind the ticket, not just the outcome.
     */
    rationale: string;
    /**
     * Verbatim code excerpts Fable actually read, with file+line anchors, so the
     * worker does not re-open and re-scan the repo to re-find them.
     */
    codeExcerpts?: Array<{
        path: string;
        startLine?: number;
        snippet: string;
        note?: string;
    }>;
    /**
     * The precise, low-ambiguity change instruction, e.g. "in useTaxonomy() at
     * src/hooks/useTaxonomy.ts:41, replace the hardcoded LABELS map with a call
     * to getTaxonomyOptions() from src/lib/taxonomy-options.ts".
     */
    changeSpec?: string;
    /**
     * Gotchas SPECIFIC to this sub-task (distinct from repo-wide repoConventions),
     * e.g. "React 19.2.7 has no React.act; use renderToStaticMarkup for component
     * tests in this repo".
     */
    gotchas?: string[];
    /**
     * Related symbols/functions the worker needs but might not easily find,
     * e.g. "getTaxonomyOptions is exported from src/lib/taxonomy-options.ts:12".
     */
    relatedSymbols?: string[];
}
export interface LeadPlanSubTask {
    seq: number;
    title: string;
    intent: string;
    filesLikelyTouched: string[];
    successCriteria: string[];
    estimatedTokens: number;
    dependsOn?: number[];
    /**
     * Observable side-effects to verify after the worker's SDK turn ends.
     * When present and any check fails, the sub-task is FAILED regardless of
     * the SDK stop reason. Absent/empty = trust the SDK signal (pure-reasoning
     * or advisory sub-tasks with no observable output).
     */
    verify?: SubTaskVerify[];
    /**
     * beta.14: authoritative scope declaration. When present, filters the
     * inferred contract kinds to matching scope. `local` blocks all remote
     * kinds even when ambient wording matches PUSH_RE / PR_RE / etc.
     *
     * Precedence: explicit `verify` overrides everything. `contractScope`
     * filters. Absent = beta.13 inference behaviour.
     */
    contractScope?: ContractScope;
    /**
     * beta.15: authoritative task-mode declaration. When `observe`, filters
     * out mutation-scope kinds (file_written, commit_made, file_committed,
     * branch_pushed, file_pushed, pr_opened) from the inferred contract.
     * Orthogonal to `contractScope`.
     *
     * Precedence: explicit `verify` overrides everything. `taskMode` and
     * `contractScope` filters compose (both apply). Absent = beta.14
     * behaviour (no mutation-scope filtering).
     */
    taskMode?: TaskMode;
    /**
     * beta.66 (warm-worker-context): Fable's investigation handed forward so the
     * (cheaper) dev worker implements mechanically instead of re-exploring the
     * repo. Optional; absent = cold behaviour. Dev workers ONLY -- never the
     * adversary. See WorkerContext.
     */
    workerContext?: WorkerContext;
    /**
     * beta.91 (Fix 3): optional lead hint that this sub-task is mechanical
     * scaffolding (prisma model, migration, sidebar entry, barrel export) vs
     * standard/complex judgment work. When `mechanical` AND models.worker_mechanical
     * is configured, the sub-task dispatches on the cheaper/faster model. Absent =
     * a conservative heuristic decides (defaults to the strong worker model when
     * in doubt). Never affects the lead or adversary.
     */
    complexity?: "mechanical" | "standard" | "complex";
}
export interface LeadPlan {
    repo: string;
    branch: string;
    worktreePath: string;
    subTasks: LeadPlanSubTask[];
    reviewChecklist: string[];
    riskLevel: "low" | "medium" | "high";
    approxCostUsd: number;
}
export interface LeadDeps {
    config: HarnessConfig;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn?: (m: string, meta?: unknown) => void;
    };
    callLeadModel: (brief: CrystallisedBrief, repos: string[], correctiveNote?: string) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
    allocateWorktree: (repo: string, branch: string) => Promise<string>;
    estimateCost: (plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">) => number;
    /**
     * beta.73 (D2): best-effort check whether `branch` already exists on origin
     * for `repoFullName`. Used to promote a `branchHint` that names an existing
     * open-PR branch into pinned/reuse behaviour so the worktree checks out that
     * branch's HEAD (not main). Optional; when absent the promotion is skipped
     * (behaviour reverts to pre-beta.73 -- branchHint is a name hint only).
     */
    remoteBranchExists?: (repoFullName: string, branch: string) => Promise<boolean>;
    /**
     * beta.99 (P0-2): BOUNDED workerContext top-up. Asks the lead for ONLY the
     * `workerContext` blocks of the named seqs -- not the whole plan again.
     *
     * The b67 whole-plan re-ask is what killed b98: its reply must restate every
     * sub-task AND add more prose, so its size grows with the plan and reliably
     * breaches the output ceiling on a large brief. This call's output size is
     * bounded by `missingSeqs.length` instead, and the plan we already validated
     * is never put at risk.
     *
     * Optional: when absent (or when it throws) the caller falls back to the
     * whole-plan re-ask, so behaviour degrades to pre-beta.99 rather than
     * breaking.
     */
    callWorkerContextModel?: (brief: CrystallisedBrief, plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">, missingSeqs: number[]) => Promise<Array<{
        seq: number;
        workerContext: WorkerContext;
    }>>;
}
/**
 * beta.99 (P0-2): merge bounded top-up contexts into the plan IN PLACE.
 * Only fills seqs that are currently insubstantive, and only when the
 * incoming block is itself substantive -- so a vague top-up can never
 * overwrite context the lead already got right. Returns the seqs merged.
 */
export declare function mergeWorkerContexts(plan: {
    subTasks: LeadPlanSubTask[];
}, topUp: Array<{
    seq: number;
    workerContext: WorkerContext;
}>): number[];
/**
 * beta.67 (P0a): raised when a plan fails workerContext enforcement AFTER the
 * one bounded lead re-ask. Surfaced as a plan failure -- a loud fail at
 * planning beats another silent workers-no-op'd revise cycle downstream.
 */
export declare class LeadPlanValidationError extends Error {
    constructor(message: string);
}
/**
 * beta.67 (P0a): SUBSTANCE check for a sub-task's workerContext -- not mere
 * field presence. rationale non-empty AND (file-anchored changeSpec >=40 chars
 * OR a codeExcerpts entry with a real snippet + path). gotchas/relatedSymbols
 * are optional garnish and do NOT satisfy the gate.
 */
export declare function hasSubstantiveWorkerContext(wc?: WorkerContext): boolean;
/** beta.67 (P0a): seqs of mutate/mixed sub-tasks lacking substantive context. */
export declare function subTasksMissingWorkerContext(plan: {
    subTasks: LeadPlanSubTask[];
}): number[];
/**
 * beta.94 (Feature 1): is `st` a TRAILING PURE-OBSERVE scope-verification
 * sub-task that can be safely elided?
 *
 *   - taskMode === "observe" (explicitly read-only), AND
 *   - it declares NO mutate verify kind (nothing to write/commit/push), AND
 *   - its title/intent/successCriteria match SCOPE_VERIFY_DESC_RE.
 *
 * Such a sub-task has nothing to produce, so a worker can go IDLE on it
 * indefinitely while adding zero signal: every prior mutate sub-task already
 * passed strict per-file contract verification, and runFinalVerifyChecks runs
 * the repo convention scripts deterministically. Pure/deterministic.
 */
export declare function isElidableFinalScopeSubTask(st: LeadPlanSubTask): boolean;
/**
 * beta.94 (Feature 1a): DROP a trailing pure-observe scope-verification
 * sub-task from the worker plan (the b93 seq-12 idle-prone "final verification
 * of scope boundaries" step). Only the LAST sub-task is a candidate, and only
 * if NOTHING depends on it. Mutates `plan.subTasks` in place and returns the
 * elided sub-task (so the caller can audit `loop.final_verify_subtask_elided`),
 * or `undefined` when nothing was elided. Pure aside from the in-place splice;
 * never throws.
 */
export declare function elideFinalScopeSubTask(plan: {
    subTasks: LeadPlanSubTask[];
}): {
    seq: number;
    title: string;
} | undefined;
export declare function runLeadPlanner(brief: CrystallisedBrief, deps: LeadDeps): Promise<LeadPlan>;
//# sourceMappingURL=fable5-lead.d.ts.map