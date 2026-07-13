/**
 * PAT router.
 *
 * Given (Slack user id, target GitHub org), resolves the correct credential
 * vault service name and fetches the PAT at session start.
 *
 * Tokens are never persisted in plugin state. They exist only in memory for
 * the duration of a git operation, injected via a short-lived x-access-token
 * URL rather than argv or .git/config.
 *
 * PHASE 0 SCAFFOLD (resolution logic is done; SDK integration comes later).
 */

import type { PatRoutingConfig } from "../config.js";

export interface ResolvedIdentity {
  service: string;
  token: string;
  gitUserName: string;
  gitUserEmail: string;
}

export class PatRouter {
  constructor(
    private readonly config: PatRoutingConfig,
    private readonly credentialGet: (service: string) => Promise<{ value: string } | null>,
  ) {}

  async resolve(slackUserId: string, targetOrg: string): Promise<ResolvedIdentity> {
    const service = this.serviceNameFor(slackUserId, targetOrg);
    const cred = await this.credentialGet(service);
    if (!cred) {
      throw new Error(
        `No GitHub PAT found in vault for service "${service}". ` +
          `Add via credential_store then retry.`,
      );
    }
    const identity = this.config.commit_identity[slackUserId];
    if (!identity) {
      throw new Error(
        `No commit_identity configured for Slack user ${slackUserId}. ` +
          `Add to plugin config under pat_routing.commit_identity.`,
      );
    }
    return {
      service,
      token: cred.value,
      gitUserName: identity.name,
      gitUserEmail: identity.email,
    };
  }

  private serviceNameFor(slackUserId: string, targetOrg: string): string {
    const override = this.config.overrides[slackUserId]?.[targetOrg];
    if (override) return override;
    const userShort = this.shortenSlackUser(slackUserId);
    const orgShort = targetOrg.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return `github-${userShort}-${orgShort}`;
  }

  private shortenSlackUser(slackUserId: string): string {
    // Fallback if no override is configured. Not great; overrides are preferred.
    return slackUserId.toLowerCase();
  }
}
