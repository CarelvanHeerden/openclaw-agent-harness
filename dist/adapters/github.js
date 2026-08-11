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
 * beta.75 (#1): post a comment on a PR (issue-comments endpoint).
 *
 * WHY: `createPullRequest` writes the review verdict/findings into the PR
 * BODY only at CREATE time. On a re-push to an EXISTING PR (a revise, or a
 * harness_run that D2 promoted onto an open-PR branch), the commits update the
 * PR diff but nothing surfaces the NEW review outcome -- so a `do_not_merge`
 * verdict + its findings were invisible on the PR itself (Carel on #876: "the
 * new test file is there but the PR comments didn't update"). Posting a fresh
 * comment on every review makes each review's verdict/findings visible on the
 * PR timeline, not just in the harness DB. Best-effort: a failed comment must
 * NEVER fail the run (the code + PR already landed), so callers swallow errors.
 */
export async function postPrComment(input) {
    const apiBase = input.apiBase ?? "https://api.github.com";
    const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${input.ghToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "openclaw-agent-harness/0.1",
            },
            body: JSON.stringify({ body: input.body }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { ok: false, status: res.status, error: text.slice(0, 300) };
        }
        const json = (await res.json().catch(() => ({})));
        return { ok: true, status: res.status, htmlUrl: json.html_url };
    }
    catch (err) {
        return { ok: false, status: 0, error: String(err) };
    }
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
/** Check-run conclusions that mean CI is red. */
const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "stale"];
/** Check-run conclusions that are not red and do not block a green verdict. */
const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"];
/**
 * beta.34: combined CI status for a commit SHA, merging the legacy Statuses API
 * and the Check Runs API into one verdict.
 *
 * beta.119: this gate used to FAIL OPEN, and the b118 smoke shipped on it.
 * ProjectThanos PR #986 was declared green at 21:10:45 while Lint had failed at
 * 21:10:17 and Tests failed at 21:13:39. The old code read both APIs but guarded
 * the check-runs branch with a bare `if (cRes.ok)` and no else, so an
 * unreadable -- or transiently empty, which the Check Runs API genuinely does
 * return under eventual consistency -- check-run list was indistinguishable
 * from "this repo has no check runs". The "nothing configured" guard then
 * required BOTH sources to be empty, and ProjectThanos has exactly one legacy
 * status (Vercel). So the moment Vercel's deploy went green the function fell
 * through `anySuccess` and reported the whole commit green, blind to all ten
 * Actions checks. The old body also ENDED in `return "success"`, making success
 * the default for every state not explicitly matched.
 *
 * The rules below invert that: success requires positive evidence from every
 * signal, and anything we could not read is "unknown", never a pass.
 */
export async function getCiSnapshot(input) {
    const base = input.apiBase ?? "https://api.github.com";
    const snap = {
        state: "unknown", statusReadable: false, checksReadable: false,
        statusState: "", statusCount: 0, checkTotal: 0, checkIncomplete: 0, checkFailed: 0, checkPassed: 0, reason: "",
    };
    try {
        const sRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/status`, {
            headers: GH_HEADERS(input.ghToken),
        });
        if (sRes.ok) {
            const sj = (await sRes.json());
            snap.statusReadable = true;
            snap.statusState = sj.state ?? "";
            snap.statusCount = sj.total_count ?? 0;
        }
        else {
            snap.reason = `statuses API HTTP ${sRes.status}`;
        }
    }
    catch (err) {
        snap.reason = `statuses API threw: ${String(err).slice(0, 120)}`;
    }
    try {
        const cRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/check-runs?per_page=100`, {
            headers: GH_HEADERS(input.ghToken),
        });
        if (cRes.ok) {
            const cj = (await cRes.json());
            const runs = cj.check_runs ?? [];
            snap.checksReadable = true;
            snap.checkTotal = runs.length;
            snap.checkIncomplete = runs.filter((r) => r.status !== "completed").length;
            snap.checkFailed = runs.filter((r) => FAILED_CONCLUSIONS.includes(r.conclusion ?? "")).length;
            snap.checkPassed = runs.filter((r) => r.status === "completed" && PASSING_CONCLUSIONS.includes(r.conclusion ?? "")).length;
            // The list is capped at 100 per page. A commit with more checks than that
            // would silently look complete, so refuse to judge it rather than guess.
            if ((cj.total_count ?? runs.length) > runs.length) {
                snap.checksReadable = false;
                snap.reason = `check-runs truncated (${cj.total_count} total, ${runs.length} read)`;
            }
        }
        else {
            snap.reason = snap.reason ? `${snap.reason}; check-runs API HTTP ${cRes.status}` : `check-runs API HTTP ${cRes.status}`;
        }
    }
    catch (err) {
        const m = `check-runs API threw: ${String(err).slice(0, 120)}`;
        snap.reason = snap.reason ? `${snap.reason}; ${m}` : m;
    }
    // A signal we could not read is never evidence of health. This is the b115
    // principle ("a gate that could not run must not read as a pass") applied to
    // the CI gate itself.
    if (!snap.statusReadable || !snap.checksReadable) {
        snap.state = "unknown";
        return snap;
    }
    // Red beats everything, and beats it EARLY: a failed check is already
    // decisive, so there is nothing to gain by waiting out its siblings.
    if (snap.statusState === "failure" || snap.statusState === "error") {
        snap.state = "failure";
        snap.reason = `legacy status state=${snap.statusState}`;
        return snap;
    }
    if (snap.checkFailed > 0) {
        snap.state = "failure";
        snap.reason = `${snap.checkFailed} check run(s) failed`;
        return snap;
    }
    if (snap.checkIncomplete > 0) {
        snap.state = "pending";
        snap.reason = `${snap.checkIncomplete} of ${snap.checkTotal} check run(s) still running`;
        return snap;
    }
    if (snap.statusState === "pending" && snap.statusCount > 0) {
        snap.state = "pending";
        snap.reason = "legacy status still pending";
        return snap;
    }
    // Genuinely nothing configured. GitHub reports the combined state as
    // "pending" with total_count 0 when there are no statuses at all.
    if (snap.statusCount === 0 && snap.checkTotal === 0) {
        snap.state = "none";
        snap.reason = "no statuses and no check runs on this sha";
        return snap;
    }
    // Success demands positive evidence from BOTH signals: every check run
    // concluded well, and the legacy state is green or absent. Note this is
    // vacuously true when `checkTotal` is 0, which is exactly the transient the
    // caller's high-water mark exists to catch -- a repo whose checks have not
    // appeared yet looks identical to one that has none.
    // Every check must be one we recognise as passing -- an unrecognised
    // conclusion is not evidence of health either.
    const allChecksGood = snap.checkPassed === snap.checkTotal;
    const legacyGood = snap.statusCount === 0 || snap.statusState === "success";
    if (legacyGood && allChecksGood) {
        snap.state = "success";
        snap.reason = `${snap.checkTotal} check run(s) passed; legacy state=${snap.statusState || "absent"}`;
        return snap;
    }
    // Anything left is a combination we do not have a rule for. Refuse to call
    // it, rather than defaulting to green the way the pre-b119 code did.
    snap.state = "unknown";
    snap.reason = `unclassified: legacy=${snap.statusState}/${snap.statusCount}, checks=${snap.checkTotal} (${snap.checkFailed} failed, ${snap.checkIncomplete} running)`;
    return snap;
}
/**
 * beta.119: the OAuth scopes GitHub reports for this token.
 *
 * GitHub returns `x-oauth-scopes` on any authenticated request, but ONLY for
 * classic PATs and OAuth tokens. Fine-grained PATs and GitHub App installation
 * tokens return it absent or empty while being perfectly capable, so `null`
 * here means "cannot tell" and must never be read as "cannot do". Never throws.
 */
export async function getTokenScopes(input) {
    const base = input.apiBase ?? "https://api.github.com";
    try {
        const res = await fetch(`${base}/user`, { headers: GH_HEADERS(input.ghToken) });
        const header = res.headers?.get?.("x-oauth-scopes");
        if (header === null || header === undefined)
            return null;
        const scopes = header.split(",").map((s) => s.trim()).filter(Boolean);
        return scopes.length > 0 ? scopes : null;
    }
    catch {
        return null;
    }
}
/** beta.34 / beta.119: the bare state. Prefer `getCiSnapshot` where the evidence matters. */
export async function getCombinedStatus(input) {
    return (await getCiSnapshot(input)).state;
}
/**
 * beta.81 (Track B / B2): fetch a short excerpt of the FAILING check-runs for a
 * commit SHA -- each failed run's name, conclusion, and output title/summary --
 * so the harness can surface WHY CI is red as the revise finding source. Never
 * throws; returns "" on any error or when nothing failed.
 */
export async function getFailingCheckLogs(input) {
    const base = input.apiBase ?? "https://api.github.com";
    try {
        const cRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/check-runs`, {
            headers: GH_HEADERS(input.ghToken),
        });
        if (!cRes.ok)
            return "";
        const cj = (await cRes.json());
        const failed = (cj.check_runs ?? []).filter((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""));
        if (failed.length === 0)
            return "";
        return failed
            .map((r) => {
            const title = r.output?.title ? `: ${r.output.title}` : "";
            const summary = r.output?.summary ? `\n  ${r.output.summary.slice(0, 500)}` : "";
            return `- ${r.name} [${r.conclusion}]${title}${summary}`;
        })
            .join("\n")
            .slice(0, 2000);
    }
    catch {
        return "";
    }
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