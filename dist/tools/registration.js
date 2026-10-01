import { ControlError } from "../control/service.js";
/** Stable terminal envelope failures. */
export const CONTROL_TERMINAL_CODES = [
    "budget_exceeded",
    "time_exceeded",
    "scope_escalation",
    "path_violation",
    "security_escalation",
    "credential_escalation",
];
/**
 * Readiness is recorded only when state is pr_ready, verdict is pass,
 * blocking === 0, published_sha === pr_head_sha, required_ci and
 * runtime_evidence are present, and spend is inside the budget envelope.
 */
export const CONTROL_READINESS_PREDICATES = "state=pr_ready;verdict=pass;blocking===0;published_sha=pr_head_sha;required_ci;runtime_evidence;spend<=budget_envelope";
/** Trusted host fields include requesterSenderId and conversationId. */
/** Public error vocabulary for trusted boundaries. */
export const CONTROL_CONFIRMATION_DOMAIN = "control-plane-confirm/v2";
export const CONTROL_ATTESTATION_ERRORS = [
    "confirmation_attestation_required", "stale_confirmation", "wrong_actor", "wrong_conversation",
    "already_confirmed", "confirmation_replayed", "merge_attestation_required", "stale_pr_head", "already_merged",
];
const CHANGE_ID_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["changeId"],
    properties: { changeId: { type: "string", pattern: "^chg_[A-Za-z0-9_-]{12,}$" } },
};
const CHANGE_RESULT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["changeId"],
    properties: {
        changeId: { type: "string", pattern: "^chg_[A-Za-z0-9_-]{12,}$" },
        monitorToken: { type: "string", minLength: 32, maxLength: 128, description: "Opaque read-only capability returned with the prepared change. Use it for detached monitoring; it grants no execution or merge authority." },
    },
};
const PREPARE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["request", "repository"],
    properties: {
        request: { type: "string", minLength: 10, maxLength: 100000, description: "The complete natural-language request, preserving every restriction, exclusion, and success condition. This is interpretation input, never execution approval." },
        repository: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$", description: "Canonical owner/name repository inferred from the conversation and authenticated repository context." },
        baseRef: { type: "string", minLength: 1, maxLength: 240 },
        scope: { type: "array", maxItems: 200, description: "Repository-relative paths the user authorized this change to touch.", items: { type: "string", minLength: 1, maxLength: 500 } },
        excludedScope: { type: "array", maxItems: 200, description: "Repository-relative paths or areas the user excluded. Never silently drop a negative instruction.", items: { type: "string", minLength: 1, maxLength: 500 } },
        budgetUsd: { type: "number", exclusiveMinimum: 0, description: "Dollar limit interpreted from the user's words; omit only when the user gave no limit." },
        timeLimitSeconds: { type: "integer", minimum: 60, description: "Active execution duration interpreted from the user's words. Waiting for approval does not consume it." },
    },
};
function toDispose(value) {
    return () => {
        if (typeof value === "function")
            value();
        else if (typeof value?.dispose === "function")
            value.dispose();
        else if (typeof value?.unregister === "function")
            value.unregister();
    };
}
function contextualToolFactory(name, build) {
    const factory = ((context) => build(context ?? {}));
    const fallback = build({});
    const { name: _name, ...metadata } = fallback;
    Object.defineProperty(factory, "name", { value: name, enumerable: true, configurable: true });
    Object.assign(factory, metadata);
    return factory;
}
function invocation(inputOrCallId, paramsOrContext, executionContext) {
    if (typeof inputOrCallId === "string" && paramsOrContext && typeof paramsOrContext === "object") {
        return { input: paramsOrContext, context: (executionContext ?? {}) };
    }
    return { input: (inputOrCallId ?? {}), context: (paramsOrContext ?? executionContext ?? {}) };
}
function trustedConversationId(context) {
    // Use the same canonical route target projected to message_received hooks.
    // In Slack DMs OpenClaw exposes deliveryContext.to as `user:<id>` while
    // nativeChannelId is the transport channel (`D...`); mixing those identities
    // makes a genuine raw-user confirmation impossible to consume.
    return context.deliveryContext?.to?.trim() || context.conversationId?.trim() || context.nativeChannelId?.trim() || undefined;
}
function safeFailure(error) {
    if (error instanceof ControlError)
        return { ok: false, code: error.code, summary: error.message };
    return { ok: false, code: "control_unavailable", summary: "The change service is temporarily unavailable." };
}
function serviceFor(runtime) {
    const service = runtime.controlPlane;
    if (!service)
        throw new ControlError("control_unavailable", "The change service is not available.");
    return service;
}
function tool(name, description, parameters, context, run, runtime, attestedOperation) {
    return {
        name,
        description,
        parameters,
        inputSchema: parameters,
        async execute(inputOrCallId, paramsOrContext, executionContext) {
            try {
                const call = invocation(inputOrCallId, paramsOrContext, executionContext);
                // Only host-captured identity is trusted. The attestation comes solely
                // from the one-shot inbound-event broker; execution/model arguments and
                // invented context fields can never mint or supply it.
                const trusted = {
                    requesterSenderId: context.requesterSenderId,
                    conversationId: trustedConversationId(context),
                    workspaceId: context.workspaceId,
                    trustedControlAttestation: attestedOperation
                        ? runtime.hostTurnAuthorityBroker?.consume(attestedOperation, String(call.input.changeId ?? ""), context)
                        : undefined,
                };
                const actor = trusted.requesterSenderId?.trim() ?? "";
                const delegatedResultRead = name === "harness_change_result" && typeof call.input.monitorToken === "string" && call.input.monitorToken.length >= 32;
                if (runtime.authorisedUsers && !runtime.authorisedUsers.includes(actor) && !delegatedResultRead) {
                    throw new ControlError("unauthorised_requester", "This requester is not authorised to use the change service.");
                }
                return await run(serviceFor(runtime), call.input, trusted);
            }
            catch (error) {
                return safeFailure(error);
            }
        },
    };
}
/**
 * OpenClaw translates ordinary language into typed operations. A confirm or
 * merge tool call is authoritative only when paired with a fresh authenticated
 * user turn captured independently by the host hook.
 */
export function registerHarnessTools(api, runtime) {
    const disposers = [];
    const rt = runtime;
    const definitions = [
        ["harness_prepare_change", (context) => tool("harness_prepare_change", "Translate the user's ordinary-language repository request into one complete typed proposal without starting work. Preserve all restrictions and exclusions; do not ask the user for harness syntax.", PREPARE_SCHEMA, context, async (service, input, trusted) => ({
                ...await service.prepare(input, trusted),
                approval: {
                    mode: "openclaw_conversation",
                    required: true,
                    summary: "Review the proposal in this conversation. Reply naturally; OpenClaw will translate your response into the typed confirmation operation.",
                },
            }), rt)],
        ["harness_confirm_change", (context) => tool("harness_confirm_change", "Use only when the current authenticated user turn clearly approves the exact prepared proposal. OpenClaw interprets the user's ordinary language; this tool cannot run without that fresh host-observed turn.", CHANGE_ID_SCHEMA, context, (service, input, trusted) => service.confirm(String(input.changeId ?? ""), trusted), rt, "confirm_change")],
        ["harness_change_result", (context) => tool("harness_change_result", "Read the safe current or final outcome of a change. For detached monitoring, preserve and supply the opaque read-only token returned by prepare.", CHANGE_RESULT_SCHEMA, context, (service, input, trusted) => service.result(String(input.changeId ?? ""), trusted, typeof input.monitorToken === "string" ? input.monitorToken : undefined), rt)],
        ["harness_merge_change", (context) => tool("harness_merge_change", "Use only when the current authenticated user turn clearly authorizes merging the exact ready pull request. This requires a separate fresh host-observed turn.", CHANGE_ID_SCHEMA, context, (service, input, trusted) => service.merge(String(input.changeId ?? ""), trusted), rt, "merge_change")],
    ];
    for (const [name, build] of definitions) {
        // Function registrations require an explicit name so OpenClaw can bind the
        // declared contract and materialize the factory with live turn context.
        disposers.push(toDispose(api.registerTool(contextualToolFactory(name, build), { name })));
    }
    return () => {
        for (const dispose of disposers.reverse())
            dispose();
    };
}
//# sourceMappingURL=registration.js.map