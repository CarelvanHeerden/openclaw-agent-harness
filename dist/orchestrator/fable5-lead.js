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
export async function runLeadPlanner(brief, deps) {
    const raw = await deps.callLeadModel(brief, deps.config.repos.allowed);
    // beta.44: revise flow. When the brief pins a branch (a revise of a prior
    // shipped session), the plan MUST build on that exact branch so new commits
    // stack on the existing PR head and the SAME PR updates. Override the lead's
    // (slugified/rewritten) branch + repo verbatim BEFORE validation so the
    // worktree is allocated on the existing branch, not a fresh one. repoHint on
    // a revise brief is authoritative (it came from the prior session's repo).
    if (brief.pinnedBranch) {
        raw.branch = brief.pinnedBranch;
        if (brief.repoHint && brief.repoHint.includes("/"))
            raw.repo = brief.repoHint;
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