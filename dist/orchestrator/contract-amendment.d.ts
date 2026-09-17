import type { LeadPlan, LeadPlanSubTask } from "./lead.js";
export declare const CONTRACT_AMENDMENT_VERSION = "contract-amendment/2026-09-rc.11";
export interface ArtifactSubstitution {
    oldPath: string;
    newPaths: string[];
    prohibitionText?: string;
}
export interface ContractAmendment {
    id: string;
    version: string;
    basePlanHash: string;
    baseTaskHash: string;
    originalTask: LeadPlanSubTask;
    revisedTask: LeadPlanSubTask;
    substitution: ArtifactSubstitution;
    changedFields: string[];
}
export type ContractAmendmentResult = {
    ok: true;
    amendment: ContractAmendment;
} | {
    ok: false;
    reason: string;
    proposedDiff?: string;
};
/**
 * Transform only an explicit one-artifact substitution.
 *
 * The operator's prose authorises the old/new artifact set. The transformer,
 * not a model, performs the change; anything outside this shape stays paused.
 */
export declare function buildArtifactSubstitutionAmendment(input: {
    plan: LeadPlan;
    task: LeadPlanSubTask;
    answer: string;
    blockedPaths: readonly string[];
    id?: string;
}): ContractAmendmentResult;
export declare function activateTaskAmendment(plan: LeadPlan, amendment: ContractAmendment): LeadPlan;
export declare function planHash(plan: LeadPlan): string;
//# sourceMappingURL=contract-amendment.d.ts.map