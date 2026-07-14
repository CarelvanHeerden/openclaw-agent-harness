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
//# sourceMappingURL=fable5-lead.js.map