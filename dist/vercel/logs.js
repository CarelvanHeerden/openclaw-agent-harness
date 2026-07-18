/**
 * Vercel preview-deployment bridge.
 *
 * Given a repo + branch, waits (bounded) for a preview deployment to reach
 * READY / ERROR, then returns an excerpt of its runtime logs so the
 * adversary can review real behaviour, not just the diff.
 *
 * We treat READY as "ok" and ERROR (build or runtime) as "build_failed".
 * If no deployment appears in `preview_wait_seconds`, we return
 * `no_deploy_yet` and the adversary's runtime dimension is force-flagged
 * MEDIUM (see fable5-adversary.ts).
 *
 * Optional (config-driven): if `harness.vercel.enabled` is false, this
 * module is never called and adversary review skips runtime silently.
 */
const API = "https://api.vercel.com";
/**
 * beta.34: verify the Vercel deployment for a specific commit SHA (the merge
 * commit produced by harness_merge_pr). Polls deployments filtered to the
 * project, matches on `meta.githubCommitSha`, waits for a terminal state,
 * and on ERROR pulls the build logs. Returns a compact result for reporting.
 */
export async function verifyDeploymentForSha(input) {
    const start = Date.now();
    const poll = input.pollIntervalMs ?? 10_000;
    const qs = new URLSearchParams({ projectId: input.projectId, limit: "20" });
    if (input.teamId)
        qs.set("teamId", input.teamId);
    let lastDep = null;
    while (Date.now() - start < input.waitSeconds * 1000) {
        const res = await fetch(`${API}/v6/deployments?${qs}`, {
            headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
        });
        if (res.ok) {
            const j = (await res.json());
            const dep = (j.deployments ?? []).find((d) => d.meta?.githubCommitSha === input.sha) ?? null;
            if (dep) {
                lastDep = dep;
                if (dep.state === "READY") {
                    return { status: "ready", deploymentUrl: dep.url, detail: `Deployment ${dep.uid} is READY at ${dep.url}.` };
                }
                if (dep.state === "ERROR" || dep.state === "CANCELED") {
                    const logs = await fetchDeploymentLogs({ ...input, deploymentId: dep.uid }).catch(() => "");
                    return {
                        status: "error",
                        deploymentUrl: dep.url,
                        detail: `Deployment ${dep.uid} ended in state ${dep.state}.`,
                        logsExcerpt: logs.slice(0, 3000),
                    };
                }
            }
        }
        else {
            input.logger.warn("[vercel] deploy-verify list failed", { status: res.status });
        }
        await new Promise((r) => setTimeout(r, poll));
    }
    if (lastDep) {
        return { status: "pending", deploymentUrl: lastDep.url, detail: `Deployment ${lastDep.uid} still ${lastDep.state} after ${input.waitSeconds}s.` };
    }
    return { status: "unavailable", detail: `No Vercel deployment found for commit ${input.sha.slice(0, 12)} within ${input.waitSeconds}s.` };
}
async function fetchDeploymentLogs(input) {
    const qs = new URLSearchParams({ limit: "100" });
    if (input.teamId)
        qs.set("teamId", input.teamId);
    const res = await fetch(`${API}/v2/deployments/${input.deploymentId}/events?${qs}`, {
        headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
    });
    if (!res.ok)
        return "";
    const events = (await res.json());
    return events
        .filter((e) => e.text)
        .map((e) => e.text)
        .join("\n");
}
/**
 * Wait for the latest deployment on `branch` to reach a terminal state.
 * Returns the deployment record or null if the wait window elapses.
 */
export async function waitForPreview(input) {
    const start = Date.now();
    const poll = input.pollIntervalMs ?? 10_000;
    while (Date.now() - start < input.waitSeconds * 1000) {
        const dep = await latestDeploymentForBranch(input);
        if (dep && (dep.state === "READY" || dep.state === "ERROR" || dep.state === "CANCELED")) {
            return dep;
        }
        await new Promise((r) => setTimeout(r, poll));
    }
    return null;
}
async function latestDeploymentForBranch(input) {
    const qs = new URLSearchParams({ projectId: input.projectId, limit: "10" });
    if (input.teamId)
        qs.set("teamId", input.teamId);
    const res = await fetch(`${API}/v6/deployments?${qs}`, {
        headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
    });
    if (!res.ok) {
        input.logger.warn("[vercel] deployments list failed", { status: res.status });
        return null;
    }
    const j = (await res.json());
    const list = j.deployments ?? [];
    const forBranch = list.find((d) => (d.meta?.githubCommitRef === input.branch) || (d.meta?.branchAlias === input.branch));
    return forBranch ?? null;
}
/**
 * Fetch build + runtime logs for a deployment. We concat the last N lines
 * of each and return a bounded excerpt (adversary tokens are precious).
 */
export async function fetchBranchLogs(input) {
    let dep;
    try {
        dep = await waitForPreview(input);
    }
    catch (err) {
        input.logger.warn("[vercel] waitForPreview threw", { err: String(err) });
        return { provider: "vercel", status: "unavailable" };
    }
    if (!dep)
        return { provider: "vercel", status: "no_deploy_yet" };
    const status = dep.state === "READY" ? "ok" : dep.state === "ERROR" ? "build_failed" : "unavailable";
    const events = await fetchEvents(input, dep.uid).catch((err) => {
        input.logger.warn("[vercel] events fetch failed", { err: String(err) });
        return [];
    });
    const errorCount = events.filter((e) => /error|exception|unhandled/i.test(e.text)).length;
    const excerpt = events.slice(-60).map((e) => `[${e.type}] ${e.text}`).join("\n").slice(0, 8000);
    return {
        provider: "vercel",
        status,
        deploymentUrl: `https://${dep.url}`,
        logsExcerpt: excerpt,
        errorCount,
    };
}
async function fetchEvents(input, deploymentId) {
    const qs = new URLSearchParams();
    if (input.teamId)
        qs.set("teamId", input.teamId);
    const res = await fetch(`${API}/v3/deployments/${deploymentId}/events?${qs}`, {
        headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
    });
    if (!res.ok)
        throw new Error(`vercel events ${res.status}`);
    // Vercel returns an array; some plans stream NDJSON — handle either.
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
        const j = (await res.json());
        return j.map((e) => ({ text: e.text ?? e.payload?.text ?? "", type: e.type }));
    }
    const raw = await res.text();
    return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
        try {
            const j = JSON.parse(line);
            return { text: j.text ?? j.payload?.text ?? "", type: j.type ?? "log" };
        }
        catch {
            return { text: line, type: "log" };
        }
    });
}
//# sourceMappingURL=logs.js.map