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
/**
 * beta.67 (P0a): raised when a plan fails workerContext enforcement AFTER the
 * one bounded lead re-ask. Surfaced as a plan failure -- a loud fail at
 * planning beats another silent workers-no-op'd revise cycle downstream.
 */
export class LeadPlanValidationError extends Error {
    constructor(message) {
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
export function hasSubstantiveWorkerContext(wc) {
    if (!wc)
        return false;
    const hasRationale = typeof wc.rationale === "string" && wc.rationale.trim().length > 0;
    if (!hasRationale)
        return false;
    const changeSpecOk = typeof wc.changeSpec === "string" &&
        wc.changeSpec.trim().length >= CHANGESPEC_MIN_CHARS &&
        PATH_TOKEN_RE.test(wc.changeSpec);
    const excerptOk = Array.isArray(wc.codeExcerpts) &&
        wc.codeExcerpts.some((e) => !!e &&
            typeof e.snippet === "string" &&
            e.snippet.trim().length > 0 &&
            typeof e.path === "string" &&
            e.path.trim().length > 0);
    return changeSpecOk || excerptOk;
}
// beta.67 (P0a): mutate/mixed MUST carry substantive workerContext; observe is
// exempt. `mixed` is gated same as `mutate` (a mixed sub-task that mutates
// without context is the beta.63/64 failure mode wearing a hat).
const CONTEXT_REQUIRED_MODES = new Set(["mutate", "mixed"]);
/** beta.67 (P0a): seqs of mutate/mixed sub-tasks lacking substantive context. */
export function subTasksMissingWorkerContext(plan) {
    return plan.subTasks
        .filter((st) => CONTEXT_REQUIRED_MODES.has(st.taskMode ?? "") &&
        !hasSubstantiveWorkerContext(st.workerContext))
        .map((st) => st.seq);
}
export async function runLeadPlanner(brief, deps) {
    // beta.67 (P0a): one BOUNDED re-ask ([initial, one re-ask]); a second
    // insubstantive plan hard-throws so it surfaces as a plan failure.
    // Optional-chain `loop`: some unit-test deps pass a partial config without a
    // `loop` block. Real HarnessConfig always has it; missing -> enforcement on
    // (but a plan with no mutate/mixed sub-tasks trivially passes the gate).
    const enforceContext = deps.config.loop?.enforce_worker_context !== false;
    const maxAttempts = enforceContext ? 2 : 1;
    let raw;
    let correctiveNote;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        raw = await deps.callLeadModel(brief, deps.config.repos.allowed, correctiveNote);
        // beta.44: revise flow. Override the lead branch/repo BEFORE validation.
        if (brief.pinnedBranch) {
            raw.branch = brief.pinnedBranch;
            if (brief.repoHint && brief.repoHint.includes("/"))
                raw.repo = brief.repoHint;
            deps.logger.info("[lead] revise: branch pinned", { branch: raw.branch, repo: raw.repo, reviseOf: brief.reviseOfSessionId });
        }
        // beta.33: defensively strip push/PR sub-tasks BEFORE validation.
        sanitizeRemoteSubTasks(raw, deps.logger);
        validatePlan(raw, deps.config);
        // beta.67 (P0a): workerContext substance gate (mutate/mixed only).
        if (!enforceContext)
            break;
        const missing = subTasksMissingWorkerContext(raw);
        if (missing.length === 0)
            break;
        if (attempt < maxAttempts) {
            correctiveNote =
                `WORKER CONTEXT REQUIRED: sub-tasks [${missing.join(", ")}] are taskMode mutate/mixed but ` +
                    `their workerContext is missing or insubstantive. For EACH of those seqs you MUST provide a ` +
                    `workerContext with a non-empty rationale AND concrete file-anchored guidance -- either a ` +
                    `changeSpec that names the exact file+location of the edit (>=40 chars, referencing a real ` +
                    `path like src/foo/bar.ts) OR a codeExcerpts entry with the actual code you read (with its ` +
                    `path). A worker CANNOT implement these correctly from a bare intent; hand down your ` +
                    `investigation. If you cannot produce concrete context for a sub-task, it is mis-scoped -- ` +
                    `split it into an observe (investigate) step + a mutate (implement) step, or reduce its scope.`;
            deps.logger.warn?.("[lead] workerContext insufficient; re-asking lead once", { missingSeqs: missing, reviseOf: brief.reviseOfSessionId });
        }
        else {
            throw new LeadPlanValidationError(`lead plan sub-tasks [${missing.join(", ")}] are taskMode mutate/mixed but lack substantive ` +
                `workerContext after one re-ask (rationale + file-anchored changeSpec/excerpt required). ` +
                `Set loop.enforce_worker_context:false to downgrade this to a warning.`);
        }
    }
    if (!raw)
        throw new LeadPlanValidationError("lead plan produced no output");
    // beta.67 (P0a): enforcement off -> WARN-only escape hatch (no retry/throw).
    if (!enforceContext) {
        const missing = subTasksMissingWorkerContext(raw);
        if (missing.length > 0) {
            deps.logger.warn?.("[lead] workerContext insufficient (enforcement disabled; not retrying)", { missingSeqs: missing, reviseOf: brief.reviseOfSessionId });
        }
    }
    const worktreePath = await deps.allocateWorktree(raw.repo, raw.branch);
    const approxCostUsd = deps.estimateCost(raw);
    const plan = { ...raw, worktreePath, approxCostUsd };
    deps.logger.info("[lead] plan", {
        subTaskCount: plan.subTasks.length,
        risk: plan.riskLevel,
        approxCostUsd,
    });
    return plan;
}
function validatePlan(plan, config) {
    if (!plan.repo || !plan.repo.includes("/")) {
        throw new Error(`lead plan repo "${plan.repo}" is not owner/repo`);
    }
    const owner = plan.repo.split("/")[0];
    const inAllowList = config.repos.allowed.some((glob) => {
        if (glob === plan.repo)
            return true;
        if (glob.endsWith("/*") && glob.slice(0, -2) === owner)
            return true;
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
    if (seqs.size !== plan.subTasks.length)
        throw new Error("duplicate sub-task seq numbers");
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
const PUSH_PR_ONLY_RE = /\b(push(ing|es)?\b|open(ing|s)?\s+(a\s+)?(pull request|pr|merge request|mr)|create\s+(a\s+)?(pull request|pr|merge request|mr))\b/i;
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
function sanitizeRemoteSubTasks(plan, logger) {
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
    const dependedOn = new Set();
    for (const st of plan.subTasks)
        for (const d of st.dependsOn ?? [])
            dependedOn.add(d);
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
//# sourceMappingURL=fable5-lead.js.map