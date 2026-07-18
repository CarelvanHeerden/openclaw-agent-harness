/**
 * PAT router.
 *
 * Given a (Slack user id, target repo, action) tuple, resolves to:
 *   - the git provider (github | gitlab),
 *   - the OpenClaw credential vault service name to fetch the token from,
 *   - the git commit identity to use on that commit,
 *   - the provider REST API base URL,
 *   - the env-var name to use as a token fallback for that provider.
 *
 * Resolution order for the credential service:
 *   1. Explicit override: config.pat_routing.overrides[userId][owner/repo]
 *   2. Explicit override: config.pat_routing.overrides[userId][owner]
 *   3. Default pattern (config.pat_routing.default_service_pattern), with
 *      placeholder substitution: {owner} {repo} {provider} {requester}
 *      and the deprecated aliases {user} {org}.
 *
 * The router does NOT read secrets itself. It hands the resolved service
 * name (and env fallback var) back to the caller, which then invokes the
 * credential vault / env. Keeping this router side-effect-free means it is
 * trivially unit-testable and safe to log.
 */
import type { GitProvider, PatRoutingConfig, TokenPointer } from "../config.js";
export interface PatResolutionInput {
    slackUserId: string;
    slackHandle?: string;
    gitHubUser: string;
    repoFullName: string;
    /** Explicit provider override; otherwise inferred from provider_by_owner / default_provider. */
    provider?: GitProvider;
}
export interface PatResolution {
    provider: GitProvider;
    credentialService: string;
    commitIdentity: {
        name: string;
        email: string;
    };
    apiBase: string;
    apiKeyEnv: string;
    provenance: "hierarchy" | "override_repo" | "override_owner" | "default_pattern";
    /**
     * beta.25: when the hierarchical config matched, the token pointer for the
     * resolved person. The caller resolves this DIRECTLY (value|env|vault),
     * bypassing the legacy vault-first/env-fallback path. Undefined for
     * legacy (flat) resolutions, which continue to use `credentialService`.
     */
    tokenPointer?: TokenPointer;
    /** beta.25: person key that matched in the hierarchy (for logging/audit). */
    person?: string;
}
/** Thrown when the hierarchical config exists but the requester has no entry. */
export declare class PatRequesterNotAuthorisedError extends Error {
    readonly provider: GitProvider;
    readonly org: string;
    readonly slackUserId: string;
    constructor(provider: GitProvider, org: string, slackUserId: string);
}
export declare class PatRouter {
    private readonly cfg;
    constructor(cfg: PatRoutingConfig);
    /** Provider for a repo owner: explicit input > provider_by_owner > default_provider > github. */
    resolveProvider(owner: string, explicit?: GitProvider): GitProvider;
    private providerConfig;
    /** Requester login for the active provider, from user_identities. May be undefined. */
    private requesterLogin;
    /** Does the hierarchical config define any org entries for this provider? */
    private hasHierarchyFor;
    /**
     * beta.25 hierarchical lookup: provider -> org(owner) -> person, matched to
     * the requester by `slack_user_id`. Returns undefined if this provider/org
     * is not configured hierarchically (caller then uses the legacy path).
     * Throws PatRequesterNotAuthorisedError if the org IS configured but the
     * requester has no entry (no silent fallback).
     */
    private resolveHierarchy;
    resolve(input: PatResolutionInput): PatResolution;
}
//# sourceMappingURL=pat-router.d.ts.map