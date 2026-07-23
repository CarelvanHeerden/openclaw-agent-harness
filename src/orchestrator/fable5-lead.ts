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
export type SubTaskVerify =
  // --- beta.8 kinds (kept for backward compat) ---
  | { kind: "branch_pushed"; branch?: string }              // ref exists on origin
  | { kind: "pr_opened"; draft?: boolean }                  // a PR URL was captured
  | { kind: "file_written"; path: string; expectedContent?: string }  // file on disk, non-empty (beta.9: fs.stat, not git diff)
  | { kind: "commit_made" }                                 // a new commit exists vs base
  // --- beta.9 additions ---
  | { kind: "file_committed"; path: string }                // path appears in git log <base>..HEAD
  | { kind: "remote_branch_exists"; branch?: string }      // GET /git/refs/heads/{branch} == 200
  | { kind: "file_pushed"; path: string; branch?: string } // GET /contents/{path}?ref={branch} == 200
  | { kind: "pr_state"; state: "open" | "draft" | "merged" }  // PR exists AND is in given state
  | { kind: "file_in_pr"; path: string; prNumber?: number } // path appears in PR files list
  | { kind: "commit_sha_matches"; branch?: string };       // local HEAD sha == remote branch tip sha

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
  codeExcerpts?: Array<{ path: string; startLine?: number; snippet: string; note?: string }>;
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
  intent: string;                    // what the worker should do
  filesLikelyTouched: string[];      // narrow scope
  successCriteria: string[];         // observable / testable outcomes
  estimatedTokens: number;           // rough cost forecast
  dependsOn?: number[];              // seq numbers this depends on
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
  repo: string;                      // owner/repo
  branch: string;                    // harness/<slug>-<shortid>
  worktreePath: string;              // absolute local path
  subTasks: LeadPlanSubTask[];
  reviewChecklist: string[];         // items adversary must verify
  riskLevel: "low" | "medium" | "high";
  approxCostUsd: number;             // sum of estimatedTokens converted via price table
}

export interface LeadDeps {
  config: HarnessConfig;
  logger: { info: (m: string, meta?: unknown) => void };
  callLeadModel: (brief: CrystallisedBrief, repos: string[]) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
  allocateWorktree: (repo: string, branch: string) => Promise<string>;
  estimateCost: (plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">) => number;
}

export async function runLeadPlanner(
  brief: CrystallisedBrief,
  deps: LeadDeps,
): Promise<LeadPlan> {
  const raw = await deps.callLeadModel(brief, deps.config.repos.allowed);
  // beta.44: revise flow. When the brief pins a branch (a revise of a prior
  // shipped session), the plan MUST build on that exact branch so new commits
  // stack on the existing PR head and the SAME PR updates. Override the lead's
  // (slugified/rewritten) branch + repo verbatim BEFORE validation so the
  // worktree is allocated on the existing branch, not a fresh one. repoHint on
  // a revise brief is authoritative (it came from the prior session's repo).
  if (brief.pinnedBranch) {
    raw.branch = brief.pinnedBranch;
    if (brief.repoHint && brief.repoHint.includes("/")) raw.repo = brief.repoHint;
    deps.logger.info("[lead] revise: branch pinned", { branch: raw.branch, repo: raw.repo, reviseOf: brief.reviseOfSessionId });
  }
  // beta.33: defensively strip push/PR sub-tasks BEFORE validation. The lead
  // prompt forbids them, but LLMs are non-deterministic. Push + PR are the
  // harness endgame's exclusive job (pushBranchAndOpenPr, post-review). A
  // worker cannot push, so any push/PR sub-task would fail verification and
  // abort the run before review. Coerce here so a stray remote sub-task can
  // never kill an otherwise-good plan. (Belt-and-braces to the prompt fix.)
  sanitizeRemoteSubTasks(raw, deps.logger);
  validatePlan(raw, deps.config);
  const worktreePath = await deps.allocateWorktree(raw.repo, raw.branch);
  const approxCostUsd = deps.estimateCost(raw);
  const plan: LeadPlan = { ...raw, worktreePath, approxCostUsd };
  deps.logger.info("[lead] plan", {
    subTaskCount: plan.subTasks.length,
    risk: plan.riskLevel,
    approxCostUsd,
  });
  return plan;
}

function validatePlan(
  plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">,
  config: HarnessConfig,
): void {
  if (!plan.repo || !plan.repo.includes("/")) {
    throw new Error(`lead plan repo "${plan.repo}" is not owner/repo`);
  }
  const owner = plan.repo.split("/")[0]!;
  const inAllowList = config.repos.allowed.some((glob) => {
    if (glob === plan.repo) return true;
    if (glob.endsWith("/*") && glob.slice(0, -2) === owner) return true;
    return false;
  });
  if (!inAllowList) {
    throw new Error(`lead plan repo "${plan.repo}" is not in the allow-list ${JSON.stringify(config.repos.allowed)}`);
  }
  if (!plan.branch.startsWith("harness/")) {
    throw new Error(`lead plan branch "${plan.branch}" must start with "harness/"`);
  }
  if (plan.subTasks.length === 0) {
    throw new Error("lead plan has zero sub-tasks");
  }
  if (plan.subTasks.length > 20) {
    throw new Error(`lead plan has ${plan.subTasks.length} sub-tasks; hard cap is 20`);
  }
  const seqs = new Set(plan.subTasks.map((s) => s.seq));
  if (seqs.size !== plan.subTasks.length) throw new Error("duplicate sub-task seq numbers");
}

// beta.33: remote verify kinds a worker can never satisfy (the harness pushes
// + opens the PR itself, after review). Any of these on a sub-task means the
// lead planned a push/PR step, which always failed and aborted the run.
const REMOTE_VERIFY_KINDS = new Set([
  "branch_pushed",
  "remote_branch_exists",
  "file_pushed",
  "pr_opened",
  "pr_state",
  "file_in_pr",
  "commit_sha_matches",
]);

// Push/PR-only intent (no file/commit work) — used to decide if a sub-task is
// purely a (now-forbidden) push/PR step that can be safely dropped.
const PUSH_PR_ONLY_RE =
  /\b(push(ing|es)?\b|open(ing|s)?\s+(a\s+)?(pull request|pr|merge request|mr)|create\s+(a\s+)?(pull request|pr|merge request|mr))\b/i;
const LOCAL_WORK_RE = /\b(write|edit|modify|add|remove|delete|update|commit|refactor|rename|create\s+file|implement|fix|change)\b/i;

/**
 * beta.33: neutralise push/PR sub-tasks the lead emitted despite the prompt.
 *
 * - Strip all remote verify kinds and force `contractScope: 'local'` on every
 *   sub-task (the harness verifies/pushes remotely, not the worker).
 * - If a sub-task, after stripping, is PURELY a push/PR step (intent matches
 *   push/PR language and has no local-work language) AND nothing depends on
 *   it, drop it entirely — it's redundant with the harness endgame.
 * - Otherwise keep it as a local sub-task with the remote checks removed, so
 *   it can't fail on a remote 404.
 *
 * Mutates `plan` in place. Best-effort + logged; never throws.
 */
function sanitizeRemoteSubTasks(
  plan: { subTasks: LeadPlanSubTask[] },
  logger: { info: (m: string, meta?: unknown) => void },
): void {
  let strippedKinds = 0;
  let coercedScope = 0;
  for (const st of plan.subTasks) {
    // beta.56 (P0-4): coerce to 'local' even when contractScope is ABSENT.
    // The beta.33 sanitiser only rewrote an explicit non-local scope, so a
    // sub-task with no contractScope and no explicit verify fell through to
    // regex inference, which can still infer branch_pushed/pr_opened from
    // ambient wording ("commit so it can be pushed") -- checks a worker can
    // never satisfy. Workers are structurally local-only (the harness pushes
    // after review), so 'local' is always correct here.
    if (st.contractScope !== "local") {
      st.contractScope = "local";
      coercedScope++;
    }
    if (Array.isArray(st.verify) && st.verify.length > 0) {
      const before = st.verify.length;
      st.verify = st.verify.filter((v) => !REMOTE_VERIFY_KINDS.has(v.kind));
      strippedKinds += before - st.verify.length;
    }
  }

  // Identify pure push/PR-only sub-tasks that are safe to drop (nothing
  // depends on them). Do NOT drop if a dependency points at them, to avoid
  // breaking the topo order — just leave them neutralised (local, no remote
  // verify) so the worker no-ops harmlessly.
  const dependedOn = new Set<number>();
  for (const st of plan.subTasks) for (const d of st.dependsOn ?? []) dependedOn.add(d);
  const droppable = plan.subTasks.filter((st) => {
    const text = `${st.title} ${st.intent} ${(st.successCriteria ?? []).join(" ")}`;
    const pushPrOnly = PUSH_PR_ONLY_RE.test(text) && !LOCAL_WORK_RE.test(text);
    const noVerify = !st.verify || st.verify.length === 0;
    return pushPrOnly && noVerify && !dependedOn.has(st.seq);
  });
  if (droppable.length > 0 && droppable.length < plan.subTasks.length) {
    const dropSeqs = new Set(droppable.map((s) => s.seq));
    plan.subTasks = plan.subTasks.filter((s) => !dropSeqs.has(s.seq));
    logger.info("[lead] beta.33: dropped push/PR-only sub-task(s) (harness pushes after review)", {
      dropped: [...dropSeqs],
    });
  }

  if (strippedKinds > 0 || coercedScope > 0) {
    logger.info("[lead] beta.33: neutralised remote verify on sub-tasks", {
      strippedRemoteKinds: strippedKinds,
      coercedToLocal: coercedScope,
    });
  }

  // beta.57 (P1): the lead prompt now REQUIRES explicit verify + taskMode on
  // every sub-task. Tolerate omissions (regex inference remains the safety
  // net) but surface them loudly so prompt regressions are visible in ops
  // logs instead of silently degrading to inference.
  const missingVerify = plan.subTasks.filter((st) => !Array.isArray(st.verify)).map((st) => st.seq);
  const missingMode = plan.subTasks.filter((st) => !st.taskMode).map((st) => st.seq);
  if (missingVerify.length > 0 || missingMode.length > 0) {
    logger.info("[lead] beta.57: plan omitted explicit verify/taskMode on sub-task(s); falling back to inference", {
      missingVerify,
      missingTaskMode: missingMode,
    });
  }
}
