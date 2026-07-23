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
} | {
    kind: "commit_made";
} | {
    kind: "file_committed";
    path: string;
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
    };
    callLeadModel: (brief: CrystallisedBrief, repos: string[]) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
    allocateWorktree: (repo: string, branch: string) => Promise<string>;
    estimateCost: (plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">) => number;
}
export declare function runLeadPlanner(brief: CrystallisedBrief, deps: LeadDeps): Promise<LeadPlan>;
//# sourceMappingURL=fable5-lead.d.ts.map