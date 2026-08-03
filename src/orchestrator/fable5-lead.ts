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
  | { kind: "file_written"; path: string; expectedContent?: string; reviseRelaxed?: boolean }  // file on disk, non-empty (beta.9: fs.stat, not git diff). beta.85: reviseRelaxed => accept present+committed-in-branch (see verify.ts).
  | { kind: "commit_made" }                                 // a new commit exists vs base
  // --- beta.9 additions ---
  | { kind: "file_committed"; path: string; reviseRelaxed?: boolean }                // path appears in git log <base>..HEAD. beta.85: reviseRelaxed => a not-targeted revise file passes on present+committed-in-branch.
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
  logger: { info: (m: string, meta?: unknown) => void; warn?: (m: string, meta?: unknown) => void };
  callLeadModel: (
    brief: CrystallisedBrief,
    repos: string[],
    correctiveNote?: string,
  ) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
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
  callWorkerContextModel?: (
    brief: CrystallisedBrief,
    plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">,
    missingSeqs: number[],
  ) => Promise<Array<{ seq: number; workerContext: WorkerContext }>>;
}

/**
 * beta.99 (P0-2): merge bounded top-up contexts into the plan IN PLACE.
 * Only fills seqs that are currently insubstantive, and only when the
 * incoming block is itself substantive -- so a vague top-up can never
 * overwrite context the lead already got right. Returns the seqs merged.
 */
export function mergeWorkerContexts(
  plan: { subTasks: LeadPlanSubTask[] },
  topUp: Array<{ seq: number; workerContext: WorkerContext }>,
): number[] {
  if (!Array.isArray(topUp) || topUp.length === 0) return [];
  const merged: number[] = [];
  for (const entry of topUp) {
    if (!entry || typeof entry.seq !== "number" || !entry.workerContext) continue;
    const target = plan.subTasks.find((st) => st.seq === entry.seq);
    if (!target) continue;
    if (hasSubstantiveWorkerContext(target.workerContext)) continue;
    if (!hasSubstantiveWorkerContext(entry.workerContext)) continue;
    target.workerContext = entry.workerContext;
    merged.push(entry.seq);
  }
  return merged;
}

/**
 * beta.67 (P0a): raised when a plan fails workerContext enforcement AFTER the
 * one bounded lead re-ask. Surfaced as a plan failure -- a loud fail at
 * planning beats another silent workers-no-op'd revise cycle downstream.
 */
export class LeadPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadPlanValidationError";
  }
}

// beta.67 (P0a): minimum length for a changeSpec to count as substantive.
const CHANGESPEC_MIN_CHARS = 40;

// beta.67 (P0a): a changeSpec / excerpt must reference a FILE to be actionable.
// Kills the length-only hole where filler prose passes on length alone.
const PATH_TOKEN_RE = /\S+\.(ts|tsx|js|jsx|py|go|rs|md|json|ya?ml)\b|\S+\/\S+/;

/**
 * beta.67 (P0a): SUBSTANCE check for a sub-task's workerContext -- not mere
 * field presence. rationale non-empty AND (file-anchored changeSpec >=40 chars
 * OR a codeExcerpts entry with a real snippet + path). gotchas/relatedSymbols
 * are optional garnish and do NOT satisfy the gate.
 */
export function hasSubstantiveWorkerContext(wc?: WorkerContext): boolean {
  if (!wc) return false;
  const hasRationale = typeof wc.rationale === "string" && wc.rationale.trim().length > 0;
  if (!hasRationale) return false;
  const changeSpecOk =
    typeof wc.changeSpec === "string" &&
    wc.changeSpec.trim().length >= CHANGESPEC_MIN_CHARS &&
    PATH_TOKEN_RE.test(wc.changeSpec);
  const excerptOk =
    Array.isArray(wc.codeExcerpts) &&
    wc.codeExcerpts.some(
      (e) =>
        !!e &&
        typeof e.snippet === "string" &&
        e.snippet.trim().length > 0 &&
        typeof e.path === "string" &&
        e.path.trim().length > 0,
    );
  return changeSpecOk || excerptOk;
}

// beta.67 (P0a): mutate/mixed MUST carry substantive workerContext; observe is
// exempt. `mixed` is gated same as `mutate` (a mixed sub-task that mutates
// without context is the beta.63/64 failure mode wearing a hat).
const CONTEXT_REQUIRED_MODES = new Set(["mutate", "mixed"]);

/** beta.67 (P0a): seqs of mutate/mixed sub-tasks lacking substantive context. */
export function subTasksMissingWorkerContext(
  plan: { subTasks: LeadPlanSubTask[] },
): number[] {
  return plan.subTasks
    .filter(
      (st) =>
        CONTEXT_REQUIRED_MODES.has(st.taskMode ?? "") &&
        !hasSubstantiveWorkerContext(st.workerContext),
    )
    .map((st) => st.seq);
}

/**
 * beta.94 (Feature 1): mutate-scope verify kinds. A sub-task whose verify
 * carries ANY of these is a real mutation step (writes/commits/pushes), not a
 * pure observation. Used to distinguish a genuinely-empty pure-observe
 * "final scope verification" sub-task from a mutate sub-task.
 */
const MUTATE_VERIFY_KINDS = new Set<SubTaskVerify["kind"]>([
  "file_written",
  "file_committed",
  "commit_made",
  "branch_pushed",
  "file_pushed",
  "pr_opened",
]);

/**
 * beta.94 (Feature 1): heuristic for a scope/boundary "final verification"
 * sub-task -- the b93 seq-12 idle-stall signature. Matches phrasings like
 * "final verification of scope boundaries", "verify nothing outside scope was
 * touched", "confirm scope boundaries".
 */
const SCOPE_VERIFY_DESC_RE = /scope|boundar|final.{0,15}verif|nothing.{0,10}(outside|touched)/i;

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
export function isElidableFinalScopeSubTask(st: LeadPlanSubTask): boolean {
  if (st.taskMode !== "observe") return false;
  const hasMutateVerify =
    Array.isArray(st.verify) && st.verify.some((v) => MUTATE_VERIFY_KINDS.has(v.kind));
  if (hasMutateVerify) return false;
  const text = `${st.title ?? ""} ${st.intent ?? ""} ${(st.successCriteria ?? []).join(" ")}`;
  return SCOPE_VERIFY_DESC_RE.test(text);
}

/**
 * beta.94 (Feature 1a): DROP a trailing pure-observe scope-verification
 * sub-task from the worker plan (the b93 seq-12 idle-prone "final verification
 * of scope boundaries" step). Only the LAST sub-task is a candidate, and only
 * if NOTHING depends on it. Mutates `plan.subTasks` in place and returns the
 * elided sub-task (so the caller can audit `loop.final_verify_subtask_elided`),
 * or `undefined` when nothing was elided. Pure aside from the in-place splice;
 * never throws.
 */
export function elideFinalScopeSubTask(
  plan: { subTasks: LeadPlanSubTask[] },
): { seq: number; title: string } | undefined {
  const subs = plan.subTasks;
  if (!Array.isArray(subs) || subs.length <= 1) return undefined; // never elide the only sub-task
  const last = subs[subs.length - 1]!;
  if (!isElidableFinalScopeSubTask(last)) return undefined;
  // Do not drop if any other sub-task depends on it (topo integrity).
  const dependedOn = subs.some((s) => (s.dependsOn ?? []).includes(last.seq));
  if (dependedOn) return undefined;
  plan.subTasks = subs.slice(0, -1);
  return { seq: last.seq, title: last.title };
}

export async function runLeadPlanner(
  brief: CrystallisedBrief,
  deps: LeadDeps,
): Promise<LeadPlan> {
  // beta.67 (P0a): one BOUNDED re-ask ([initial, one re-ask]); a second
  // insubstantive plan hard-throws so it surfaces as a plan failure.
  // Optional-chain `loop`: some unit-test deps pass a partial config without a
  // `loop` block. Real HarnessConfig always has it; missing -> enforcement on
  // (but a plan with no mutate/mixed sub-tasks trivially passes the gate).
  const enforceContext = deps.config.loop?.enforce_worker_context !== false;
  const maxAttempts = enforceContext ? 2 : 1;
  let raw: Omit<LeadPlan, "worktreePath" | "approxCostUsd"> | undefined;
  let correctiveNote: string | undefined;

  // beta.73 (D2): when the brief carries a `branchHint` that names an EXISTING
  // remote branch (e.g. an open PR's branch) and it is NOT already a pinned
  // revise, promote it to `pinnedBranch`. This is the fix for session
  // 70341bc3: a harness_run brief said `branchHint:
  // harness/grc-changes-export-mode` + "build on the existing branch (PR #876),
  // do not open a new PR", but branchHint is only a NAME hint -- reuse
  // (checkout the branch HEAD) was gated on `pinnedBranch`, which was unset. So
  // the worktree reset to main (whose route.ts lacked the export handler) and
  // the worker had to reconstruct-then-revert it just to verify. Promoting the
  // hint to pinned makes index.ts's `reuseExistingBranch: !!brief.pinnedBranch`
  // check out the branch's own head. Guarded by an existence check so a hint
  // for a NEW branch still creates it fresh (unchanged behaviour). Best-effort:
  // if the check dep is absent or throws, we skip the promotion.
  if (!brief.pinnedBranch && brief.branchHint && deps.remoteBranchExists) {
    try {
      const repoForCheck = brief.repoHint && brief.repoHint.includes("/") ? brief.repoHint : undefined;
      if (repoForCheck && (await deps.remoteBranchExists(repoForCheck, brief.branchHint))) {
        brief.pinnedBranch = brief.branchHint;
        deps.logger.info("[lead] branchHint names an existing remote branch -> promoting to pinned/reuse", {
          branch: brief.branchHint,
          repo: repoForCheck,
        });
      }
    } catch (err) {
      deps.logger.warn?.("[lead] branchHint existence check failed (non-fatal; treating as new branch)", { err: String(err) });
    }
  }

  // beta.99 (P0-1): the LAST plan that parsed AND validated. b98 (session
  // f2613eec) proved why this must exist: lead call #1 returned a perfectly
  // good plan whose only sin was thin workerContext, the b67 gate re-asked for
  // the WHOLE plan with MORE prose, that bigger reply blew the output ceiling,
  // and the resulting throw propagated out of runLeadPlanner -- discarding the
  // valid plan we already held. A run must never die holding a usable plan.
  let lastValid: Omit<LeadPlan, "worktreePath" | "approxCostUsd"> | undefined;
  let lastValidMissing: number[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      raw = await deps.callLeadModel(brief, deps.config.repos.allowed, correctiveNote);
      // beta.44: revise flow. Override the lead branch/repo BEFORE validation.
      if (brief.pinnedBranch) {
        raw.branch = brief.pinnedBranch;
        if (brief.repoHint && brief.repoHint.includes("/")) raw.repo = brief.repoHint;
        deps.logger.info("[lead] revise: branch pinned", { branch: raw.branch, repo: raw.repo, reviseOf: brief.reviseOfSessionId });
      }
      // beta.33: defensively strip push/PR sub-tasks BEFORE validation.
      sanitizeRemoteSubTasks(raw, deps.logger);
      validatePlan(raw, deps.config);
    } catch (err) {
      // beta.99 (P0-1): a FAILED re-ask must not destroy the plan we already
      // banked. Only a failure with nothing banked is terminal.
      if (attempt > 1 && lastValid) {
        deps.logger.warn?.(
          "[lead] workerContext re-ask FAILED; falling back to the previous VALID plan rather than failing the run (beta.99)",
          { err: String(err).slice(0, 300), missingSeqs: lastValidMissing, reviseOf: brief.reviseOfSessionId },
        );
        raw = lastValid;
        break;
      }
      throw err;
    }

    // beta.67 (P0a): workerContext substance gate (mutate/mixed only).
    if (!enforceContext) break;
    const missing = subTasksMissingWorkerContext(raw);
    if (missing.length === 0) break;
    lastValid = raw;
    lastValidMissing = missing;

    if (attempt < maxAttempts) {
      // beta.99 (P0-2): prefer the BOUNDED context top-up -- ask ONLY for the
      // missing workerContext blocks and merge them into the plan we already
      // have. The whole-plan re-ask below is what truncated on b98: its output
      // size is the entire plan PLUS the extra prose, on every retry.
      if (deps.callWorkerContextModel) {
        try {
          const topUp = await deps.callWorkerContextModel(brief, raw, missing);
          const merged = mergeWorkerContexts(raw, topUp);
          const stillMissing = subTasksMissingWorkerContext(raw);
          deps.logger.info("[lead] bounded workerContext top-up applied (beta.99)", {
            requestedSeqs: missing,
            mergedSeqs: merged,
            stillMissing,
          });
          if (stillMissing.length === 0) break;
          // Partial success still shrinks the whole-plan re-ask below.
          lastValidMissing = stillMissing;
        } catch (err) {
          deps.logger.warn?.("[lead] bounded workerContext top-up failed; falling back to whole-plan re-ask", {
            err: String(err).slice(0, 300),
            missingSeqs: missing,
          });
        }
      }
      const stillMissing = subTasksMissingWorkerContext(raw);
      correctiveNote =
        `WORKER CONTEXT REQUIRED: sub-tasks [${stillMissing.join(", ")}] are taskMode mutate/mixed but ` +
        `their workerContext is missing or insubstantive. For EACH of those seqs you MUST provide a ` +
        `workerContext with a non-empty rationale AND concrete file-anchored guidance -- either a ` +
        `changeSpec that names the exact file+location of the edit (>=40 chars, referencing a real ` +
        `path like src/foo/bar.ts) OR a codeExcerpts entry with the actual code you read (with its ` +
        `path). A worker CANNOT implement these correctly from a bare intent; hand down your ` +
        `investigation. If you cannot produce concrete context for a sub-task, it is mis-scoped -- ` +
        `split it into an observe (investigate) step + a mutate (implement) step, or reduce its scope.` +
        // beta.99 (P0-3): the b98 reply blew the output ceiling because this
        // note demands MORE prose with no size bound. Bound it explicitly, and
        // keep it consistent with the truncation-retry instruction so the two
        // can never contradict each other inside one prompt again.
        `\nSIZE LIMIT (HARD): return the COMPLETE plan as ONE closed JSON object. Keep every other field ` +
        `EXACTLY as you already wrote it -- do not re-expand prose elsewhere. Keep each changeSpec under ` +
        `400 characters and include at most ONE short codeExcerpt (<=15 lines) per sub-task. A COMPLETE ` +
        `terse plan is REQUIRED; a richer plan that gets cut off is a FAILED plan.`;
      deps.logger.warn?.("[lead] workerContext insufficient; re-asking lead once", { missingSeqs: stillMissing, reviseOf: brief.reviseOfSessionId });
    } else {
      // beta.99 (P0-1): the gate has now had its bounded re-ask and the plan is
      // STILL thin. Historically this threw and killed the run. A thin-context
      // plan is a DEGRADED plan (workers start colder), not a broken one -- so
      // by default we ship it with a loud warning instead of burning the whole
      // session. Set loop.require_worker_context_strict:true to restore the
      // old hard-fail.
      if (deps.config.loop?.require_worker_context_strict === true) {
        throw new LeadPlanValidationError(
          `lead plan sub-tasks [${missing.join(", ")}] are taskMode mutate/mixed but lack substantive ` +
            `workerContext after one re-ask (rationale + file-anchored changeSpec/excerpt required). ` +
            `Set loop.enforce_worker_context:false to downgrade this to a warning.`,
        );
      }
      deps.logger.warn?.(
        "[lead] workerContext STILL insufficient after the bounded re-ask; proceeding with the degraded plan " +
          "(workers start colder on these seqs). Set loop.require_worker_context_strict:true to hard-fail instead. (beta.99)",
        { missingSeqs: missing, reviseOf: brief.reviseOfSessionId },
      );
    }
  }
  if (!raw) throw new LeadPlanValidationError("lead plan produced no output");
  // beta.67 (P0a): enforcement off -> WARN-only escape hatch (no retry/throw).
  if (!enforceContext) {
    const missing = subTasksMissingWorkerContext(raw);
    if (missing.length > 0) {
      deps.logger.warn?.("[lead] workerContext insufficient (enforcement disabled; not retrying)", { missingSeqs: missing, reviseOf: brief.reviseOfSessionId });
    }
  }
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
