export function plannerCiDiagnostics(tasks) {
    return tasks.flatMap((task) => (task.requiredBehaviorChecks ?? [])
        .filter((check) => typeof check.ciCheck === "string" && check.ciCheck.trim().length > 0)
        .map((check) => ({
        subTaskSeq: task.seq,
        id: check.id,
        ciCheck: check.ciCheck.trim(),
        ...(check.command?.trim() ? { command: check.command.trim() } : {}),
    })));
}
export function resolveTrustedCiEvidence(input) {
    const observedChecks = [...new Set(input.observedChecks.map((name) => name.trim()).filter(Boolean))];
    const policyChecks = [...new Set(input.policyChecks.map((name) => name.trim()).filter(Boolean))];
    const explicitChecks = [...new Set((input.explicitChecks ?? []).map((name) => name.trim()).filter(Boolean))];
    const observedBindings = (input.observedBindings ?? observedChecks.map((context) => ({ context })))
        .filter((binding) => binding.context.trim())
        .map((binding) => ({ context: binding.context.trim(), ...("appId" in binding && Number.isSafeInteger(binding.appId) && binding.appId > 0 ? { appId: binding.appId } : {}) }));
    const policyBindings = (input.policyBindings ?? policyChecks.map((context) => ({ context })))
        .filter((binding) => binding.context.trim())
        .map((binding) => ({ context: binding.context.trim(), ...("appId" in binding && Number.isSafeInteger(binding.appId) && binding.appId > 0 ? { appId: binding.appId } : {}) }));
    const requiredBindings = [
        ...(policyBindings.length > 0 ? policyBindings : explicitChecks.length > 0 ? [] : observedBindings),
        ...explicitChecks.map((context) => ({ context })),
    ];
    const requiredChecks = [...new Set(requiredBindings.map((binding) => binding.context))];
    const successfulChecks = input.providerState === "success"
        ? [...new Set(requiredBindings
                .filter((required) => observedBindings.some((observed) => observed.context === required.context && (required.appId === undefined || observed.appId === required.appId)))
                .map((binding) => binding.context))]
        : [];
    const status = input.policyStatus !== "readable" ? "indeterminate"
        : input.providerState === "failure" ? "failure"
            : input.providerState === "pending" ? "pending"
                : input.providerState === "success" && requiredBindings.length > 0 &&
                    requiredBindings.every((required) => observedBindings.some((observed) => observed.context === required.context && (required.appId === undefined || observed.appId === required.appId))) ? "success"
                    : "indeterminate";
    return {
        registered: input.policyStatus === "readable" && requiredChecks.length > 0,
        requiredChecks,
        successfulChecks,
        status,
    };
}
//# sourceMappingURL=ci-authority.js.map