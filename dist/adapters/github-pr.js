/**
 * GitHub PR adapter.
 *
 * Pushes a session's branch to origin and opens a PR against the base
 * branch. The PR body embeds the adversary's summary so a human reviewer
 * sees the harness's own verdict without opening the review JSON.
 *
 * Auth uses the session-specific GH token resolved by PatRouter — the
 * token is only ever passed via env-var to git and via Authorization
 * header to the REST API. It never appears in .gitconfig or the URL.
 */
export async function pushBranchAndOpenPr(input) {
    const fetchFn = input.fetchImpl ?? fetch;
    // 1. Push. This is the ONLY place the harness performs a `git push`.
    await input.git.pushBranch(input.worktreePath, "origin", input.headBranch, input.ghToken);
    input.logger.info("[github-pr] branch pushed", { headBranch: input.headBranch });
    // 2. Build body
    const body = buildPrBody(input);
    // 3. Open PR
    const res = await fetchFn(`https://api.github.com/repos/${input.repoFullName}/pulls`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${input.ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "openclaw-agent-harness/0.1",
        },
        body: JSON.stringify({
            title: input.brief.title,
            head: input.headBranch,
            base: input.baseBranch,
            body,
            draft: input.reviewReport.verdict !== "pass",
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`github pulls POST failed ${res.status}: ${text.slice(0, 500)}`);
    }
    const j = (await res.json());
    input.logger.info("[github-pr] PR opened", { number: j.number, url: j.html_url });
    return j.html_url;
}
export function buildPrBody(input) {
    const rr = input.reviewReport;
    const findingsBlock = rr.findings.length
        ? rr.findings
            .map((f) => `- [${f.severity}/${f.dimension}] **${f.title}** — ${f.detail}`)
            .join("\n")
        : "_(no findings)_";
    const draftBanner = rr.verdict === "pass"
        ? ""
        : `> :warning: Adversarial review verdict: **${rr.verdict}** — this PR is opened as a *draft* so a human can decide before merging.\n\n`;
    return [
        draftBanner,
        `## Motivation`,
        input.brief.motivation,
        ``,
        `## Acceptance criteria`,
        ...input.brief.acceptanceCriteria.map((c) => `- [ ] ${c}`),
        ``,
        `## Adversarial review (${rr.verdict})`,
        rr.summary,
        ``,
        `### Findings`,
        findingsBlock,
        ``,
        `---`,
        `Requested by ${input.requesterHandle}, produced by \`openclaw-agent-harness\`.`,
        `[Adversary session: ${rr.sdkSessionId ?? "n/a"}]`,
    ].join("\n");
}
//# sourceMappingURL=github-pr.js.map