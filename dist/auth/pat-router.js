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
/** Thrown when the hierarchical config exists but the requester has no entry. */
export class PatRequesterNotAuthorisedError extends Error {
    provider;
    org;
    slackUserId;
    constructor(provider, org, slackUserId) {
        super(`no ${provider} token configured for requester '${slackUserId}' under org '${org}'. ` +
            `Add a person entry at pat_routing.${provider}.${org}.<person> with a matching slack_user_id, ` +
            `token, name and email. (No silent fallback to another user's token.)`);
        this.provider = provider;
        this.org = org;
        this.slackUserId = slackUserId;
        this.name = "PatRequesterNotAuthorisedError";
    }
}
const PROVIDER_DEFAULTS = {
    github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
    gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
};
export class PatRouter {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    /** Provider for a repo owner: explicit input > provider_by_owner > default_provider > github. */
    resolveProvider(owner, explicit) {
        if (explicit)
            return explicit;
        const byOwner = this.cfg.provider_by_owner?.[owner] ?? this.cfg.provider_by_owner?.[owner.toLowerCase()];
        if (byOwner)
            return byOwner;
        return this.cfg.default_provider ?? "github";
    }
    providerConfig(provider) {
        const fromCfg = this.cfg.providers?.[provider];
        const dflt = PROVIDER_DEFAULTS[provider];
        return {
            api_base: fromCfg?.api_base || dflt.api_base,
            // Back-compat: legacy pat_routing.auth.api_key_env still wins for github.
            api_key_env: (provider === "github" && this.cfg.auth?.api_key_env) ||
                fromCfg?.api_key_env ||
                dflt.api_key_env,
        };
    }
    /** Requester login for the active provider, from user_identities. May be undefined. */
    requesterLogin(slackUserId, provider) {
        return this.cfg.user_identities?.[slackUserId]?.[provider];
    }
    /** Does the hierarchical config define any org entries for this provider? */
    hasHierarchyFor(provider, owner) {
        const orgs = this.cfg[provider];
        if (!orgs)
            return false;
        return !!(orgs[owner] ?? orgs[owner.toLowerCase()]);
    }
    /**
     * beta.25 hierarchical lookup: provider -> org(owner) -> person, matched to
     * the requester by `slack_user_id`. Returns undefined if this provider/org
     * is not configured hierarchically (caller then uses the legacy path).
     * Throws PatRequesterNotAuthorisedError if the org IS configured but the
     * requester has no entry (no silent fallback).
     */
    resolveHierarchy(provider, owner, slackUserId) {
        const orgs = this.cfg[provider];
        if (!orgs)
            return undefined;
        const orgNode = orgs[owner] ?? orgs[owner.toLowerCase()];
        if (!orgNode)
            return undefined;
        for (const [person, node] of Object.entries(orgNode)) {
            if (node.slack_user_id && node.slack_user_id === slackUserId) {
                return { person, node };
            }
        }
        // Org is configured hierarchically but this requester is not listed.
        // Hard fail — never fall back to another person's token.
        throw new PatRequesterNotAuthorisedError(provider, owner, slackUserId);
    }
    resolve(input) {
        const parts = input.repoFullName.split("/");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw new Error(`repoFullName "${input.repoFullName}" is not owner/repo`);
        }
        const owner = parts[0];
        const repo = parts[1];
        const provider = this.resolveProvider(owner, input.provider);
        const pcfg = this.providerConfig(provider);
        // beta.25: hierarchical routing takes precedence when configured for this
        // provider+org. It carries its own token pointer + commit identity, so it
        // short-circuits the legacy vault-service resolution entirely.
        if (this.hasHierarchyFor(provider, owner)) {
            const hit = this.resolveHierarchy(provider, owner, input.slackUserId);
            if (hit) {
                return {
                    provider,
                    // Synthetic service name for logging/audit continuity; the token is
                    // resolved from tokenPointer, not this name.
                    credentialService: `${provider}-${owner.toLowerCase()}-${hit.person.toLowerCase()}`,
                    commitIdentity: { name: hit.node.name, email: hit.node.email },
                    apiBase: pcfg.api_base,
                    apiKeyEnv: pcfg.api_key_env,
                    provenance: "hierarchy",
                    tokenPointer: hit.node.token,
                    person: hit.person,
                };
            }
        }
        const userMap = this.cfg.overrides[input.slackUserId] ?? {};
        let credentialService;
        let provenance;
        if (userMap[input.repoFullName]) {
            credentialService = userMap[input.repoFullName];
            provenance = "override_repo";
        }
        else if (userMap[owner]) {
            credentialService = userMap[owner];
            provenance = "override_owner";
        }
        else {
            // {requester} = requesting user's provider login (true per-user); falls
            // back to the repo owner if the user has no configured identity, so the
            // template never leaves an unresolved placeholder.
            const requester = (this.requesterLogin(input.slackUserId, provider) ?? owner).toLowerCase();
            credentialService = this.cfg.default_service_pattern
                .replaceAll("{provider}", provider)
                .replaceAll("{owner}", owner.toLowerCase())
                .replaceAll("{repo}", repo.toLowerCase())
                .replaceAll("{requester}", requester)
                // Deprecated aliases: {user} = requester login (repo owner if unknown),
                // {org} = repo owner. For a personal repo these collapse to the same
                // value (why the old "github-{user}-{org}" default duplicated).
                .replaceAll("{user}", (this.requesterLogin(input.slackUserId, provider) ?? input.gitHubUser).toLowerCase())
                .replaceAll("{org}", owner.toLowerCase());
            provenance = "default_pattern";
        }
        const commitIdentity = this.cfg.commit_identity[input.slackUserId] ??
            {
                name: input.gitHubUser,
                email: `${input.gitHubUser}@users.noreply.github.com`,
            };
        if (!credentialService) {
            // Not reachable given the branch above, but keeps the type system honest.
            throw new Error("credentialService could not be resolved");
        }
        return {
            provider,
            credentialService,
            commitIdentity,
            apiBase: pcfg.api_base,
            apiKeyEnv: pcfg.api_key_env,
            provenance,
        };
    }
}
//# sourceMappingURL=pat-router.js.map