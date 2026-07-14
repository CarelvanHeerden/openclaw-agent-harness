/**
 * PAT router.
 *
 * Given a (Slack user id, target repo, action) tuple, resolves to:
 *   - the OpenClaw credential vault service name to fetch the PAT from,
 *   - the git commit identity to use on that commit,
 *   - the API base URL (GitHub.com only in the current implementation).
 *
 * Resolution order:
 *   1. Explicit override: config.pat_routing.overrides[userId][owner/repo]
 *   2. Explicit override: config.pat_routing.overrides[userId][owner]
 *   3. Default pattern (config.pat_routing.default_service_pattern),
 *      with `{user}` and `{org}` placeholder substitution.
 *
 * The router does NOT read secrets itself. It hands the resolved service
 * name back to the caller, which then invokes OpenClaw's `credential_get`
 * tool. Keeping this router side-effect-free means it is trivially unit-
 * testable and safe to log.
 */
import type { PatRoutingConfig } from "../config.js";
export interface PatResolutionInput {
    slackUserId: string;
    slackHandle?: string;
    gitHubUser: string;
    repoFullName: string;
}
export interface PatResolution {
    credentialService: string;
    commitIdentity: {
        name: string;
        email: string;
    };
    apiBase: string;
    provenance: "override_repo" | "override_owner" | "default_pattern";
}
export declare class PatRouter {
    private readonly cfg;
    constructor(cfg: PatRoutingConfig);
    resolve(input: PatResolutionInput): PatResolution;
}
//# sourceMappingURL=pat-router.d.ts.map