/**
 * openclaw-agent-harness plugin entry.
 *
 * Exports the OpenClaw plugin descriptor. The runtime calls `register(api)`
 * once per lifecycle. We use that hook to:
 *   1. Parse plugin config (from OpenClaw config store)
 *   2. Open the state store (SQLite)
 *   3. Wire real subsystems (SDK, git, github, vercel, slack)
 *   4. Register runtime tools (harness_* namespace)
 *   5. Register Slack message hook (message_received)
 *   6. Register cron / service (retention prune, recovery, reaction poller)
 *
 * Shape mirrors memory-hybrid.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseHarnessConfig } from "./config.js";
import { openStateStoreSync } from "./state/store.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { SlackChannelListener } from "./slack/channel-listener.js";
import { Dispatcher } from "./slack/dispatcher.js";
import { SlackReactionsReader } from "./slack/reactions.js";
import { ReactionsPoller } from "./slack/reactions-poller.js";
import { PrMergedWatcher } from "./adapters/github-watcher.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { pruneRetention } from "./state/retention.js";
import { registerHarnessTools } from "./tools/registration.js";
import { setCurrentRuntime } from "./runtime-registry.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import { createPullRequest } from "./adapters/github.js";
import { SlackAdapter } from "./adapters/slack.js";
import { estimateSubTaskCost, runAdversarySdk, runClassifierSdk, runCrystalliserSdk, runLeadSdk, runWorkerSdk, } from "./adapters/claude-sdk.js";
import { fetchBranchLogs } from "./vercel/logs.js";
import { crystallisePrompt } from "./crystallise/prompt-refiner.js";
import { runLeadPlanner } from "./orchestrator/fable5-lead.js";
import { runWorker as runWorkerCore, buildWorkerSystemPrompt } from "./orchestrator/sonnet-worker.js";
import { runAdversary as runAdversaryCore } from "./orchestrator/fable5-adversary.js";
import { buildBashGuard } from "./safety/bash-guard.js";
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION } from "./version.js";
let currentRuntime = null;
/**
 * Synchronous phase of plugin bootstrap.
 *
 * OpenClaw's plugin loader requires `register()` to be synchronous, so all
 * tool/hook/service registration must complete before we hand control back.
 * Anything that requires I/O that CAN be sync (SQLite via node:sqlite,
 * mkdirSync) runs here; anything that must be async (credential vault
 * fetches, Slack API calls, session recovery notifies) is deferred to
 * {@link bootstrapHarnessAsync}, which runs as a background promise the
 * runtime holds a reference to for teardown ordering.
 */
export function bootstrapHarnessSync(api) {
    // OpenClaw plugin SDK provides config via `api.pluginConfig`.
    // We fall back to `api.getConfig()` for backwards-compat with older mock harnesses.
    const rawConfig = (api.pluginConfig ?? api.getConfig?.() ?? {});
    const config = parseHarnessConfig(rawConfig);
    // Crystalliser closure. Shared by the (optional) Slack dispatcher AND the
    // agent-callable `harness_run` tool, so the agent-orchestrated path uses
    // exactly the same classify -> refine pipeline as the autonomous listener.
    const crystallise = async (userText) => {
        const result = await crystallisePrompt(userText, {
            config,
            logger: api.logger,
            callClassifier: async () => runClassifierSdk({
                model: config.models.classifier,
                userText,
                timeoutSeconds: 60,
                apiKey: await anthropicApiKey(),
            }),
            callCrystalliser: async () => runCrystalliserSdk({
                model: config.models.lead,
                userText,
                timeoutSeconds: 120,
                apiKey: await anthropicApiKey(),
            }),
        });
        // crystallisePrompt returns a discriminated union; add cost=0 for now
        // (real cost is aggregated per-model call). Full cost tracking lives
        // in Phase D telemetry work.
        return result.kind === "brief"
            ? { kind: "brief", brief: result.brief, costUsd: 0 }
            : result.kind === "clarify"
                ? { kind: "clarify", question: result.question, costUsd: 0 }
                : { kind: "reject", intent: result.intent, reason: result.reason ?? "", costUsd: 0 };
    };
    const dbPath = config.storage.state_db_path.replace(/^~/, process.env.HOME ?? "");
    mkdirSync(dirname(dbPath), { recursive: true });
    const state = openStateStoreSync(dbPath);
    const budget = new BudgetEnforcer(config.budgets, state);
    const pat = new PatRouter(config.pat_routing);
    const creds = new CredentialAdapter({
        logger: api.logger,
        callCredentialGetTool: async (input) => {
            if (!api.callTool) {
                return { error: "api.callTool not available; cannot read vault" };
            }
            try {
                const r = (await api.callTool("credential_get", input));
                return r;
            }
            catch (err) {
                return { error: String(err) };
            }
        },
    });
    // Anthropic API key resolver for the embedded Claude Agent SDK.
    // Vault-first, then env fallback. Memoised (including the "not found"
    // result) so we only hit the vault once per runtime generation.
    let anthropicKeyResolved = false;
    let anthropicKeyValue;
    const anthropicApiKey = async () => {
        if (anthropicKeyResolved)
            return anthropicKeyValue;
        anthropicKeyResolved = true;
        const auth = config.models.auth ?? {};
        // 1) Vault (preferred).
        if (auth.credential_service) {
            try {
                const v = await creds.getToken(auth.credential_service, "api_key");
                if (v) {
                    anthropicKeyValue = v;
                    api.logger.info("[harness] anthropic key resolved from vault", { service: auth.credential_service });
                    return anthropicKeyValue;
                }
            }
            catch (err) {
                api.logger.warn("[harness] anthropic vault lookup failed; trying env fallback", { service: auth.credential_service, err: String(err) });
            }
        }
        // 2) Env fallback.
        const envName = auth.api_key_env || "ANTHROPIC_API_KEY";
        const envVal = process.env[envName];
        if (envVal) {
            anthropicKeyValue = envVal;
            api.logger.info("[harness] anthropic key resolved from env", { envVar: envName });
            return anthropicKeyValue;
        }
        api.logger.warn("[harness] no Anthropic API key resolved (vault + env both empty); SDK may fall back to interactive /login and fail in headless containers", { credentialService: auth.credential_service || "(unset)", envVar: envName });
        return undefined;
    };
    // Git token resolver: vault-first (by the pat-router-resolved service),
    // then per-provider env fallback (resolution.apiKeyEnv, e.g. GH_TOKEN /
    // GITLAB_TOKEN). Provider-aware and per-user: the caller passes the full
    // PAT resolution, whose credentialService already reflects the requesting
    // user + provider. NOT memoised across services (different users/repos ->
    // different services), but the CredentialAdapter caches per service.
    const resolveGitToken = async (r) => {
        try {
            const v = await creds.getToken(r.credentialService, "token");
            if (v)
                return v;
        }
        catch (err) {
            api.logger.warn("[harness] git vault lookup failed; trying env fallback", { service: r.credentialService, provider: r.provider, err: String(err) });
        }
        const envVal = process.env[r.apiKeyEnv];
        if (envVal) {
            api.logger.info("[harness] git token resolved from env", { envVar: r.apiKeyEnv, service: r.credentialService, provider: r.provider });
            return envVal;
        }
        throw new Error(`no ${r.provider} token resolved for service '${r.credentialService}' (vault empty/failed and env '${r.apiKeyEnv}' unset)`);
    };
    // Back-compat shim: resolve by bare service name using github defaults.
    const resolveGithubToken = async (service) => resolveGitToken({ credentialService: service, apiKeyEnv: config.pat_routing.auth?.api_key_env || "GH_TOKEN", provider: "github" });
    const git = new GitAdapter({
        worktreesRoot: config.storage.worktree_root,
        logger: api.logger,
    });
    const slack = new SlackAdapter({
        logger: api.logger,
        sendMessage: api.sendMessage ?? (async () => ({ ts: `${Date.now()}` })),
        addReaction: api.addReaction,
    });
    // ---- Orchestrator wiring ----
    const loop = new OrchestratorLoop({
        config,
        state,
        budget,
        pat,
        logger: api.logger,
        runLead: async (brief, ctx) => {
            const requester = ctx?.requester ?? config.slack.authorised_users[0];
            const raw = await runLeadSdk({
                model: config.models.lead,
                brief,
                reposAllowed: config.repos.allowed,
                timeoutSeconds: config.loop.worker_timeout_seconds,
                apiKey: await anthropicApiKey(),
                logger: api.logger,
            });
            return runLeadPlanner(brief, {
                config,
                logger: api.logger,
                callLeadModel: async () => raw,
                allocateWorktree: async (repo, branch) => {
                    const [owner] = repo.split("/");
                    // Determine PAT + identity for the ACTUAL requester (multi-user).
                    const resolution = pat.resolve({
                        slackUserId: requester,
                        gitHubUser: owner,
                        repoFullName: repo,
                    });
                    const ghToken = await resolveGitToken(resolution);
                    return git.allocate({
                        repoFullName: repo,
                        baseBranch: config.repos.default_base_branch,
                        sessionBranch: branch,
                        sessionId: `pending-${Date.now()}`,
                        ghToken,
                        commitIdentity: resolution.commitIdentity,
                    });
                },
                estimateCost: (p) => p.subTasks.reduce((acc, s) => acc + estimateSubTaskCost(config.models.worker, s.estimatedTokens), 0),
            });
        },
        runWorker: async ({ brief, subTask, plan, resumeSessionId, requester }) => {
            const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
            const canUseTool = buildBashGuard(config.safety);
            const resolution = pat.resolve({
                slackUserId: requester ?? config.slack.authorised_users[0],
                gitHubUser: plan.repo.split("/")[0],
                repoFullName: plan.repo,
            });
            return runWorkerCore(plan.worktreePath, brief, subTask, resolution.commitIdentity, {
                config,
                logger: api.logger,
                buildCanUseTool: () => canUseTool,
                runWorkerModel: async (params) => runWorkerSdk({ ...params, apiKey: await anthropicApiKey() }),
                gitBaseSha: (wt) => git.baseSha(wt),
                gitListChangedFiles: (wt, base) => git.listChangedFiles(wt, base),
                gitCommit: (wt, msg, id) => git.commit(wt, msg, id),
                // beta.7 fix #1: real observable-side-effect probes. These hit the
                // provider REST API / disk / git so a worker cannot self-report a
                // push, PR, or file write that never happened.
                buildVerifyProbes: (worktreePath, baseSha) => ({
                    remoteBranchExists: async (branch) => {
                        const b = branch || plan.branch;
                        try {
                            const ghToken = await resolveGitToken(resolution);
                            // Provider-specific ref lookup. GitHub: GET refs/heads/{b}.
                            // GitLab: GET /projects/{id}/repository/branches/{b}.
                            const [owner, repoName] = plan.repo.split("/");
                            let url;
                            if (resolution.provider === "gitlab") {
                                const projectId = encodeURIComponent(`${owner}/${repoName}`);
                                url = `${resolution.apiBase}/projects/${projectId}/repository/branches/${encodeURIComponent(b)}`;
                            }
                            else {
                                url = `${resolution.apiBase}/repos/${owner}/${repoName}/git/refs/heads/${b}`;
                            }
                            const res = await fetch(url, {
                                headers: {
                                    Authorization: `Bearer ${ghToken}`,
                                    Accept: "application/vnd.github+json",
                                },
                            });
                            return { exists: res.status === 200, detail: `${resolution.provider} ref lookup HTTP ${res.status}` };
                        }
                        catch (err) {
                            return { exists: false, detail: `ref lookup error: ${String(err)}` };
                        }
                    },
                    prUrlPresent: async () => {
                        // The worker never opens PRs (the loop does, post-review). So a
                        // sub-task claiming pr_opened is inherently suspect: only a
                        // persisted final_pr_url for this worktree/branch counts.
                        const row = state.db
                            .prepare(`SELECT final_pr_url FROM sessions WHERE worktree_path = ? AND final_pr_url IS NOT NULL AND final_pr_url != '' LIMIT 1`)
                            .get(worktreePath);
                        const url = row?.final_pr_url;
                        return { present: !!url, url: url ?? undefined, detail: url ? "final_pr_url set" : "no PR URL persisted for this worktree" };
                    },
                    fileWrittenSince: async (path, sinceMs) => {
                        try {
                            const abs = resolve(worktreePath, path);
                            const st = await stat(abs);
                            const freshEnough = st.mtimeMs >= sinceMs - 1000; // 1s clock slack
                            if (!freshEnough)
                                return { written: false, detail: `mtime ${new Date(st.mtimeMs).toISOString()} predates sub-task start` };
                            const changed = await git.listChangedFiles(worktreePath, baseSha);
                            const inDiff = changed.some((f) => resolve(worktreePath, f) === abs);
                            return { written: inDiff, detail: inDiff ? "file changed vs base + mtime fresh" : "file mtime fresh but not in diff vs base" };
                        }
                        catch (err) {
                            return { written: false, detail: `stat error: ${String(err)}` };
                        }
                    },
                    commitMadeSince: async (base) => {
                        try {
                            const head = await git.baseSha(worktreePath);
                            const made = head !== base;
                            return { made, detail: made ? `HEAD ${head.slice(0, 7)} != base ${base.slice(0, 7)}` : "no new commit vs base" };
                        }
                        catch (err) {
                            return { made: false, detail: `rev-parse error: ${String(err)}` };
                        }
                    },
                    // ---- beta.10 optional probes (worker path). Mirrors the loop-path
                    // factory so sub-task verification hits the same real endpoints
                    // regardless of who's driving verification. ----
                    fileExistsOnDisk: async (path) => {
                        try {
                            const abs = resolve(worktreePath, path);
                            const st = await stat(abs);
                            const exists = st.isFile();
                            const nonEmpty = st.size > 0;
                            return {
                                exists,
                                nonEmpty,
                                detail: exists
                                    ? nonEmpty
                                        ? `file present (${st.size} bytes)`
                                        : "file present but empty"
                                    : "path exists but is not a regular file",
                            };
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            return { exists: false, nonEmpty: false, detail: `stat error: ${msg}` };
                        }
                    },
                    fileCommittedSince: async (path, base) => {
                        try {
                            const files = await git.listCommittedFiles(worktreePath, base);
                            const absTarget = resolve(worktreePath, path);
                            const committed = files.some((f) => resolve(worktreePath, f) === absTarget || f === path);
                            return {
                                committed,
                                detail: committed
                                    ? `file appears in ${base ? base.slice(0, 7) : "base"}..HEAD (${files.length} file(s) total)`
                                    : `file not in commits since base (${files.length} file(s) checked)`,
                            };
                        }
                        catch (err) {
                            return { committed: false, detail: `git log error: ${String(err)}` };
                        }
                    },
                    remoteBranchSha: async (branch) => {
                        try {
                            const ghToken = await resolveGitToken(resolution).catch(() => undefined);
                            const sha = await git.remoteBranchSha(worktreePath, "origin", branch, ghToken);
                            return {
                                sha,
                                detail: sha ? `origin/${branch} tip ${sha.slice(0, 12)}` : `origin has no ref for ${branch}`,
                            };
                        }
                        catch (err) {
                            return { sha: undefined, detail: `ls-remote error: ${String(err)}` };
                        }
                    },
                    remoteFileExists: async (path, branch) => {
                        try {
                            const ghToken = await resolveGitToken(resolution);
                            const [owner, repoName] = plan.repo.split("/");
                            let url;
                            if (resolution.provider === "gitlab") {
                                const projectId = encodeURIComponent(`${owner}/${repoName}`);
                                url = `${resolution.apiBase}/projects/${projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
                            }
                            else {
                                url = `${resolution.apiBase}/repos/${owner}/${repoName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
                            }
                            const res = await fetch(url, {
                                headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
                            });
                            return {
                                exists: res.status === 200,
                                detail: `${resolution.provider} contents lookup HTTP ${res.status} for ${path}@${branch}`,
                            };
                        }
                        catch (err) {
                            return { exists: false, detail: `contents lookup error: ${String(err)}` };
                        }
                    },
                    prForBranch: async (branch) => {
                        try {
                            const ghToken = await resolveGitToken(resolution);
                            const [owner, repoName] = plan.repo.split("/");
                            if (resolution.provider === "gitlab") {
                                const projectId = encodeURIComponent(`${owner}/${repoName}`);
                                const url = `${resolution.apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
                                const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
                                const arr = (await res.json().catch(() => []));
                                const prs = Array.isArray(arr)
                                    ? arr
                                        .filter((m) => typeof m.iid === "number")
                                        .map((m) => ({
                                        number: m.iid,
                                        state: m.state ?? "unknown",
                                        draft: !!(m.draft || m.work_in_progress),
                                        url: m.web_url ?? "",
                                    }))
                                    : [];
                                return { count: prs.length, prs, detail: `gitlab MR count ${prs.length} for source_branch=${branch}` };
                            }
                            const url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all`;
                            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                            const arr = (await res.json().catch(() => []));
                            const prs = Array.isArray(arr)
                                ? arr
                                    .filter((p) => typeof p.number === "number")
                                    .map((p) => ({
                                    number: p.number,
                                    state: p.state ?? "unknown",
                                    draft: !!p.draft,
                                    url: p.html_url ?? "",
                                }))
                                : [];
                            return { count: prs.length, prs, detail: `github PR count ${prs.length} for head=${owner}:${branch}` };
                        }
                        catch (err) {
                            return { count: 0, prs: [], detail: `PR lookup error: ${String(err)}` };
                        }
                    },
                    prFiles: async (prNumber) => {
                        try {
                            const ghToken = await resolveGitToken(resolution);
                            const [owner, repoName] = plan.repo.split("/");
                            let url;
                            if (resolution.provider === "gitlab") {
                                const projectId = encodeURIComponent(`${owner}/${repoName}`);
                                url = `${resolution.apiBase}/projects/${projectId}/merge_requests/${prNumber}/changes`;
                                const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
                                const j = (await res.json().catch(() => ({})));
                                const files = (j.changes ?? [])
                                    .map((c) => ({ filename: c.new_path ?? c.old_path ?? "" }))
                                    .filter((f) => f.filename);
                                return { files, detail: `gitlab MR !${prNumber} changes ${files.length}` };
                            }
                            url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/files?per_page=100`;
                            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                            const arr = (await res.json().catch(() => []));
                            const files = Array.isArray(arr)
                                ? arr.filter((f) => typeof f.filename === "string").map((f) => ({ filename: f.filename }))
                                : [];
                            return { files, detail: `github PR #${prNumber} files ${files.length}` };
                        }
                        catch (err) {
                            return { files: [], detail: `PR files lookup error: ${String(err)}` };
                        }
                    },
                    localHeadSha: async () => {
                        try {
                            const sha = await git.baseSha(worktreePath);
                            return { sha, detail: `worktree HEAD ${sha.slice(0, 12)}` };
                        }
                        catch (err) {
                            return { sha: "", detail: `rev-parse error: ${String(err)}` };
                        }
                    },
                }),
            }, resumeSessionId);
        },
        runAdversary: async ({ brief, plan, runtime }) => {
            const diffText = await git.diff(plan.worktreePath, config.repos.default_base_branch);
            const diffFile = resolve(config.storage.worktree_root.replace(/^~/, process.env.HOME ?? ""), `${Date.now()}.diff`);
            await mkdir(dirname(diffFile), { recursive: true });
            await writeFile(diffFile, diffText, "utf8");
            return runAdversaryCore({
                crystallisedPrompt: brief.title,
                diffPath: diffFile,
                repoPath: plan.worktreePath,
                runtime,
                reviewChecklist: plan.reviewChecklist,
                model: config.models.adversary,
                timeoutSeconds: config.loop.adversary_timeout_seconds,
            }, {
                logger: api.logger,
                readDiff: async (p) => (await readFile(p, "utf8")),
                callAdversaryModel: async (params) => {
                    const r = await runAdversarySdk({ ...params, apiKey: await anthropicApiKey() });
                    return {
                        parsed: {
                            verdict: r.parsed.verdict,
                            findings: r.parsed.findings.map((f) => ({
                                dimension: f.dimension ?? "quality",
                                severity: f.severity ?? "low",
                                title: f.title ?? "(untitled)",
                                detail: f.detail ?? "",
                                file: f.file,
                                line: f.line,
                            })),
                            summary: r.parsed.summary,
                        },
                        sdkSessionId: r.sdkSessionId,
                        costUsd: r.costUsd,
                        tokensIn: r.tokensIn,
                        tokensOut: r.tokensOut,
                    };
                },
            });
        },
        fetchRuntime: async ({ plan, sessionId }) => {
            // Prefer a manual upload if one exists (most recent wins). This lets
            // non-Vercel deploys hand-supply logs via the harness_upload_logs tool.
            const upload = state.db
                .prepare(`SELECT status, source, logs_excerpt, error_count, deployment_url, uploaded_at, uploaded_by
             FROM runtime_uploads
            WHERE session_id = ?
         ORDER BY uploaded_at DESC
            LIMIT 1`)
                .get(sessionId);
            if (upload) {
                return {
                    provider: "manual",
                    status: upload.status,
                    deploymentUrl: upload.deployment_url ?? undefined,
                    logsExcerpt: upload.logs_excerpt,
                    errorCount: upload.error_count ?? undefined,
                    uploadedAt: upload.uploaded_at,
                    uploadedBy: upload.uploaded_by,
                    source: upload.source ?? undefined,
                };
            }
            // Otherwise fall back to Vercel bridge, only if explicitly enabled.
            if (!config.vercel?.enabled)
                return undefined;
            const token = await creds.getToken(config.vercel.credential_service);
            return fetchBranchLogs({
                vercelToken: token,
                teamId: config.vercel.team_id,
                projectId: config.vercel.project_id,
                branch: plan.branch,
                waitSeconds: config.vercel.preview_wait_seconds,
                logger: api.logger,
            });
        },
        pushBranchAndOpenPr: async ({ plan, brief, reviewReport, requester }) => {
            const resolution = pat.resolve({
                slackUserId: requester ?? config.slack.authorised_users[0],
                gitHubUser: plan.repo.split("/")[0],
                repoFullName: plan.repo,
            });
            const ghToken = await resolveGitToken(resolution);
            await git.pushBranch(plan.worktreePath, "origin", plan.branch, ghToken);
            if (resolution.provider !== "github") {
                // GitLab merge-request creation is a separate adapter (tracked in
                // issue #25). Token resolution + push work for GitLab; MR open does
                // not yet. Fail loud rather than silently mis-calling the GitHub API.
                throw new Error(`provider '${resolution.provider}' push succeeded but automated MR/PR creation is not yet implemented (see issue #25); open the merge request manually for branch '${plan.branch}'`);
            }
            const pr = await createPullRequest({
                repoFullName: plan.repo,
                head: plan.branch,
                base: config.repos.default_base_branch,
                title: `harness: ${brief.title}`,
                body: renderPrBody(brief, reviewReport),
                ghToken,
                draft: reviewReport.verdict !== "pass",
            });
            return pr.htmlUrl;
        },
        // beta.8 fix #1: HARNESS-SIDE observable-side-effect probes. The loop
        // runs these after every sub-task, independent of the worker. They hit
        // git / the provider REST API / disk directly so a confabulated
        // "I pushed" / "I opened a PR" is caught deterministically.
        worktreeHeadSha: async (worktreePath) => git.baseSha(worktreePath).catch(() => ""),
        // beta.16 fix #3: release the per-session worktree on terminal
        // transitions (loop.shipped / loop.aborted / hard failure). Prior to
        // beta.16, worktree cleanup was only wired via the pr-watcher (on PR
        // close/merge), so every successful smoke left a `pending-<ts>`
        // worktree holding the smoke branch and blocked the next fetch on
        // that branch. The pr-watcher's release-on-close remains a safety net.
        releaseWorktree: async ({ sessionId, repoFullName, reason }) => {
            api.logger.info("[harness] releasing worktree on terminal transition", { sessionId, reason });
            await git.release(sessionId, repoFullName);
        },
        buildVerifyProbes: ({ plan, requester, worktreePath, baseSha }) => {
            const resolution = pat.resolve({
                slackUserId: requester ?? config.slack.authorised_users[0],
                gitHubUser: plan.repo.split("/")[0],
                repoFullName: plan.repo,
            });
            return {
                remoteBranchExists: async (branch) => {
                    const b = branch || plan.branch;
                    try {
                        const ghToken = await resolveGitToken(resolution);
                        const [owner, repoName] = plan.repo.split("/");
                        let url;
                        if (resolution.provider === "gitlab") {
                            const projectId = encodeURIComponent(`${owner}/${repoName}`);
                            url = `${resolution.apiBase}/projects/${projectId}/repository/branches/${encodeURIComponent(b)}`;
                        }
                        else {
                            url = `${resolution.apiBase}/repos/${owner}/${repoName}/git/refs/heads/${b}`;
                        }
                        const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                        return { exists: res.status === 200, detail: `${resolution.provider} ref lookup HTTP ${res.status} for ${b}` };
                    }
                    catch (err) {
                        return { exists: false, detail: `ref lookup error: ${String(err)}` };
                    }
                },
                prUrlPresent: async () => {
                    // Independently query the provider for an OPEN/ANY PR whose head is
                    // this branch. Do NOT trust a persisted URL alone.
                    try {
                        const ghToken = await resolveGitToken(resolution);
                        const [owner, repoName] = plan.repo.split("/");
                        if (resolution.provider === "gitlab") {
                            const projectId = encodeURIComponent(`${owner}/${repoName}`);
                            const url = `${resolution.apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(plan.branch)}&state=all`;
                            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
                            const arr = (await res.json().catch(() => []));
                            const present = Array.isArray(arr) && arr.length > 0;
                            return { present, url: present ? arr[0].web_url : undefined, detail: `gitlab MR count ${Array.isArray(arr) ? arr.length : 0}` };
                        }
                        const url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls?head=${owner}:${encodeURIComponent(plan.branch)}&state=all`;
                        const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                        const arr = (await res.json().catch(() => []));
                        const present = Array.isArray(arr) && arr.length > 0;
                        return { present, url: present ? arr[0].html_url : undefined, detail: `github PR count ${Array.isArray(arr) ? arr.length : 0}` };
                    }
                    catch (err) {
                        return { present: false, detail: `PR lookup error: ${String(err)}` };
                    }
                },
                fileWrittenSince: async (path, sinceMs) => {
                    try {
                        const abs = resolve(worktreePath, path);
                        const st = await stat(abs);
                        const freshEnough = st.mtimeMs >= sinceMs - 1000;
                        const changed = await git.listChangedFiles(worktreePath, baseSha || (await git.baseSha(worktreePath)));
                        const inDiff = changed.some((f) => resolve(worktreePath, f) === abs);
                        return { written: (sinceMs === 0 ? true : freshEnough) && inDiff, detail: inDiff ? "file changed vs base" : "file not in diff vs base" };
                    }
                    catch (err) {
                        return { written: false, detail: `stat error: ${String(err)}` };
                    }
                },
                commitMadeSince: async (base) => {
                    try {
                        const head = await git.baseSha(worktreePath);
                        const made = !!base && head !== base;
                        return { made, detail: made ? `HEAD ${head.slice(0, 7)} != base ${base.slice(0, 7)}` : `no new commit (HEAD ${head.slice(0, 7)} == base ${(base || "").slice(0, 7)})` };
                    }
                    catch (err) {
                        return { made: false, detail: `rev-parse error: ${String(err)}` };
                    }
                },
                // ---- beta.10 optional probes (fully wired) ----
                /** file_written kind: fs.stat on the worktree. Includes untracked files (fixes beta.8 bug). */
                fileExistsOnDisk: async (path) => {
                    try {
                        const abs = resolve(worktreePath, path);
                        const st = await stat(abs);
                        const exists = st.isFile();
                        const nonEmpty = st.size > 0;
                        return {
                            exists,
                            nonEmpty,
                            detail: exists
                                ? nonEmpty
                                    ? `file present (${st.size} bytes)`
                                    : "file present but empty"
                                : "path exists but is not a regular file",
                        };
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return { exists: false, nonEmpty: false, detail: `stat error: ${msg}` };
                    }
                },
                /** file_committed kind: file appears in `git log base..HEAD --name-only`. */
                fileCommittedSince: async (path, base) => {
                    try {
                        const files = await git.listCommittedFiles(worktreePath, base);
                        const absTarget = resolve(worktreePath, path);
                        const committed = files.some((f) => resolve(worktreePath, f) === absTarget || f === path);
                        return {
                            committed,
                            detail: committed
                                ? `file appears in ${base ? base.slice(0, 7) : "base"}..HEAD (${files.length} file(s) total)`
                                : `file not in commits since base (${files.length} file(s) checked)`,
                        };
                    }
                    catch (err) {
                        return { committed: false, detail: `git log error: ${String(err)}` };
                    }
                },
                /** remote_branch_exists / commit_sha_matches: tip SHA of `branch` on origin via git ls-remote. */
                remoteBranchSha: async (branch) => {
                    try {
                        const ghToken = await resolveGitToken(resolution).catch(() => undefined);
                        const sha = await git.remoteBranchSha(worktreePath, "origin", branch, ghToken);
                        return {
                            sha,
                            detail: sha ? `origin/${branch} tip ${sha.slice(0, 12)}` : `origin has no ref for ${branch}`,
                        };
                    }
                    catch (err) {
                        return { sha: undefined, detail: `ls-remote error: ${String(err)}` };
                    }
                },
                /** file_pushed: GET /repos/{owner}/{repo}/contents/{path}?ref={branch}. Provider-aware. */
                remoteFileExists: async (path, branch) => {
                    try {
                        const ghToken = await resolveGitToken(resolution);
                        const [owner, repoName] = plan.repo.split("/");
                        let url;
                        if (resolution.provider === "gitlab") {
                            const projectId = encodeURIComponent(`${owner}/${repoName}`);
                            url = `${resolution.apiBase}/projects/${projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
                        }
                        else {
                            url = `${resolution.apiBase}/repos/${owner}/${repoName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
                        }
                        const res = await fetch(url, {
                            headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
                        });
                        return {
                            exists: res.status === 200,
                            detail: `${resolution.provider} contents lookup HTTP ${res.status} for ${path}@${branch}`,
                        };
                    }
                    catch (err) {
                        return { exists: false, detail: `contents lookup error: ${String(err)}` };
                    }
                },
                /** pr_opened / pr_state / file_in_pr helper: PRs whose head is `branch`. Provider-aware. */
                prForBranch: async (branch) => {
                    try {
                        const ghToken = await resolveGitToken(resolution);
                        const [owner, repoName] = plan.repo.split("/");
                        if (resolution.provider === "gitlab") {
                            const projectId = encodeURIComponent(`${owner}/${repoName}`);
                            const url = `${resolution.apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
                            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
                            const arr = (await res.json().catch(() => []));
                            const prs = Array.isArray(arr)
                                ? arr
                                    .filter((m) => typeof m.iid === "number")
                                    .map((m) => ({
                                    number: m.iid,
                                    state: m.state ?? "unknown",
                                    draft: !!(m.draft || m.work_in_progress),
                                    url: m.web_url ?? "",
                                }))
                                : [];
                            return { count: prs.length, prs, detail: `gitlab MR count ${prs.length} for source_branch=${branch}` };
                        }
                        const url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all`;
                        const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                        const arr = (await res.json().catch(() => []));
                        const prs = Array.isArray(arr)
                            ? arr
                                .filter((p) => typeof p.number === "number")
                                .map((p) => ({
                                number: p.number,
                                state: p.state ?? "unknown",
                                draft: !!p.draft,
                                url: p.html_url ?? "",
                            }))
                            : [];
                        return { count: prs.length, prs, detail: `github PR count ${prs.length} for head=${owner}:${branch}` };
                    }
                    catch (err) {
                        return { count: 0, prs: [], detail: `PR lookup error: ${String(err)}` };
                    }
                },
                /** file_in_pr: GET /repos/.../pulls/{n}/files. Provider-aware. */
                prFiles: async (prNumber) => {
                    try {
                        const ghToken = await resolveGitToken(resolution);
                        const [owner, repoName] = plan.repo.split("/");
                        let url;
                        if (resolution.provider === "gitlab") {
                            const projectId = encodeURIComponent(`${owner}/${repoName}`);
                            url = `${resolution.apiBase}/projects/${projectId}/merge_requests/${prNumber}/changes`;
                            const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}` } });
                            const j = (await res.json().catch(() => ({})));
                            const files = (j.changes ?? [])
                                .map((c) => ({ filename: c.new_path ?? c.old_path ?? "" }))
                                .filter((f) => f.filename);
                            return { files, detail: `gitlab MR !${prNumber} changes ${files.length}` };
                        }
                        url = `${resolution.apiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/files?per_page=100`;
                        const res = await fetch(url, { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } });
                        const arr = (await res.json().catch(() => []));
                        const files = Array.isArray(arr)
                            ? arr.filter((f) => typeof f.filename === "string").map((f) => ({ filename: f.filename }))
                            : [];
                        return { files, detail: `github PR #${prNumber} files ${files.length}` };
                    }
                    catch (err) {
                        return { files: [], detail: `PR files lookup error: ${String(err)}` };
                    }
                },
                /** commit_sha_matches helper: local worktree HEAD SHA. */
                localHeadSha: async () => {
                    try {
                        const sha = await git.baseSha(worktreePath);
                        return { sha, detail: `worktree HEAD ${sha.slice(0, 12)}` };
                    }
                    catch (err) {
                        return { sha: "", detail: `rev-parse error: ${String(err)}` };
                    }
                },
            };
        },
        readReactions: async (sessionId) => {
            // Reactions are surfaced via a separate poller (see below) that writes
            // into sessions.reactions_json. Read from there.
            const row = state.db.prepare(`SELECT reactions_json FROM sessions WHERE id = ?`).get(sessionId);
            const parsed = row?.reactions_json ? JSON.parse(row.reactions_json) : {};
            return {
                shipIt: !!parsed.shipIt,
                abort: !!parsed.abort,
                pause: !!parsed.pause,
                budgetBump: !!parsed.budgetBump,
            };
        },
        reportProgress: async (sessionId, status, meta) => {
            const row = state.db.prepare(`SELECT slack_channel, slack_thread FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return;
            const label = {
                crystallising: ":brain: Crystallising…",
                planning: ":memo: Planning…",
                executing: `:hammer: Executing cycle ${meta?.cycle ?? 1}…`,
                reviewing: `:mag: Adversarial review of cycle ${meta?.cycle ?? 1}…`,
                done: ":tada: Done.",
                failed: ":x: Failed.",
                aborted: ":octagonal_sign: Aborted.",
            }[status] ?? status;
            await slack.replyInThread(row.slack_channel, row.slack_thread, label).catch(() => { });
        },
    });
    const dispatcher = new Dispatcher({
        config,
        state,
        loop,
        logger: api.logger,
        crystallise,
        slackReply: (channel, threadTs, text) => slack.replyInThread(channel, threadTs, text),
        slackReact: (channel, ts, name) => slack.addReaction(channel, ts, name),
    });
    const listener = new SlackChannelListener({
        config,
        state,
        dispatcher,
        logger: api.logger,
    });
    const runtime = {
        config, state, budget, pat, loop, listener, dispatcher, slack, git, creds,
        crystallise,
        anthropicApiKey,
        githubToken: resolveGithubToken,
        gitToken: resolveGitToken,
        githubServiceFor: (repoFullName) => {
            const repo = repoFullName ?? config.repos.allowed.find((r) => !r.includes("*")) ?? config.repos.allowed[0];
            if (!repo)
                return undefined;
            // A glob like "owner/<star>" can't resolve a concrete service; require
            // a concrete owner/repo. Replace a trailing glob segment to at least
            // resolve the owner. (Built without a literal slash-star regex so the
            // sdk-compliance comment stripper doesn't mis-parse it.)
            const glob = "/" + "*"; // avoid a literal slash-star token in source
            const concrete = repo.endsWith(glob) ? repo.slice(0, -1) + "_probe" : repo;
            try {
                return pat.resolve({
                    slackUserId: config.slack.authorised_users[0] ?? "unknown",
                    gitHubUser: concrete.split("/")[0],
                    repoFullName: concrete,
                }).credentialService;
            }
            catch {
                return undefined;
            }
        },
        gitResolutionFor: (repoFullName) => {
            const repo = repoFullName ?? config.repos.allowed.find((r) => !r.includes("*")) ?? config.repos.allowed[0];
            if (!repo)
                return undefined;
            const glob = "/" + "*";
            const concrete = repo.endsWith(glob) ? repo.slice(0, -1) + "_probe" : repo;
            try {
                const r = pat.resolve({
                    slackUserId: config.slack.authorised_users[0] ?? "unknown",
                    gitHubUser: concrete.split("/")[0],
                    repoFullName: concrete,
                });
                return { credentialService: r.credentialService, provider: r.provider, apiBase: r.apiBase, apiKeyEnv: r.apiKeyEnv };
            }
            catch {
                return undefined;
            }
        },
        disposers: [],
    };
    // Tools (sync)
    const disposeTools = registerHarnessTools(api, runtime);
    runtime.disposers.push(disposeTools);
    // Subscribe to inbound Slack messages.
    //
    // The SDK exposes TWO distinct concepts here:
    //   * `api.on(event, handler)` -- lightweight event-bus subscribe, the
    //     path hybrid-memory uses for `message_received`. Returns an
    //     unsubscribe fn. This is what we want for reacting to inbound
    //     Slack messages.
    //   * `api.registerHook(events, handler, opts)` -- registers a NAMED,
    //     enumerable, first-class plugin hook (shows up in
    //     `openclaw plugins list ... hooks`). Requires `opts.name`.
    //
    // We prefer `api.on` (matches hybrid-memory's pattern for this exact
    // event) and fall back to `api.registerHook` with a proper `opts.name`
    // if only the latter is present. Older mock APIs may expose neither.
    //
    // Handler itself is async; only `register()` needs to be sync, which
    // this code is (we do NOT await api.on / api.registerHook here).
    const messageHandler = async (event) => {
        const slackEvt = event;
        if (!slackEvt?.payload)
            return;
        if (slackEvt.channel?.provider !== "slack")
            return;
        await listener.handle(slackEvt.payload);
    };
    // AGENT-ORCHESTRATED BY DEFAULT.
    //
    // By default (`slack.listener_enabled: false`) the harness does NOT
    // subscribe to inbound Slack messages. The OpenClaw agent owns the
    // conversation and drives the harness by calling its tools
    // (`harness_run`, `harness_start_session`, `harness_status`, ...). This
    // avoids the plugin competing with the OpenClaw agent for the same
    // messages, and keeps the agent as the single orchestrator.
    //
    // Autonomous mode (`slack.listener_enabled: true`) is opt-in: the plugin
    // then treats allow-listed messages in `slack.channel` as dev requests.
    if (!config.slack.listener_enabled) {
        api.logger.info("[harness] slack.listener_enabled=false -- agent-orchestrated mode. " +
            "The plugin will NOT listen to Slack; drive it via harness_run / harness_start_session tools.");
    }
    else if (typeof api.on === "function") {
        // The ONLY valid event name is `message_received` (underscore). It is in
        // the runtime's PLUGIN_HOOK_NAMES list and is dispatched on every inbound
        // message. The dotted form `message.received` is NOT a real hook name --
        // registering it produces `unknown typed hook "message.received" ignored`.
        //
        // `api.on(...)` on this runtime ALWAYS returns `undefined` (registerTypedHook
        // pushes to registry.typedHooks and returns void), so we must NOT gate
        // registration on a truthy return; typed hooks are torn down with the plugin.
        const maybeDispose = api.on("message_received", messageHandler);
        if (typeof maybeDispose === "function") {
            runtime.disposers.push(maybeDispose);
        }
        api.logger.info("[harness] slack.listener_enabled=true -- autonomous mode, listening on message_received.");
    }
    else if (typeof api.registerHook === "function") {
        // Named hook path (older/alternate SDK shape). `opts.name` is REQUIRED
        // by the SDK registry. Register ONLY the valid underscore event name.
        const dispose = api.registerHook(["message_received"], messageHandler, {
            name: `${PLUGIN_ID}:slack-message-listener`,
            description: "Forward inbound Slack messages to the harness channel listener",
        });
        runtime.disposers.push(() => {
            if (typeof dispose === "function")
                dispose();
            else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function")
                dispose.dispose();
        });
    }
    else {
        api.logger.warn("[harness] slack.listener_enabled=true but neither api.on nor api.registerHook present; Slack listener will be idle.");
    }
    // Retention prune on service start (sync -- pruneRetention is a plain
    // SQL delete, no I/O beyond the DB).
    try {
        const r = pruneRetention(state, {
            auditRetentionDays: config.storage.audit_retention_days,
            pruneTerminalSessions: config.storage.prune_terminal_sessions,
            pruneTerminalSessionsDays: config.storage.prune_terminal_sessions_days,
        });
        api.logger.info("[harness] retention prune on start", r);
    }
    catch (err) {
        api.logger.warn("[harness] retention prune on start failed", { err: String(err) });
    }
    // PR-merged watcher (sync registration; start() runs async internally).
    {
        const watcher = new PrMergedWatcher(state, {
            logger: api.logger,
            intervalMs: 300_000,
            git,
            slackNotify: (ch, ts, text) => slack.replyInThread(ch, ts, text),
            resolveGhToken: async (repo, slackUserId) => {
                const [owner] = repo.split("/");
                const resolution = pat.resolve({
                    slackUserId,
                    gitHubUser: owner,
                    repoFullName: repo,
                });
                return creds.getToken(resolution.credentialService);
            },
        });
        if (api.registerService) {
            const dispose = api.registerService({
                id: `${PLUGIN_ID}:pr-watcher`,
                start: () => watcher.start(),
                stop: () => watcher.stop(),
            });
            runtime.disposers.push(async () => {
                await watcher.stop();
                if (typeof dispose === "function")
                    dispose();
                else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function")
                    dispose.dispose();
            });
        }
        else {
            // Fire-and-forget start; register() must return sync.
            // watcher.start() is idempotent, and stop() awaits any in-flight tick.
            void watcher.start().catch((err) => api.logger.warn("[harness] pr-watcher.start failed", { err: String(err) }));
            runtime.disposers.push(() => watcher.stop());
        }
    }
    // Nightly retention timer (24h). Uses api.registerService if available so
    // the runtime owns the lifecycle; else falls back to an in-process timer.
    {
        const dayMs = 24 * 60 * 60 * 1000;
        let timer;
        const tick = () => {
            try {
                const r = pruneRetention(state, {
                    auditRetentionDays: config.storage.audit_retention_days,
                    pruneTerminalSessions: config.storage.prune_terminal_sessions,
                    pruneTerminalSessionsDays: config.storage.prune_terminal_sessions_days,
                });
                api.logger.info("[harness] retention nightly prune", r);
            }
            catch (err) {
                api.logger.warn("[harness] retention nightly prune failed", { err: String(err) });
            }
        };
        if (api.registerService) {
            const dispose = api.registerService({
                id: `${PLUGIN_ID}:retention-nightly`,
                start: () => { timer = setInterval(tick, dayMs); },
                stop: () => { if (timer)
                    clearInterval(timer); timer = undefined; },
            });
            runtime.disposers.push(async () => {
                if (timer)
                    clearInterval(timer);
                timer = undefined;
                if (typeof dispose === "function")
                    dispose();
                else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function")
                    dispose.dispose();
            });
        }
        else {
            timer = setInterval(tick, dayMs);
            runtime.disposers.push(() => { if (timer)
                clearInterval(timer); timer = undefined; });
        }
    }
    currentRuntime = runtime;
    setCurrentRuntime(runtime);
    return runtime;
}
/**
 * Asynchronous phase of plugin bootstrap. Runs as a fire-and-forget promise
 * after {@link bootstrapHarnessSync} has returned control to the OpenClaw
 * loader. Handles anything that requires network / vault I/O:
 *
 *   - fetching the Slack bot token from the credential vault and starting
 *     the reactions poller
 *   - session recovery (mark stale sessions as interrupted, notify Slack)
 *
 * The returned promise is stored on `runtime.asyncBootstrap` so teardown
 * can await it if it needs to (e.g. to ensure recovery notifies have
 * flushed before closing the state DB).
 */
export async function bootstrapHarnessAsync(runtime, api) {
    const { config, state, creds, slack } = runtime;
    // Reactions poller (only if slack.credential_service is set so we have a bot token).
    if (config.slack.credential_service) {
        try {
            const slackToken = await creds.getToken(config.slack.credential_service);
            const reader = new SlackReactionsReader({
                config,
                state,
                slackToken,
                logger: api.logger,
            });
            const poller = new ReactionsPoller(state, reader, {
                intervalMs: config.slack.reactions_poll_ms ?? 15000,
                logger: api.logger,
            });
            if (api.registerService) {
                const dispose = api.registerService({
                    id: `${PLUGIN_ID}:reactions-poller`,
                    start: () => poller.start(),
                    stop: () => poller.stop(),
                });
                runtime.disposers.push(async () => {
                    await poller.stop();
                    if (typeof dispose === "function")
                        dispose();
                    else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function")
                        dispose.dispose();
                });
            }
            else {
                await poller.start();
                runtime.disposers.push(() => poller.stop());
            }
        }
        catch (err) {
            api.logger.warn("[harness] reactions poller not started", { err: String(err) });
        }
    }
    else {
        api.logger.info("[harness] slack.credential_service not set; reactions poller idle");
    }
    // Session recovery: mark stale non-terminal sessions as 'interrupted' and
    // notify their Slack threads. Fresh in-flight sessions stay 'resumable'
    // (deliberately conservative -- see src/state/recovery.ts).
    try {
        const { recoverSessions } = await import("./state/recovery.js");
        const result = await recoverSessions(state, {
            staleAfterSeconds: config.loop.session_hard_timeout_seconds,
            logger: api.logger,
            notify: async (s) => {
                const msg = s.stale
                    ? `:arrows_counterclockwise: This harness session was interrupted at cycle ${s.cycles_ran} (state \`${s.status}\`). React :arrows_counterclockwise: to resume, :x: to abort.`
                    : `:arrows_counterclockwise: Harness restarted while this session was mid-flight (cycle ${s.cycles_ran}). Watching for signals.`;
                await slack.replyInThread(s.slack_channel, s.slack_thread, msg).catch((err) => {
                    api.logger.warn("[harness] recovery notify failed", { err: String(err), sessionId: s.id });
                });
            },
        });
        if (result.interrupted + result.resumable > 0) {
            api.logger.warn(`[harness] recovery: ${result.interrupted} interrupted, ${result.resumable} resumable`);
        }
    }
    catch (err) {
        api.logger.warn("[harness] session recovery on start failed", { err: String(err) });
    }
}
/**
 * Backwards-compat facade. New code should prefer
 * `bootstrapHarnessSync` + `bootstrapHarnessAsync`. Tests still call this.
 */
export async function bootstrapHarness(api) {
    const runtime = bootstrapHarnessSync(api);
    await bootstrapHarnessAsync(runtime, api);
    return runtime;
}
function renderPrBody(brief, review) {
    return [
        `## Motivation`,
        brief.motivation,
        ``,
        `## Acceptance criteria`,
        ...brief.acceptanceCriteria.map((c) => `- [ ] ${c}`),
        ``,
        `## Adversarial review`,
        `Verdict: **${review.verdict}**`,
        ``,
        review.summary,
        ``,
        review.findings.length ? `### Findings (${review.findings.length})` : "",
        ...review.findings.map((f) => `- **${(f.severity ?? "info").toUpperCase()}** [${f.dimension}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  ${f.detail}`),
        ``,
        `---`,
        `_Opened by openclaw-agent-harness ${PLUGIN_VERSION.pluginVersion}._`,
    ]
        .filter(Boolean)
        .join("\n");
}
async function teardown(runtime, api) {
    // Wait for the async bootstrap phase to complete before tearing things
    // down. Otherwise the reactions poller could try to start after we've
    // closed the DB, or recovery could try to notify after `slack` is gone.
    if (runtime.asyncBootstrap) {
        try {
            await runtime.asyncBootstrap;
        }
        catch (err) {
            api.logger.warn("[harness] async bootstrap rejected during teardown", { err: String(err) });
        }
    }
    for (const d of runtime.disposers.reverse()) {
        try {
            await d();
        }
        catch (err) {
            api.logger.warn("[harness] disposer failed", { err: String(err) });
        }
    }
    try {
        runtime.state.close();
    }
    catch (err) {
        api.logger.warn("[harness] state.close failed", { err: String(err) });
    }
    runtime.creds.purge();
}
// OpenClaw plugin entry.
//
// The runtime loader calls `definePluginEntry()`-wrapped exports; the raw
// object form is not recognised. We import from the SDK subpath.
// See docs/plugins/sdk-entrypoints.md.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - types are provided by the host OpenClaw runtime at install time
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export default definePluginEntry({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    versionInfo: PLUGIN_VERSION,
    /**
     * OpenClaw plugin loader requires `register()` to be SYNCHRONOUS.
     *
     * Returning a Promise (i.e. declaring this as `async`) causes the
     * gateway to reject the plugin with:
     *
     *   Error: plugin register must be synchronous
     *
     * We therefore do all sync setup (config parse, DB open, tool/hook/
     * service registration) inline in this call, and kick off the async
     * phase (Slack token fetch, reactions poller, session recovery) as
     * a fire-and-forget promise stored on `runtime.asyncBootstrap`.
     * Teardown awaits that promise so nothing runs on a closed DB.
     *
     * This mirrors the pattern used by openclaw-hybrid-memory and other
     * reference plugins.
     */
    register(api) {
        // Bridge the OpenClaw SDK API to our internal HarnessPluginApi shape.
        // The SDK exposes a superset of what we consume; the fields we use
        // (`logger`, `registerTool`, `registerHook`, `registerService`,
        // `pluginConfig`, `workspaceDir`, `sendMessage`, `addReaction`,
        // `callTool`) are all present on the runtime `api` object.
        const pluginApi = api;
        if (pluginApi.registrationMode === "cli-metadata") {
            pluginApi.logger.info("[harness] cli-metadata registration");
            return;
        }
        if (currentRuntime) {
            pluginApi.logger.info("[harness] re-registering; scheduling teardown of previous runtime");
            const doomed = currentRuntime;
            currentRuntime = null;
            setCurrentRuntime(null);
            // Fire-and-forget: we can't await teardown here without violating the
            // sync-register contract. teardown() awaits doomed.asyncBootstrap so
            // it doesn't tear down mid-bootstrap.
            void teardown(doomed, pluginApi).catch((err) => {
                pluginApi.logger.warn("[harness] previous-runtime teardown failed", { err: String(err) });
            });
        }
        let runtime;
        try {
            runtime = bootstrapHarnessSync(pluginApi);
        }
        catch (err) {
            pluginApi.logger.error("[harness] sync bootstrap failed", { err: String(err) });
            throw err;
        }
        // Kick off async bootstrap; do NOT await. Store the promise so teardown
        // can await it before closing the DB.
        runtime.asyncBootstrap = bootstrapHarnessAsync(runtime, pluginApi).then(() => pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} async bootstrap complete`), (err) => {
            pluginApi.logger.error("[harness] async bootstrap failed", { err: String(err) });
        });
        pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} registered (async bootstrap in flight)`);
    },
});
//# sourceMappingURL=index.js.map