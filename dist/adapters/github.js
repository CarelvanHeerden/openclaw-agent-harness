/**
 * GitHub REST adapter for the ONE operation the harness performs: open a
 * pull request. Everything else (push, fetch) goes through git.
 *
 * We deliberately do NOT wrap the whole Octokit surface. The plugin should
 * touch as little of GitHub as possible.
 */
export async function createPullRequest(input) {
    const apiBase = input.apiBase ?? "https://api.github.com";
    const url = `${apiBase}/repos/${input.repoFullName}/pulls`;
    const post = async (draft) => fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${input.ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "openclaw-agent-harness/0.1",
        },
        body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
            draft,
        }),
    });
    let res = await post(!!input.draft);
    // beta.32: draft PRs are rejected with HTTP 422 on repos that don't
    // support them (private repos on free plans, certain repo types). Rather
    // than kill the run at the final step, retry as a non-draft PR. The
    // verdict warning is already embedded in the PR body, so a human still
    // sees the review outcome.
    if (!res.ok && res.status === 422 && input.draft) {
        const peek = await res.clone().text().catch(() => "");
        if (/draft/i.test(peek)) {
            res = await post(false);
        }
    }
    // beta.44: on a revise, a PR already exists for this head branch. GitHub
    // returns 422 with "A pull request already exists for <owner>:<head>". The
    // push (done before this call) has ALREADY updated that PR's head, so this
    // is success, not failure: look up the existing open PR for the head and
    // return it. This is what makes revise UPDATE the same PR instead of
    // erroring or opening a duplicate.
    if (!res.ok && res.status === 422) {
        const peek = await res.clone().text().catch(() => "");
        if (/pull request already exists/i.test(peek)) {
            const [owner] = input.repoFullName.split("/");
            const lookup = `${apiBase}/repos/${input.repoFullName}/pulls?head=${owner}:${encodeURIComponent(input.head)}&state=open`;
            const found = await fetch(lookup, {
                headers: {
                    Authorization: `Bearer ${input.ghToken}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "openclaw-agent-harness/0.1",
                },
            });
            if (found.ok) {
                const arr = (await found.json());
                if (Array.isArray(arr) && arr.length > 0) {
                    const existing = arr[0];
                    return { number: existing.number, htmlUrl: existing.html_url, nodeId: existing.node_id, updatedExisting: true };
                }
            }
        }
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub PR create failed ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json());
    return {
        number: json.number,
        htmlUrl: json.html_url,
        nodeId: json.node_id,
    };
}
/**
 * Sanity-check that a PAT can see a repo. Used at session-start so we
 * fail fast with a clear Slack error instead of dying mid-worker.
 */
export async function verifyRepoAccess(input) {
    const url = `https://api.github.com/repos/${input.repoFullName}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${input.ghToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "openclaw-agent-harness/0.1",
        },
    });
    if (!res.ok) {
        return { ok: false, status: res.status, reason: (await res.text()).slice(0, 200) };
    }
    const scopes = res.headers.get("x-oauth-scopes") ?? undefined;
    return { ok: true, status: res.status, scopes };
}
const GH_HEADERS = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openclaw-agent-harness/0.1",
});
/** beta.34: fetch a PR's head SHA + state (open/closed, merged). */
export async function getPullRequest(input) {
    const res = await fetch(`https://api.github.com/repos/${input.repoFullName}/pulls/${input.prNumber}`, {
        headers: GH_HEADERS(input.ghToken),
    });
    if (!res.ok)
        throw new Error(`GitHub get PR #${input.prNumber} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json());
    return { headSha: j.head.sha, state: j.state, merged: j.merged, mergeable: j.mergeable, baseBranch: j.base.ref };
}
/**
 * beta.34: combined CI status for a commit SHA. Merges the legacy Statuses
 * API and the Check Runs API into one verdict: "success" | "failure" |
 * "pending" | "none" (no checks configured).
 */
export async function getCombinedStatus(input) {
    // Legacy combined status.
    const sRes = await fetch(`https://api.github.com/repos/${input.repoFullName}/commits/${input.sha}/status`, {
        headers: GH_HEADERS(input.ghToken),
    });
    let statusState = "";
    let statusCount = 0;
    if (sRes.ok) {
        const sj = (await sRes.json());
        statusState = sj.state; // success | failure | pending | error
        statusCount = sj.total_count;
    }
    // Check runs.
    const cRes = await fetch(`https://api.github.com/repos/${input.repoFullName}/commits/${input.sha}/check-runs`, {
        headers: GH_HEADERS(input.ghToken),
    });
    let checkConclusions = [];
    if (cRes.ok) {
        const cj = (await cRes.json());
        // Any still-running check => pending.
        if (cj.check_runs.some((r) => r.status !== "completed"))
            return "pending";
        checkConclusions = cj.check_runs.map((r) => r.conclusion ?? "");
    }
    const anyFailure = statusState === "failure" ||
        statusState === "error" ||
        checkConclusions.some((c) => ["failure", "timed_out", "cancelled", "action_required"].includes(c));
    if (anyFailure)
        return "failure";
    // Nothing configured: GitHub reports the combined status `state` as
    // "pending" with total_count 0 when there are no statuses at all. Treat
    // that (with no check runs either) as "none", not a real pending.
    if (statusCount === 0 && checkConclusions.length === 0)
        return "none";
    if (statusState === "pending")
        return "pending";
    const anySuccess = statusState === "success" || checkConclusions.some((c) => c === "success");
    if (anySuccess)
        return "success";
    return "success";
}
/** beta.34: merge a PR (squash by default). Returns the merge commit SHA. */
export async function mergePullRequest(input) {
    const res = await fetch(`https://api.github.com/repos/${input.repoFullName}/pulls/${input.prNumber}/merge`, {
        method: "PUT",
        headers: { ...GH_HEADERS(input.ghToken), "Content-Type": "application/json" },
        body: JSON.stringify({
            merge_method: input.method ?? "squash",
            ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
        }),
    });
    const j = (await res.json().catch(() => ({})));
    if (!res.ok) {
        throw new Error(`GitHub merge PR #${input.prNumber} failed ${res.status}: ${j.message ?? ""}`.slice(0, 400));
    }
    return { merged: !!j.merged, sha: j.sha ?? "", message: j.message ?? "" };
}
//# sourceMappingURL=github.js.map