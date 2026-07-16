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
import type { GitProvider, PatRoutingConfig } from "../config.js";
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
    provenance: "override_repo" | "override_owner" | "default_pattern";
}
export declare class PatRouter {
    private readonly cfg;
    constructor(cfg: PatRoutingConfig);
    /** Provider for a repo owner: explicit input > provider_by_owner > default_provider > github. */
    resolveProvider(owner: string, explicit?: GitProvider): GitProvider;
    private providerConfig;
    /** Requester login for the active provider, from user_identities. May be undefined. */
    private requesterLogin;
    resolve(input: PatResolutionInput): PatResolution;
}
//# sourceMappingURL=pat-router.d.ts.map