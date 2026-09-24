import { createHash } from "node:crypto";
import { posix } from "node:path";
import { SAFE_AUTHORITY_ACTIONS } from "./types.js";
const digestPattern = /^[a-f0-9]{64}$/;
const prohibitedActions = new Set([
    "merge",
    "merge_pull_request",
    "push_default_branch",
    "credential_change",
    "security_bypass",
    "irreversible_side_effect",
]);
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
export function authorityEnvelopeDigest(envelope) {
    return createHash("sha256").update(stable(envelope)).digest("hex");
}
function cleanPath(path) {
    const replaced = path.replaceAll("\\", "/").replace(/^\.\//, "");
    const normalized = posix.normalize(replaced);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/"))
        return null;
    return normalized;
}
function pathWithin(path, root) {
    const candidate = cleanPath(path);
    const scopeRoot = cleanPath(root);
    return candidate !== null && scopeRoot !== null && (candidate === scopeRoot || candidate.startsWith(`${scopeRoot}/`));
}
function terminate(reason) {
    return Object.freeze({ outcome: "terminate", reason });
}
export function createAuthorityEnvelope(input) {
    if (input.version !== 1)
        throw new Error("Unsupported authority envelope version");
    for (const [name, value] of Object.entries({ requesterId: input.requesterId, conversationId: input.conversationId, repository: input.repository, baseRef: input.baseRef, nonce: input.nonce })) {
        if (!value.trim())
            throw new Error(`Authority envelope ${name} is required`);
    }
    if (!digestPattern.test(input.briefDigest) || !digestPattern.test(input.policyDigest))
        throw new Error("Authority digests must be lowercase SHA-256 values");
    if (input.expiresAt <= input.issuedAt)
        throw new Error("Authority envelope expiry must follow issuance");
    if (input.scope.paths.length === 0 || input.scope.paths.some((path) => cleanPath(path) === null))
        throw new Error("Authority scope paths must be relative and non-empty");
    if (input.allowedActions.length === 0 || input.allowedActions.some((action) => !SAFE_AUTHORITY_ACTIONS.includes(action) || prohibitedActions.has(action)))
        throw new Error("Authority envelope contains an unsafe action");
    const limits = input.limits;
    if (![limits.budgetUsd, limits.activeTimeMs, limits.cycles, limits.retries].every(Number.isFinite) || limits.budgetUsd < 0 || limits.activeTimeMs < 0 || limits.cycles < 0 || limits.retries < 0)
        throw new Error("Authority limits must be finite and non-negative");
    return Object.freeze({
        ...input,
        scope: Object.freeze({ paths: Object.freeze([...new Set(input.scope.paths.map((path) => cleanPath(path)))]) }),
        allowedActions: Object.freeze([...new Set(input.allowedActions)]),
        limits: Object.freeze({ ...input.limits }),
    });
}
export function evaluateAuthority(envelope, request, nonceStore) {
    if (request.requesterId !== envelope.requesterId)
        return terminate("identity_mismatch");
    if (request.conversationId !== envelope.conversationId)
        return terminate("conversation_mismatch");
    if (request.repository !== envelope.repository)
        return terminate("repository_mismatch");
    if (request.baseRef !== envelope.baseRef)
        return terminate("base_ref_mismatch");
    if (request.briefDigest !== envelope.briefDigest)
        return terminate("brief_digest_mismatch");
    if (request.policyDigest !== envelope.policyDigest)
        return terminate("policy_digest_mismatch");
    if (request.nonce !== envelope.nonce)
        return terminate("replay");
    if (request.now > envelope.expiresAt)
        return terminate("expired");
    if (request.securityBypass)
        return terminate("security_expansion");
    if (request.credentialChange)
        return terminate("credential_change");
    if (request.irreversibleSideEffect)
        return terminate("irreversible_side_effect");
    if (request.action === "deploy" && !request.deploymentDeclared)
        return terminate("undeclared_deployment");
    if (request.action === "push_feature_branch" && (!request.targetRef || request.targetRef === envelope.baseRef))
        return terminate("default_branch_push");
    if (!envelope.allowedActions.includes(request.action) || prohibitedActions.has(request.action))
        return terminate("action_not_allowed");
    if ((request.paths ?? []).some((path) => !envelope.scope.paths.some((root) => pathWithin(path, root))))
        return terminate("path_out_of_scope");
    if (request.projectedBudgetUsd > envelope.limits.budgetUsd)
        return terminate("budget_expansion");
    if (request.projectedActiveTimeMs > envelope.limits.activeTimeMs)
        return terminate("time_expansion");
    if (request.projectedCycles > envelope.limits.cycles)
        return terminate("cycle_expansion");
    if (request.projectedRetries > envelope.limits.retries)
        return terminate("retry_expansion");
    if (nonceStore && !nonceStore.consume(envelope.nonce, authorityEnvelopeDigest(envelope), request.now))
        return terminate("replay");
    return Object.freeze({ outcome: "approve", reason: "in_envelope" });
}
//# sourceMappingURL=authority.js.map