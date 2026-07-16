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

import type { GitProvider, PatRoutingConfig, ProviderConfig } from "../config.js";

export interface PatResolutionInput {
  slackUserId: string;
  slackHandle?: string;
  gitHubUser: string;         // repo owner (kept name for back-compat; used for {owner}/{org}/legacy {user})
  repoFullName: string;       // "org/repo" or "user/repo"
  /** Explicit provider override; otherwise inferred from provider_by_owner / default_provider. */
  provider?: GitProvider;
}

export interface PatResolution {
  provider: GitProvider;
  credentialService: string;   // vault service name, e.g. "github-carel-personal"
  commitIdentity: { name: string; email: string };
  apiBase: string;             // provider REST API base
  apiKeyEnv: string;           // env var to use as a token fallback for this provider
  provenance: "override_repo" | "override_owner" | "default_pattern";
}

const PROVIDER_DEFAULTS: Record<GitProvider, ProviderConfig> = {
  github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
  gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
};

export class PatRouter {
  constructor(private readonly cfg: PatRoutingConfig) {}

  /** Provider for a repo owner: explicit input > provider_by_owner > default_provider > github. */
  resolveProvider(owner: string, explicit?: GitProvider): GitProvider {
    if (explicit) return explicit;
    const byOwner = this.cfg.provider_by_owner?.[owner] ?? this.cfg.provider_by_owner?.[owner.toLowerCase()];
    if (byOwner) return byOwner;
    return this.cfg.default_provider ?? "github";
  }

  private providerConfig(provider: GitProvider): ProviderConfig {
    const fromCfg = this.cfg.providers?.[provider];
    const dflt = PROVIDER_DEFAULTS[provider];
    return {
      api_base: fromCfg?.api_base || dflt.api_base,
      // Back-compat: legacy pat_routing.auth.api_key_env still wins for github.
      api_key_env:
        (provider === "github" && this.cfg.auth?.api_key_env) ||
        fromCfg?.api_key_env ||
        dflt.api_key_env,
    };
  }

  /** Requester login for the active provider, from user_identities. May be undefined. */
  private requesterLogin(slackUserId: string, provider: GitProvider): string | undefined {
    return this.cfg.user_identities?.[slackUserId]?.[provider];
  }

  resolve(input: PatResolutionInput): PatResolution {
    const parts = input.repoFullName.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`repoFullName "${input.repoFullName}" is not owner/repo`);
    }
    const owner = parts[0];
    const repo = parts[1];
    const provider = this.resolveProvider(owner, input.provider);
    const pcfg = this.providerConfig(provider);

    const userMap = this.cfg.overrides[input.slackUserId] ?? {};
    let credentialService: string | undefined;
    let provenance: PatResolution["provenance"];

    if (userMap[input.repoFullName]) {
      credentialService = userMap[input.repoFullName];
      provenance = "override_repo";
    } else if (userMap[owner]) {
      credentialService = userMap[owner];
      provenance = "override_owner";
    } else {
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

    const commitIdentity =
      this.cfg.commit_identity[input.slackUserId] ??
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
