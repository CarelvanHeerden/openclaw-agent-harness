/**
 * rc.10 (F3) -- does this plan require a write the safety policy will refuse?
 *
 * Client Offboarding smoke test, 15 September 2026. Sub-task 3 required
 * `.env.example`. The effective denylist contains `.env.*`, no exception was
 * configured, and nothing compared the two until a worker had already been
 * dispatched. Audit 5598 records the denial on the first attempt; after an
 * operator correction that changed the test path but not the policy, audit 5619
 * records the identical denial on the second. Between them the run spent
 * $1.62978 on sub-task 3, of which the final $0.4262756 bought a retry of work
 * that unchanged policy could only refuse again.
 *
 * The plan and the policy are both known before a single token is spent. This
 * compares them.
 *
 * DELIBERATELY ADVISORY ABOUT WHAT IT FINDS, STRICT ABOUT WHAT IT CLAIMS.
 * `filesLikelyTouched` is the lead's guess, so a conflict here is evidence that
 * a sub-task is heading for a wall, not proof that it must fail -- the worker
 * may satisfy the sub-task without touching the path at all. The caller decides
 * what to do; this module only reports, names the rule, and never mutates a
 * plan. It is pure: no fs, no git, no config lookup of its own.
 */
export interface PlanPolicyConflict {
    seq: number;
    title: string;
    /** The planned path, as the plan wrote it. */
    path: string;
    /** The denylist entry that will refuse it. */
    rule: string;
    /**
     * True when an explicit `safety.path_denylist_exceptions` entry already
     * authorises this exact path, in which case there is no conflict to report.
     * Retained on the type so the caller can audit near-misses if it wants to.
     */
    authorised: boolean;
}
export interface PlanPolicyConflictInput {
    seq: number;
    title?: string;
    filesLikelyTouched?: string[] | null;
}
/**
 * Every planned write the effective policy would refuse.
 *
 * Mirrors the guard's own predicates rather than re-implementing them:
 * `denylistRuleFor` is the same function the ACP guard consults, and the
 * exception check is the same `templateExceptionApplies`. If those two ever
 * disagree with this, the bug is one function and not two policies.
 */
export declare function findPlanPolicyConflicts(subTasks: readonly PlanPolicyConflictInput[] | undefined, denylist: readonly string[], exceptions?: readonly string[]): PlanPolicyConflict[];
/**
 * The decision to put to an operator, before the money is spent.
 *
 * Names the rule, the path and the sub-task, and asks for the one thing that
 * can actually resolve it. What it must not do is what the incident's
 * clarification did: describe a policy conflict as if the worker had made a
 * mistake about where a file goes.
 */
export declare function describePlanPolicyConflicts(conflicts: readonly PlanPolicyConflict[]): string;
//# sourceMappingURL=plan-policy-conflict.d.ts.map