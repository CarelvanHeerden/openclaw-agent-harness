import type { LeadPlan, LeadPlanSubTask, ObserveBindingType, ObserveContract } from "./lead.js";
export interface ObserveEvidenceRef {
    path?: string;
    line?: number;
    note?: string;
}
export interface ObserveFinding {
    id: string;
    summary: string;
    evidence: ObserveEvidenceRef[];
}
export interface ObserveBindingResult {
    name: string;
    type: ObserveBindingType;
    value: unknown;
    evidence: ObserveEvidenceRef[];
}
export interface StructuredObserveResult {
    status: "ok" | "blocked";
    findings: ObserveFinding[];
    bindings: ObserveBindingResult[];
    blockers?: string[];
}
export type ObserveValidation = {
    ok: true;
    kind: "satisfied";
    result: StructuredObserveResult;
    bindingsHash: string;
} | {
    ok: false;
    kind: "blocked";
    reason: string;
    result: StructuredObserveResult;
    bindingsHash: string;
    missingRequired: {
        findings: string[];
        bindings: string[];
    };
} | {
    ok: false;
    kind: "invalid_format" | "invalid_schema" | "invalid_evidence";
    reason: string;
};
export declare function parseObserveEnvelope(text: string): unknown;
export declare function renderObserveContractInstructions(contract: ObserveContract): string;
export declare function validateObserveResult(input: {
    finalMessage?: string;
    contract: ObserveContract;
    repoFiles: readonly string[];
    readRepoFile?: (path: string) => string | undefined;
}): ObserveValidation;
export declare function applyObserveBindings(input: {
    plan: LeadPlan;
    producer: LeadPlanSubTask;
    result: StructuredObserveResult;
}): {
    plan: LeadPlan;
    changedConsumers: number[];
    bindingsHash: string;
};
export declare function taskHash(task: LeadPlanSubTask): string;
export declare function loadBearingObserveContractErrors(plan: LeadPlan): string[];
//# sourceMappingURL=observe-contract.d.ts.map