/**
 * GitHub REST adapter for the ONE operation the harness performs: open a
 * pull request. Everything else (push, fetch) goes through git.
 *
 * We deliberately do NOT wrap the whole Octokit surface. The plugin should
 * touch as little of GitHub as possible.
 */
export async function createPullRequest(input) {
    const url = `https://api.github.com/repos/${input.repoFullName}/pulls`;
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
//# sourceMappingURL=github.js.map