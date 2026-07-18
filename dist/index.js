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
import { parseOkfBlocksFromContext, OkfConceptCache, decideAutoForward, buildRewrittenParams, cacheKeyForCtx, } from "./hooks/okf-auto-forward.js";
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
    const crystallise = async (userText, concepts) => {
        const result = await crystallisePrompt(userText, {
            config,
            logger: api.logger,
            callClassifier: async () => runClassifierSdk({
                model: config.models.classifier,
                userText,
                timeoutSeconds: 60,
                apiKey: await anthropicApiKey(),
            }),
            // beta.21: forward pre-attached concepts (if any) into the SDK-side
            // crystalliser prompt. Undefined/empty is identical to pre-beta.21
            // behaviour.
            callCrystalliser: async (_userText, _cls, ctxConcepts) => runCrystalliserSdk({
                model: config.models.lead,
                userText,
                timeoutSeconds: 120,
                apiKey: await anthropicApiKey(),
                concepts: ctxConcepts,
            }),
        }, concepts);
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
    // beta.24: track whether the credential_get tool is actually available
    // so downstream log messages can distinguish "no vault adapter present"
    // from "vault adapter present but this specific service not found".
    // Set to true on first successful call; the boot-time warning below
    // also probes it eagerly so operators don't have to wait for the first
    // git op to see the state.
    let credentialGetAvailable = undefined;
    const creds = new CredentialAdapter({
        logger: api.logger,
        callCredentialGetTool: async (input) => {
            if (!api.callTool) {
                credentialGetAvailable = false;
                return { error: "api.callTool not available on plugin API; no vault adapter present" };
            }
            try {
                const r = (await api.callTool("credential_get", input));
                // If we get a defined response (even if the entry isn't found),
                // the adapter is present.
                credentialGetAvailable = true;
                return r;
            }
            catch (err) {
                // Heuristic: if the error mentions "unknown tool" / "not found"
                // (typical of a missing memory-hybrid plugin), classify as no
                // adapter. Otherwise treat as a transient / permission error
                // where the adapter IS present.
                const msg = String(err).toLowerCase();
                if (msg.includes("unknown tool") || msg.includes("tool not found") || msg.includes("no such tool") || msg.includes("credential_get") && msg.includes("not registered")) {
                    credentialGetAvailable = false;
                }
                return { error: String(err) };
            }
        },
    });
    // beta.24: eagerly probe whether the credential_get tool is available at
    // boot, so we can surface a single, loud warning at start-up rather than
    // one warning per git operation. This does NOT resolve a real service --
    // just calls credential_get with a sentinel service name; we don't care
    // about the result, only about whether the tool exists.
    (async () => {
        if (api.callTool) {
            try {
                await api.callTool("credential_get", { service: "__harness_boot_probe", type: "token" });
                credentialGetAvailable = true;
            }
            catch (err) {
                const msg = String(err).toLowerCase();
                if (msg.includes("unknown tool") || msg.includes("tool not found") || msg.includes("no such tool")) {
                    credentialGetAvailable = false;
                    api.logger.warn("[harness] no credential vault adapter (`credential_get` tool) is registered. Vault lookups will fail; the harness will always fall back to env vars for tokens. Install the memory-hybrid plugin to enable vault lookups.");
                }
                else {
                    credentialGetAvailable = true;
                }
            }
        }
        else {
            credentialGetAvailable = false;
            api.logger.warn("[harness] no api.callTool bridge on this plugin API; vault lookups impossible. Env-only mode.");
        }
    })().catch(() => { });
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
        // beta.25: hierarchical routing supplies a direct token pointer
        // (value | env | vault). This takes precedence over the legacy
        // vault-service-name path and does NOT silently fall back to a
        // per-provider env var — if the pointer can't resolve, fail loud so a
        // misconfigured user's request never borrows another user's token.
        if (r.tokenPointer) {
            const tp = r.tokenPointer;
            if (tp.value)
                return tp.value;
            if (tp.env) {
                const v = process.env[tp.env];
                if (v) {
                    api.logger.info("[harness] git token resolved from hierarchy env pointer", { envVar: tp.env, provider: r.provider, person: r.person });
                    return v;
                }
                throw new Error(`no ${r.provider} token: hierarchy env pointer '${tp.env}' is unset (person '${r.person ?? "?"}', service '${r.credentialService}')`);
            }
            if (tp.vault) {
                try {
                    const v = await creds.getToken(tp.vault, "token");
                    if (v)
                        return v;
                }
                catch (err) {
                    throw new Error(`no ${r.provider} token: hierarchy vault pointer '${tp.vault}' lookup failed (${String(err)}). ` +
                        `Install/enable memory-hybrid, or switch this person's token pointer to env/value.`);
                }
                throw new Error(`no ${r.provider} token: hierarchy vault pointer '${tp.vault}' returned empty (person '${r.person ?? "?"}')`);
            }
            throw new Error(`no ${r.provider} token: hierarchy person '${r.person ?? "?"}' has an empty token pointer (need one of value|env|vault)`);
        }
        try {
            const v = await creds.getToken(r.credentialService, "token");
            if (v)
                return v;
        }
        catch (err) {
            // beta.24: distinguish "no vault adapter" (structural) from "adapter
            // present, entry missing" (operator config error). Also inline the
            // error + service name in the message string so the log survives
            // meta-stripping (see pr-watcher / crystallise comments).
            const reason = String(err);
            if (credentialGetAvailable === false) {
                api.logger.info(`[harness] git token '${r.credentialService}': using env fallback (no vault adapter; install memory-hybrid to enable)`, { service: r.credentialService, provider: r.provider, envVar: r.apiKeyEnv });
            }
            else {
                api.logger.warn(`[harness] git vault lookup failed for '${r.credentialService}': ${reason}; trying env fallback`, { service: r.credentialService, provider: r.provider, err: reason });
            }
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
        // beta.16 fix #3 + beta.17 correctness: release the per-session
        // worktree on terminal transitions (loop.shipped / loop.aborted /
        // hard failure).
        //
        // Beta.16 called `git.release(sessionId, repoFullName)` which
        // reconstructed the worktree path from `sessionId` (a DB UUID). That
        // was wrong: the allocator uses `pending-<Date.now()>` on-disk ids
        // (see allocateWorktree in this file), so the reconstructed path
        // never matched the real worktree and `if (!existsSync(wt)) return`
        // silently no-op'd every release call. The audit event fired anyway,
        // producing telemetry-only "released" events that lied.
        //
        // Beta.17: thread the actual `worktreePath` (looked up from the
        // sessions row) into the release call, and surface the {ok, error?}
        // outcome so audit consumers can distinguish real success from silent
        // no-op.
        releaseWorktree: async ({ sessionId, repoFullName, worktreePath, reason }) => {
            api.logger.info("[harness] releasing worktree on terminal transition", { sessionId, reason, worktreePath });
            const outcome = await git.releaseByPath(worktreePath, repoFullName);
            if (!outcome.ok) {
                api.logger.warn("[harness] worktree release did not succeed", { sessionId, reason, worktreePath, error: outcome.error });
            }
            return outcome;
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
        preflight: async ({ requester, repoFullName }) => {
            // 1) Resolve routing. A PatRequesterNotAuthorisedError here means the
            //    org is configured hierarchically but this requester has no entry.
            let resolution;
            try {
                resolution = pat.resolve({
                    slackUserId: requester,
                    gitHubUser: repoFullName.split("/")[0],
                    repoFullName,
                });
            }
            catch (err) {
                return {
                    ok: false,
                    missing: ["routing"],
                    message: `I don't have credentials set up for you to work in ${repoFullName}. ` +
                        `${String(err instanceof Error ? err.message : err)} ` +
                        `Tell me your git email and a token for this repo and I'll store it, ` +
                        `or ask your OpenClaw operator to add you.`,
                };
            }
            // 2) Commit identity completeness (name + email). Email is the one
            //    Carel flagged: fail up front, not mid-run.
            const missing = [];
            const idName = resolution.commitIdentity?.name?.trim();
            const idEmail = resolution.commitIdentity?.email?.trim();
            // A synthesised default identity (owner + noreply) is the legacy
            // fallback; only treat email as genuinely present when it looks real.
            if (!idName)
                missing.push("name");
            if (!idEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(idEmail))
                missing.push("email");
            // 3) Token resolvability. Try to resolve without leaking the value.
            let tokenOk = false;
            let tokenErr = "";
            try {
                const t = await resolveGitToken(resolution);
                tokenOk = !!t;
            }
            catch (err) {
                tokenErr = String(err instanceof Error ? err.message : err);
            }
            if (!tokenOk)
                missing.push("token");
            if (missing.length === 0) {
                return { ok: true, missing: [], message: "", provenance: resolution.provenance };
            }
            const parts = [];
            if (missing.includes("email"))
                parts.push("a git commit email address");
            if (missing.includes("name"))
                parts.push("a git commit name");
            if (missing.includes("token"))
                parts.push(`a ${resolution.provider} token${tokenErr ? ` (${tokenErr})` : ""}`);
            return {
                ok: false,
                missing,
                provenance: resolution.provenance,
                message: `Before I run this on ${repoFullName} I need ${parts.join(" and ")}. ` +
                    `Please provide ${missing.includes("token") ? "the token" : "it"} and I'll ` +
                    `store it under your identity (${resolution.person ?? requester}) so future runs just work.`,
            };
        },
        disposers: [],
    };
    // Tools (sync)
    const disposeTools = registerHarnessTools(api, runtime);
    runtime.disposers.push(disposeTools);
    // beta.23: OKF auto-forward hooks (Option B).
    //
    // beta.21 wired the `relevantConcepts` pass-through end-to-end;
    // beta.22 added a prompt-side instruction on the tool descriptions.
    // Beta.23 adds a plugin-side hook pair that deterministically
    // extracts OKF blocks from the calling agent's context and injects
    // them into `harness_run` / `harness_start_session` tool params
    // before the tool call fires. Belt-and-suspenders on top of
    // Option A: even if a model ignores the tool description, the hook
    // still gets the concepts through.
    //
    // Requires
    //   plugins.entries.openclaw-agent-harness.hooks.allowConversationAccess: true
    // in openclaw.json for `before_prompt_build` to receive the current
    // prompt / messages. When that flag is off, the parser hook is
    // silently skipped by the platform and auto-forward degrades to the
    // beta.22 model-instruction path. Runtime never fails hard.
    {
        const disposeOkfHooks = registerOkfAutoForwardHooks(api, runtime);
        for (const d of disposeOkfHooks)
            runtime.disposers.push(d);
    }
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
    const { config, state, creds, slack, git } = runtime;
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
    // beta.17: startup worktree self-heal. Scan the worktrees root for
    // leftover `pending-<ts>` dirs (or UUID dirs) and reap any that
    // correspond to terminal or unknown sessions. Belt-and-suspenders on
    // top of the loop-side release: this catches the cases where
    //   (a) a pre-beta.17 install left worktrees behind (release was broken),
    //   (b) a crash / container restart happened between `loop.shipped` and
    //       the release call landing, or
    //   (c) the pr-watcher's release-on-close also silently failed.
    try {
        const { healOrphanedWorktrees } = await import("./state/worktree-heal.js");
        const healResult = await healOrphanedWorktrees(state, {
            listWorktreeDirs: () => git.listWorktreeDirs(),
            releaseByPath: (path, repo) => git.releaseByPath(path, repo),
            logger: api.logger,
            fallbackRepoFullName: config.repos.allowed?.[0]?.replace("*", "repo") ?? undefined,
        });
        // beta.18 fix: always log + audit that self-heal ran, even when there
        // was nothing to reap (`scanned === 0`). Beta.17 gated both behind
        // `scanned > 0`, which meant a fresh install with no leftovers
        // produced no evidence self-heal ever ran — Staging searched the
        // audit vocab and reported "no `harness.worktree_heal`, no
        // `harness.self_heal`". The absence of the event was diagnostically
        // ambiguous: did it fire and find nothing, or did the wiring silently
        // break? Emit unconditionally so operators can always distinguish.
        api.logger.info("[harness] worktree self-heal complete", healResult);
        try {
            state.audit("harness.worktree_heal", healResult);
        }
        catch (err) {
            api.logger.warn("[harness] worktree heal audit emit failed", { err: String(err) });
        }
    }
    catch (err) {
        api.logger.warn("[harness] worktree self-heal on start failed", { err: String(err) });
        try {
            state.audit("harness.worktree_heal_failed", { error: String(err) });
        }
        catch {
            // If audit itself is broken, log-only was already best-effort above.
        }
    }
    // Session recovery: mark stale non-terminal sessions as 'interrupted' and
    // notify their Slack threads. Fresh in-flight sessions:
    //   - agent-orchestrated mode (default): AUTO-RESUME (re-drive the loop) --
    //     there is no reaction poller / listener to resume them otherwise, so
    //     they'd strand silently (beta.30 fix for the ProjectThanos symptom).
    //   - listener mode: stay 'resumable' for a human reaction.
    const agentOrchestrated = !config.slack.listener_enabled;
    try {
        const { recoverSessions } = await import("./state/recovery.js");
        const result = await recoverSessions(state, {
            staleAfterSeconds: config.loop.session_hard_timeout_seconds,
            logger: api.logger,
            agentOrchestrated,
            autoResume: async (s) => {
                const row = state.db
                    .prepare(`SELECT crystallised_prompt FROM sessions WHERE id = ?`)
                    .get(s.id);
                if (!row?.crystallised_prompt) {
                    api.logger.warn("[harness] recovery auto-resume: no crystallised brief, marking interrupted", { sessionId: s.id });
                    state.db.prepare(`UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE id = ?`).run(Date.now(), s.id);
                    return;
                }
                const brief = JSON.parse(row.crystallised_prompt);
                state.db.prepare(`UPDATE sessions SET status = 'planning', updated_at = ? WHERE id = ?`).run(Date.now(), s.id);
                api.logger.warn("[harness] recovery auto-resuming session (agent-orchestrated mode)", { sessionId: s.id, wasStatus: s.status });
                if (s.slack_channel && s.slack_thread) {
                    await slack
                        .replyInThread(s.slack_channel, s.slack_thread, `:arrows_counterclockwise: Harness restarted mid-run; auto-resuming this session from its plan (agent-orchestrated mode).`)
                        .catch(() => undefined);
                }
                void runtime.loop.run(s.id, brief).catch((err) => {
                    api.logger.error("[harness] recovery auto-resume loop.run failed", { sessionId: s.id, err: String(err) });
                });
            },
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
/**
 * beta.23: register the OKF auto-forward hook pair.
 *
 * - `before_prompt_build` observes the current turn's context, parses
 *   any `## Relevant Knowledge (OKF)` section, and caches the parsed
 *   concepts under the session key.
 * - `before_tool_call` filtered to `harness_run` /
 *   `harness_start_session` reads the cache and, when the tool call
 *   doesn't already carry `relevantConcepts`, rewrites the params to
 *   inject them.
 *
 * Returns an array of disposer functions the caller pushes into the
 * runtime's teardown list.
 *
 * All failures are logged and swallowed. This is a pure enhancement;
 * a broken hook must not fail an otherwise-healthy harness. If neither
 * `api.on` nor `api.registerHook` is available, or if the platform
 * skips `before_prompt_build` because `allowConversationAccess` is
 * off, the hooks are silently unregistered and auto-forward degrades
 * to the beta.22 prompt-side path.
 */
function registerOkfAutoForwardHooks(api, runtime) {
    const disposers = [];
    const cache = new OkfConceptCache();
    // Store on the runtime so tests + observability can inspect the cache.
    runtime.okfConceptCache = cache;
    const promptBuildHandler = async (event) => {
        try {
            const evt = (event ?? {});
            // Aggregate all plausible text sources into one blob. Cheap; the
            // parser is regex-bounded to the OKF section header.
            const parts = [];
            if (typeof evt.systemPrompt === "string")
                parts.push(evt.systemPrompt);
            if (typeof evt.prompt === "string")
                parts.push(evt.prompt);
            if (Array.isArray(evt.messages)) {
                for (const m of evt.messages) {
                    const mm = m;
                    if (mm && typeof mm.content === "string")
                        parts.push(mm.content);
                }
            }
            const text = parts.join("\n\n");
            const concepts = parseOkfBlocksFromContext(text);
            if (concepts.length === 0)
                return;
            const key = cacheKeyForCtx((evt.context ?? evt));
            if (!key)
                return;
            cache.set(key, concepts);
        }
        catch (err) {
            api.logger.warn("[harness] okf-auto-forward: prompt observer failed", { err: String(err) });
        }
    };
    const toolCallHandler = async (event) => {
        try {
            const evt = (event ?? {});
            const toolName = evt.toolName ?? "";
            if (toolName !== "harness_run" && toolName !== "harness_start_session")
                return;
            const key = cacheKeyForCtx((evt.context ?? evt.ctx ?? {}));
            if (!key)
                return;
            const cached = cache.get(key);
            const decision = decideAutoForward({ toolName, params: evt.params, cached });
            if (!decision.inject)
                return;
            const rewritten = buildRewrittenParams(toolName, evt.params, decision.concepts);
            api.logger.info("[harness] okf-auto-forward: injected concepts into tool params", {
                toolName,
                sessionKey: key,
                conceptCount: decision.concepts.length,
                injectionSite: decision.injectionSite,
            });
            // eslint-disable-next-line consistent-return
            return { params: rewritten };
        }
        catch (err) {
            api.logger.warn("[harness] okf-auto-forward: tool-call rewriter failed", { err: String(err) });
            // Fall through: do not block the tool call on a hook bug.
        }
    };
    const on = (event, handler) => {
        if (typeof api.on === "function") {
            const dispose = api.on(event, handler);
            if (typeof dispose === "function")
                disposers.push(dispose);
            return true;
        }
        if (typeof api.registerHook === "function") {
            const dispose = api.registerHook([event], handler, {
                name: `${PLUGIN_ID}:${event}`,
                description: `OKF auto-forward ${event} observer/rewriter`,
            });
            disposers.push(() => {
                if (typeof dispose === "function")
                    dispose();
                else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function")
                    dispose.dispose();
            });
            return true;
        }
        return false;
    };
    const promptOk = on("before_prompt_build", promptBuildHandler);
    const toolOk = on("before_tool_call", toolCallHandler);
    if (!promptOk && !toolOk) {
        api.logger.warn("[harness] okf-auto-forward: neither api.on nor api.registerHook available; auto-forward disabled");
    }
    else if (!promptOk) {
        api.logger.warn("[harness] okf-auto-forward: prompt observer could not register; auto-forward will only fire if a caller pre-populates the cache");
    }
    else if (!toolOk) {
        api.logger.warn("[harness] okf-auto-forward: tool-call rewriter could not register; parsing OKF blocks but will not inject");
    }
    else {
        api.logger.info("[harness] okf-auto-forward: hooks registered");
    }
    return disposers;
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