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
export class PatRouter {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    resolve(input) {
        const parts = input.repoFullName.split("/");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw new Error(`repoFullName "${input.repoFullName}" is not owner/repo`);
        }
        const owner = parts[0];
        const repo = parts[1];
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
            credentialService = this.cfg.default_service_pattern
                .replaceAll("{owner}", owner.toLowerCase())
                .replaceAll("{repo}", repo.toLowerCase())
                // Deprecated aliases: {user} = requester login, {org} = repo owner.
                // For a personal repo these collapse to the same value, which is why
                // the old "github-{user}-{org}" default produced a duplicated segment.
                .replaceAll("{user}", input.gitHubUser.toLowerCase())
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
            credentialService,
            commitIdentity,
            apiBase: "https://api.github.com",
            provenance,
        };
    }
}
//# sourceMappingURL=pat-router.js.map