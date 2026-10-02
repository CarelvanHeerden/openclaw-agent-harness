export interface PlannerCiSuggestion {
    readonly subTaskSeq: number;
    readonly id: string;
    readonly ciCheck?: string;
    readonly command?: string;
}
export declare function plannerCiDiagnostics(tasks: readonly {
    seq: number;
    requiredBehaviorChecks?: readonly {
        id: string;
        ciCheck?: string;
        command?: string;
    }[];
}[]): PlannerCiSuggestion[];
export declare function resolveTrustedCiEvidence(input: {
    policyStatus: "readable" | "denied" | "indeterminate";
    policyChecks: readonly string[];
    observedChecks: readonly string[];
    policyBindings?: readonly {
        context: string;
        appId?: number;
    }[];
    observedBindings?: readonly {
        context: string;
        appId?: number;
    }[];
    explicitChecks?: readonly string[];
    providerState: "success" | "failure" | "pending" | "indeterminate";
}): {
    registered: boolean;
    requiredChecks: string[];
    successfulChecks: string[];
    status: "success" | "failure" | "pending" | "indeterminate";
};
export declare function exactSuccessfulRequiredChecks(trustedSuccessfulChecks: readonly string[], exactSuccessConclusions: readonly string[], requiredBindings?: readonly {
    context: string;
    appId?: number;
}[], exactSuccessBindings?: readonly {
    context: string;
    appId?: number;
}[]): string[];
//# sourceMappingURL=ci-authority.d.ts.map