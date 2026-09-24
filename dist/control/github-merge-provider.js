export function createControlMergeProvider(deps) {
    const requesterFor = (repository, prNumber) => {
        const run = deps.db.prepare(`SELECT requester_id FROM control_runs WHERE id = (
      SELECT run_id FROM control_proposals WHERE pr_number = ? AND run_id IN (SELECT id FROM control_runs WHERE repository = ?)
    )`).get(prNumber, repository);
        if (!run?.requester_id)
            throw new Error("Control requester is unavailable");
        return run.requester_id;
    };
    return {
        inspect: async ({ repository, prNumber }) => {
            const requesterId = requesterFor(repository, prNumber);
            const { route, token: ghToken } = await deps.resolveCredential(repository, prNumber, requesterId);
            const pr = await deps.getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
            const ci = await deps.getCiSnapshot({ repoFullName: repository, sha: pr.headSha, ghToken, apiBase: route.apiBase });
            const proposal = deps.db.prepare(`SELECT p.*, r.base_ref, r.policy_digest, r.authority_envelope_json, s.published_at
        FROM control_proposals p JOIN control_runs r ON r.id=p.run_id LEFT JOIN sessions s ON s.id=p.run_id WHERE p.pr_number=? AND r.repository=?`).get(prNumber, repository);
            const latest = deps.db.prepare(`SELECT input_json FROM control_readiness_attestations WHERE run_id=? ORDER BY generation DESC LIMIT 1`).get(String(proposal.run_id));
            const prior = JSON.parse(latest.input_json);
            return {
                repository,
                baseRef: pr.baseBranch,
                prNumber,
                headSha: pr.headSha,
                open: pr.state === "open" && !pr.merged,
                merged: pr.merged,
                ...(pr.mergeCommitSha ? { mergeSha: pr.mergeCommitSha } : {}),
                readiness: {
                    ...prior,
                    candidateSha: pr.headSha,
                    publication: { sha: String(proposal.published_sha), observedAt: Number(proposal.published_at) },
                    pullRequest: { repository, baseRef: pr.baseBranch, headSha: pr.headSha, open: pr.state === "open" && !pr.merged, number: prNumber, url: pr.htmlUrl },
                    requiredCi: {
                        registered: ci.statusReadable && ci.checksReadable && ci.checkNames.length > 0,
                        requiredChecks: ci.checkNames,
                        successfulChecks: ci.state === "success" ? ci.checkNames : [],
                        sha: pr.headSha,
                        status: (ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : ci.state === "pending" ? "pending" : "indeterminate"),
                    },
                },
            };
        },
        merge: async ({ repository, prNumber, expectedHeadSha }) => {
            const requesterId = requesterFor(repository, prNumber);
            const { route, token: ghToken } = await deps.resolveCredential(repository, prNumber, requesterId);
            const merged = await deps.mergePullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase, method: "squash", expectedHeadSha });
            if (!merged.merged || !merged.sha)
                throw new Error(merged.message || "Provider did not merge the pull request");
            return { mergeSha: merged.sha };
        },
        verifyMerged: async ({ repository, prNumber, mergeSha }) => {
            let requesterId;
            try {
                requesterId = requesterFor(repository, prNumber);
            }
            catch {
                return false;
            }
            const { route, token: ghToken } = await deps.resolveCredential(repository, prNumber, requesterId);
            const pr = await deps.getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
            return /^[a-f0-9]{40}$/i.test(mergeSha) && pr.merged && pr.mergeCommitSha === mergeSha;
        },
    };
}
//# sourceMappingURL=github-merge-provider.js.map