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
import { readFile, writeFile, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseHarnessConfig, assessBudgetCoherence, declaresRemovedListenerFlag, declaresRemovedParallelKeys } from "./config.js";
import { openStateStoreSync } from "./state/store.js";
import { decideDrainAction } from "./state/teardown-drain.js";
import { decideRecoveryResume } from "./state/recovery-guard.js";
import { InteractionLog, resolveInteractionLogConfig } from "./state/interaction-log.js";
import { OrchestratorLoop, runningSessionIds } from "./orchestrator/loop.js";
import { createVerifyProbes } from "./orchestrator/verify-probes.js";
import { buildProgressSnapshot } from "./orchestrator/progress.js";
import { blocksMerge, classifyFinding, normaliseSeverity } from "./orchestrator/finding-classify.js";
import { prLabelsFor } from "./orchestrator/pr-labels.js";
import { SlackChannelListener } from "./slack/channel-listener.js";
import { Dispatcher } from "./slack/dispatcher.js";
import { SlackReactionsReader } from "./slack/reactions.js";
import { ReactionsPoller } from "./slack/reactions-poller.js";
import { SlackProgressPoster, hasRealSlackBinding } from "./slack/progress-poster.js";
import { PrMergedWatcher } from "./adapters/github-watcher.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { RouteOverlay } from "./auth/route-overlay.js";
import { pruneRetention } from "./state/retention.js";
import { registerHarnessTools } from "./tools/registration.js";
import { guidanceCommentSection } from "./tools/revise-guidance.js";
import { parseOkfBlocksFromContext, OkfConceptCache, decideAutoForward, buildRewrittenParams, cacheKeyForCtx, } from "./hooks/okf-auto-forward.js";
import { setCurrentRuntime } from "./runtime-registry.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { CredentialVault, VAULT_KEY_ENV } from "./adapters/credential-vault.js";
import { buildBackendRouter } from "./adapters/backend-router.js";
import { runWorkerAcp } from "./adapters/acp.js";
import { buildAcpGuard } from "./safety/bash-guard.js";
import { catalogueStore } from "./state/price-cache.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import { buildScoutSystemPrompt, buildScoutUserMessage, SCOUT_ALLOWED_TOOLS, SCOUT_DENIED_TOOLS, SCOUT_MAX_TURNS, } from "./orchestrator/lead-scout.js";
import { createPullRequest, getPullRequest, getCombinedStatus, getCiSnapshot, getFailingCheckLogs, getTokenScopes, mergePullRequest, postPrComment } from "./adapters/github.js";
import { canPushWorkflows } from "./orchestrator/workflow-scope.js";
import { authorCiWorkflow } from "./adapters/ci-workflow.js";
import { SlackAdapter } from "./adapters/slack.js";
import { estimateSubTaskCost, runAdversarySdk, runClassifierSdk, runCrystalliserSdk, runLeadSdk, runLeadScoutSdk, runLeadWorkerContextSdk, runLeadReviseSpecSdk, runWorkerSdk, fetchLiveModelIds, assessModelPricingHealth, registerDeniedSdkEnvVar, } from "./adapters/claude-code.js";
import { fetchBranchLogs, verifyDeploymentForSha } from "./vercel/logs.js";
import { runDeployRepair } from "./orchestrator/deploy-repair.js";
import { crystallisePrompt } from "./crystallise/prompt-refiner.js";
import { runLeadPlanner } from "./orchestrator/lead.js";
import { runWorker as runWorkerCore, buildWorkerSystemPrompt } from "./orchestrator/worker.js";
import { runAdversary as runAdversaryCore } from "./orchestrator/adversary.js";
import { discoverCheckScripts } from "./orchestrator/repo-conventions.js";
import { diagnoseCheckEnv, runTypecheckDirect } from "./orchestrator/typecheck-fallback.js";
import { buildBashGuard } from "./safety/bash-guard.js";
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION } from "./version.js";
/**
 * beta.110: stand-in for a vault that would not open. Every operation reports
 * the ORIGINAL failure, so an operator sees "the key does not match" rather
 * than a procession of "credential not found" errors sending them to look for
 * a missing entry that is in fact right there, sealed.
 */
function sealedVault(reason) {
    const fail = () => { throw new Error(`credential vault unavailable: ${reason}`); };
    return { get: fail, set: fail, delete: fail, list: fail };
}
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
                execute: executorFor("classifier"),
                model: config.models.classifier,
                userText,
                timeoutSeconds: 60,
                apiKey: await anthropicApiKey(),
            }),
            // beta.21: forward pre-attached concepts (if any) into the SDK-side
            // crystalliser prompt. Undefined/empty is identical to pre-beta.21
            // behaviour.
            callCrystalliser: async (_userText, _cls, ctxConcepts) => runCrystalliserSdk({
                execute: executorFor("crystalliser"),
                model: config.models.lead,
                userText,
                timeoutSeconds: 120,
                apiKey: await anthropicApiKey(),
                concepts: ctxConcepts,
                // beta.80: repo-only invariant + bimodality self-report prompt gates.
                repoOnlyInvariant: config.brief.repo_only_invariant,
                bimodalClarify: config.brief.bimodal_clarify,
            }),
        }, concepts);
        // v2.0.0-beta.1: report what the pass actually spent.
        //
        // Both `runClassifierSdk` and `runCrystalliserSdk` have always returned
        // `costUsd`/`tokensIn`/`tokensOut`; the cost was measured and then dropped
        // here, at the wiring, because `CrystalliserDeps` typed the callables as
        // returning the bare result. Every crystallise pass therefore reported
        // zero — including the reject and clarify paths, which still pay for a
        // classifier call. `spend` now carries it through.
        const costUsd = result.spend.costUsd;
        if (result.spend.partial) {
            api.logger.info("[crystalliser] cost is a floor: some calls reported tokens without a price", {
                tokensIn: result.spend.tokensIn,
                tokensOut: result.spend.tokensOut,
            });
        }
        return result.kind === "brief"
            ? { kind: "brief", brief: result.brief, costUsd }
            : result.kind === "clarify"
                ? { kind: "clarify", question: result.question, costUsd }
                : { kind: "reject", intent: result.intent, reason: result.reason ?? "", costUsd };
    };
    const dbPath = config.storage.state_db_path.replace(/^~/, process.env.HOME ?? "");
    mkdirSync(dirname(dbPath), { recursive: true });
    const state = openStateStoreSync(dbPath);
    // beta.63 (Part B): the harness data dir is the directory holding the state
    // DB. The interaction log lives in `<dataDir>/logs` by default -- crucially
    // OUTSIDE the ephemeral git worktree so it survives teardown + restart.
    const dataDir = dirname(dbPath);
    const interactionLog = new InteractionLog({
        config: resolveInteractionLogConfig(config.log, dataDir),
        logger: api.logger,
    });
    const budget = new BudgetEnforcer(config.budgets, state);
    // Routes written by `harness_onboard`, merged BENEATH the config tree so a
    // hand-written entry always wins. Without this the tool can store a secret
    // and nothing that tells the router to use it.
    const routeOverlay = new RouteOverlay(state.db);
    const pat = new PatRouter(config.pat_routing, routeOverlay);
    // beta.110: HARNESS-OWNED CREDENTIAL VAULT.
    //
    // Replaces memory-hybrid's `credential_get` / `credential_store` tools
    // outright -- no flag, no fallback. Two properties the tool-based vault could
    // not offer: it is an in-process library call, so no agent turn can reach it
    // by name; and it is ours, so retiring the memory plugin cannot take the
    // harness's git credentials with it.
    //
    // The boot probe that used to detect whether a vault adapter existed is gone
    // with it: the vault is now a hard dependency we construct ourselves, so
    // "is there an adapter?" is no longer a question that can have two answers.
    const credCfg = config.credentials ?? {};
    const vaultDir = resolve(dataDir, credCfg.dir ?? "harness-vault");
    // An operator who renames the key var must not lose the worker-env strip.
    registerDeniedSdkEnvVar(credCfg.key_env ?? VAULT_KEY_ENV);
    let vaultOpenError;
    let vault;
    try {
        vault = CredentialVault.open({
            dir: vaultDir,
            keyEnvVar: credCfg.key_env,
            keyFile: credCfg.key_file,
            logger: api.logger,
            // Records the SERVICE NAME and never the value, so a read is traceable
            // without the audit log becoming a second copy of the secret store.
            audit: (event, payload) => { try {
                state.audit(event, payload, "");
            }
            catch { /* audit must never break a read */ } },
        });
        api.logger.info("[harness] credential vault opened", { dir: vaultDir, keySource: vault.keySource });
    }
    catch (err) {
        // A vault we cannot open (wrong key, corrupt file) is fatal to every run,
        // but crashing `register()` would take the whole plugin down and leave the
        // operator with no `harness_health` to ask WHY. So we boot with a sealed
        // stub that carries the real reason into every credential read.
        vaultOpenError = String(err);
        api.logger.warn(`[harness] CREDENTIAL VAULT UNAVAILABLE: ${vaultOpenError}. Every credential lookup will fail until this is fixed.`, { dir: vaultDir });
        vault = sealedVault(vaultOpenError);
    }
    const creds = new CredentialAdapter({ logger: api.logger, vault });
    // v2.0.0-beta.1: per-role backend routing.
    //
    // `undefined` unless an operator declared a `backends` block that actually
    // moves a role, so a v1 install gets no router, no probe, and none of this
    // code path. Construction VALIDATES and throws on a bad configuration --
    // caught here rather than propagated, because taking `register()` down would
    // leave the operator without the `harness_health` that explains why.
    let backendRouter;
    let backendRouterError;
    try {
        backendRouter = buildBackendRouter({
            backends: config.backends,
            providers: config.providers,
            // Synchronous by necessity: `register()` cannot await. The vault's own
            // read is sync; only `CredentialAdapter` adds a promise.
            resolveKey: (service) => {
                try {
                    return vault.get(service, "api_key");
                }
                catch {
                    return undefined;
                }
            },
            scratchDir: dataDir,
            logger: api.logger,
            audit: (event, payload) => { try {
                state.audit(event, payload, "");
            }
            catch { /* audit must never break boot */ } },
        });
        if (backendRouter) {
            api.logger.info("[harness] per-role backends configured", { roles: backendRouter.describe() });
            state.audit("backend.routes", { roles: backendRouter.describe() }, "");
        }
    }
    catch (err) {
        // A rejected backend configuration must not be silently downgraded to the
        // default. The operator asked for something specific; running something
        // else and reporting success is how a cost or capability surprise gets
        // blamed on the wrong thing weeks later. Recorded, surfaced, and every
        // affected role refuses below.
        backendRouterError = String(err);
        api.logger.warn(`[harness] BACKEND CONFIGURATION REJECTED: ${backendRouterError}`);
    }
    /**
     * The live probe, run once, lazily, on the first session that needs it.
     *
     * Not at register time: `register()` is synchronous, and a probe that spawns
     * a process and waits for a permission round-trip is not something to do on
     * the plugin loader's critical path. Lazily means the cost lands on the
     * first run that actually uses OpenCode, and the failure lands there too --
     * where there is a session to attach it to.
     */
    let backendProbe;
    const ensureBackendReady = async () => {
        if (backendRouterError)
            throw new Error(`backend configuration rejected at startup: ${backendRouterError}`);
        if (!backendRouter)
            return;
        backendProbe ??= (async () => {
            // Cache-then-refresh: a same-day cache satisfies this without a fetch,
            // and a failed fetch keeps whatever cache was already good. Awaited only
            // once, and never fatal -- unpriced turns are a reporting problem.
            await backendRouter.refreshPricing(catalogueStore(state.db));
            await backendRouter.preflight();
        })();
        await backendProbe;
    };
    /**
     * The executor for a structured role, or `undefined` to use the SDK path.
     *
     * Two things happen here that the router cannot do for itself.
     *
     * First, a REJECTED configuration must not read as "no configuration". The
     * router is undefined in both cases, and returning `undefined` for both
     * would send a role the operator explicitly moved back to Claude Code
     * without saying so -- the silent downgrade this whole module exists to
     * prevent. So a rejected config yields an executor that throws.
     *
     * Second, the probe is awaited on the structured path too. Tools are off for
     * these roles and `runStructuredAcp` denies every call regardless, so the
     * permission round-trip matters less here than it does for the worker; but
     * the same gate also refreshes pricing and pins the version, and having one
     * of the eight roles skip it is how the exception becomes the rule.
     */
    const executorFor = (role) => {
        if (backendRouterError) {
            return (async () => {
                throw new Error(`backend configuration rejected at startup: ${backendRouterError}`);
            });
        }
        const inner = backendRouter?.executorFor(role);
        if (!inner)
            return undefined;
        return (async (params) => {
            await ensureBackendReady();
            return inner(params);
        });
    };
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
    // beta.34: Vercel token resolver. Vault-first (config.vercel.credential_service)
    // then env fallback (config.vercel.api_key_env, default VERCEL_TOKEN). Same
    // pattern as anthropicApiKey / resolveGitToken so the env-only Staging
    // container (no vault) can supply the token via env instead of losing it.
    // Memoised; returns undefined when neither source has it.
    let vercelTokenResolved = false;
    let vercelTokenValue;
    const resolveVercelToken = async () => {
        if (vercelTokenResolved)
            return vercelTokenValue;
        vercelTokenResolved = true;
        // 1) Vault (preferred).
        if (config.vercel?.credential_service) {
            try {
                const v = await creds.getToken(config.vercel.credential_service);
                if (v) {
                    vercelTokenValue = v;
                    api.logger.info("[harness] vercel token resolved from vault", { service: config.vercel.credential_service });
                    return vercelTokenValue;
                }
            }
            catch (err) {
                api.logger.warn("[harness] vercel vault lookup failed; trying env fallback", { service: config.vercel.credential_service, err: String(err) });
            }
        }
        // 2) Env fallback.
        const envName = config.vercel?.api_key_env || "VERCEL_TOKEN";
        const envVal = process.env[envName];
        if (envVal) {
            vercelTokenValue = envVal;
            api.logger.info("[harness] vercel token resolved from env", { envVar: envName });
            return vercelTokenValue;
        }
        api.logger.warn("[harness] no Vercel token resolved (vault + env both empty); deploy verification will be unavailable", { credentialService: config.vercel?.credential_service || "(unset)", envVar: envName });
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
                        `Store it with 'node scripts/vault.mjs set ${tp.vault}', or switch this person's token pointer to env/value.`);
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
            // beta.110: the old "is there a vault adapter at all?" branch is gone --
            // the vault is ours and always constructed, so a miss means exactly one
            // thing: no entry under this service name. A BROKEN vault is a different
            // message and comes from the sealed stub. Inline the error + service name
            // in the message string so the log survives meta-stripping (see
            // pr-watcher / crystallise comments).
            const reason = String(err);
            if (vaultOpenError) {
                api.logger.warn(`[harness] git token '${r.credentialService}': vault is unavailable (${vaultOpenError}); trying env fallback`, { service: r.credentialService, provider: r.provider, envVar: r.apiKeyEnv });
            }
            else {
                api.logger.info(`[harness] git token '${r.credentialService}' not in the vault (${reason}); trying env fallback`, { service: r.credentialService, provider: r.provider, envVar: r.apiKeyEnv });
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
        // beta.76 (Defect B): disk preflight floor before dep bootstrap.
        minFreeDiskBytes: config.storage.min_free_disk_bytes,
        // beta.114: generated trees this repo never wants in a feature commit.
        neverCommitPaths: config.repos.never_commit_paths,
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
        interactionLog,
        runLead: async (brief, ctx) => {
            const requester = ctx?.requester ?? config.slack.authorised_users[0];
            return runLeadPlanner(brief, {
                config,
                // beta.108: lets the planner make the branch name session-unique and
                // reproducible across re-plans. See sessionScopedBranch.
                sessionId: ctx?.sessionId,
                // beta.122: b108 pinned only the SUFFIX; the stem still came from the
                // model on every call, so a re-plan could rename the branch. Once the
                // session has a branch, that is the branch.
                pinnedSessionBranch: ctx?.pinnedSessionBranch,
                logger: api.logger,
                // beta.67 (P0a): callLeadModel genuinely (re-)invokes the lead SDK so
                // the ONE bounded re-ask actually re-plans with the corrective note.
                callLeadModel: async (b, _repos, correctiveNote) => runLeadSdk({
                    execute: executorFor("lead"),
                    model: config.models.lead,
                    brief: b,
                    reposAllowed: config.repos.allowed,
                    // beta.99: the lead ran on `worker_timeout_seconds` (1800s) while
                    // `lead_timeout_seconds` (900s) -- the knob documented and audited
                    // for exactly this call -- was ignored, so operators tuning the
                    // lead timeout changed nothing.
                    timeoutSeconds: config.loop.lead_timeout_seconds ?? config.loop.worker_timeout_seconds,
                    apiKey: await anthropicApiKey(),
                    logger: api.logger,
                    correctiveNote,
                    // beta.81 (Track C): retry-once-on-prose-drift guard for the lead.
                    jsonRetryEnabled: config.loop.lead_json_retry_enabled !== false,
                    // beta.99 (P0-4/P0-6): explicit output ceiling + truncation salvage.
                    maxOutputTokens: config.models.max_output_tokens,
                    leadSalvageEnabled: config.loop.lead_salvage_truncated_plan !== false,
                    // beta.128: one more call when a COMPLETE plan fails to parse.
                    leadSyntaxRetryEnabled: config.loop.lead_syntax_retry_enabled !== false,
                    // beta.128: record every attempt, including the ones we recovered
                    // from. A truncation that the retry rung fixed used to leave no
                    // trace, so the smoke report called a run clean that was not.
                    onAttempt: (info) => state.audit("lead.plan_attempt", info, ctx?.sessionId),
                }),
                // beta.99 (P0-2): bounded workerContext top-up. Replaces the b67
                // whole-plan re-ask as the FIRST remedy for thin context; the
                // whole-plan re-ask remains as the fallback inside runLeadPlanner.
                callWorkerContextModel: async (b, plan, missingSeqs) => runLeadWorkerContextSdk({
                    execute: executorFor("worker_context"),
                    model: config.models.lead,
                    brief: b,
                    subTasks: plan.subTasks,
                    missingSeqs,
                    timeoutSeconds: config.loop.lead_timeout_seconds ?? config.loop.worker_timeout_seconds,
                    apiKey: await anthropicApiKey(),
                    maxOutputTokens: config.models.max_output_tokens,
                    logger: api.logger,
                }),
                // beta.104: the lead's ONE look at the repository, before it plans.
                //
                // Allocates a THROWAWAY worktree with the deps bootstrap OFF (the scout
                // only reads; installing node_modules for that would add minutes per
                // run), runs the read-only SDK turn in it, and releases it in a finally
                // so a scout failure cannot leak a worktree. The bare clone stays warm,
                // so the real allocation moments later is a `git worktree add`, not a
                // fresh clone.
                //
                // Every failure path returns undefined rather than throwing:
                // runLeadPlanner treats an absent report as "plan blind", which is
                // exactly the pre-b104 behaviour.
                scoutRepo: async ({ brief: scoutBrief, repoFullName }) => {
                    const [owner] = repoFullName.split("/");
                    const resolution = pat.resolve({
                        slackUserId: requester,
                        gitHubUser: owner,
                        repoFullName,
                    });
                    const ghToken = await resolveGitToken(resolution);
                    let scoutWorktree;
                    try {
                        scoutWorktree = await git.allocate({
                            repoFullName,
                            baseBranch: config.repos.default_base_branch,
                            // The scout reads the BASE branch, never the session branch: the
                            // session branch does not exist yet, and the scout must not be
                            // able to influence the branch the run will build on.
                            sessionBranch: `harness/scout-${Date.now()}-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)).slice(0, 8)}`,
                            sessionId: `scout-${Date.now()}-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)).slice(0, 8)}`,
                            ghToken,
                            commitIdentity: resolution.commitIdentity,
                            bootstrapDeps: false,
                        });
                        if (backendRouterError)
                            await ensureBackendReady();
                        if (backendRouter?.backendFor("scout").backend === "opencode") {
                            await ensureBackendReady();
                            const s = await runWorkerAcp({
                                agent: backendRouter.agentSpecFor("scout"),
                                worktreePath: scoutWorktree,
                                systemPrompt: buildScoutSystemPrompt(),
                                userMessage: buildScoutUserMessage(scoutBrief),
                                model: backendRouter.backendFor("scout").model ?? config.models.lead,
                                timeoutSeconds: config.loop.lead_scout_timeout_seconds ?? 420,
                                acpGuard: buildAcpGuard({
                                    bash_whitelist: config.safety.bash_whitelist,
                                    bash_denylist_tokens: config.safety.bash_denylist_tokens,
                                    // The scout only reads. It gets the worker's path denylist
                                    // and no write path at all.
                                    path_denylist: config.safety.path_denylist,
                                    allow_git_push: false,
                                    allow_network_commands: false,
                                }),
                                secretToken: ghToken,
                                logger: api.logger,
                            });
                            return {
                                report: s.finalMessage,
                                costUsd: backendRouter.priceTurn("scout", s).costUsd ?? 0,
                                tokensIn: s.tokensIn,
                                tokensOut: s.tokensOut,
                                timedOut: s.stopReason === "timeout",
                            };
                        }
                        const r = await runLeadScoutSdk({
                            model: config.models.lead,
                            worktreePath: scoutWorktree,
                            systemPrompt: buildScoutSystemPrompt(),
                            userMessage: buildScoutUserMessage(scoutBrief),
                            timeoutSeconds: config.loop.lead_scout_timeout_seconds ?? 420,
                            maxTurns: config.loop.lead_scout_max_turns ?? SCOUT_MAX_TURNS,
                            apiKey: await anthropicApiKey(),
                            maxOutputTokens: config.models.max_output_tokens,
                            allowedTools: SCOUT_ALLOWED_TOOLS,
                            deniedTools: SCOUT_DENIED_TOOLS,
                            logger: api.logger,
                        });
                        return { report: r.report, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, timedOut: r.timedOut };
                    }
                    finally {
                        if (scoutWorktree) {
                            await git
                                .releaseByPath(scoutWorktree, repoFullName)
                                .catch((err) => api.logger.warn("[lead] beta.104: scout worktree release failed (non-fatal)", {
                                path: scoutWorktree, err: String(err),
                            }));
                        }
                    }
                },
                // beta.105: forwarded from loop.run so the checkout path lands in the
                // session's audit trail as `loop.branch_allocation`.
                onBranchDecision: ctx?.onBranchDecision,
                allocateWorktree: async (repo, branch, onBranchDecision) => {
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
                        // beta.57 (P3): a random suffix on the on-disk id. Two allocations
                        // in the same millisecond (concurrent sessions) used to collide on
                        // `pending-<Date.now()>` and abort with "worktree already exists".
                        sessionId: `pending-${Date.now()}-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)).slice(0, 8)}`,
                        ghToken,
                        commitIdentity: resolution.commitIdentity,
                        // beta.44: on a revise (brief.pinnedBranch set), check out the
                        // existing branch at its tip instead of resetting to base, so the
                        // prior PR's commits are preserved and new work stacks on them.
                        reuseExistingBranch: !!brief.pinnedBranch,
                        // beta.101: a clarification re-drive must not reset the branch --
                        // its commits are never pushed, so reuseExistingBranch (which
                        // resolves origin/<branch>) cannot save them either.
                        preserveLocalBranch: !!brief.resumeFromClarification,
                        // beta.122: b101's preservation is a lookup BY NAME, and on the
                        // b121 smoke the name had changed, so it silently fell through to
                        // a reset that orphaned two commits. The ledger tip lets the
                        // allocator re-create the missing branch on top of the real work
                        // rather than resolving "not found" as "start over".
                        recoverBranchFromSha: ctx?.recoverBranchFromSha,
                        onBranchDecision,
                    });
                },
                estimateCost: (p) => p.subTasks.reduce((acc, s) => acc + estimateSubTaskCost(config.models.worker, s.estimatedTokens), 0),
                // beta.73 (D2): resolve whether a branchHint already exists on origin so
                // the lead can promote it to a pinned/reuse branch (checkout its HEAD
                // instead of resetting to main). Best-effort; a null/throw skips the
                // promotion. Uses the requester's PAT for the repo, same as allocate.
                remoteBranchExists: async (repoFullName, branch) => {
                    try {
                        const [owner] = repoFullName.split("/");
                        const resolution = pat.resolve({ slackUserId: requester, gitHubUser: owner, repoFullName });
                        const ghToken = await resolveGitToken(resolution);
                        return await git.remoteBranchExistsByUrl(repoFullName, branch, ghToken);
                    }
                    catch {
                        return false;
                    }
                },
            });
        },
        // beta.67 (P0b): Fable revise-spec turn. Runs the lead model on findings +
        // current plan to refresh workerContext for cycle-2 workers. Best-effort:
        // a throw here falls back to buildReviseDispatchHint in the loop.
        runLeadReviseSpec: async ({ brief, plan, review }) => {
            const r = await runLeadReviseSpecSdk({
                execute: executorFor("revise_spec"),
                model: config.models.lead,
                brief,
                subTasks: plan.subTasks,
                review,
                timeoutSeconds: config.loop.revise_spec_timeout_seconds ?? config.loop.worker_timeout_seconds,
                apiKey: await anthropicApiKey(),
                // beta.99 (P0-4): same output ceiling as the plan call -- this turn
                // re-emits the full sub-task list and truncates the same way.
                maxOutputTokens: config.models.max_output_tokens,
                logger: api.logger,
            });
            // v2.0.0-beta.1: `runLeadReviseSpecSdk` reports what the turn cost and
            // this return dropped it on the floor one line later. The turn re-emits
            // the FULL sub-task list, so it is one of the more expensive calls the
            // harness makes.
            return { subTasks: r.subTasks, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
        },
        runWorker: async ({ brief, subTask, plan, worktreePath, resumeSessionId, requester, dispatchHint, modelOverride, onStreamSlow, firstTokenTimeoutSecondsOverride }) => {
            const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
            const canUseTool = buildBashGuard(config.safety);
            const resolution = pat.resolve({
                slackUserId: requester ?? config.slack.authorised_users[0],
                gitHubUser: plan.repo.split("/")[0],
                repoFullName: plan.repo,
            });
            return runWorkerCore(
            // beta.117: the loop states which checkout this worker owns. Under
            // parallelism it is a leased slot, and using plan.worktreePath here
            // would silently put every worker back in the shared session worktree
            // -- the exact cross-contamination b117 exists to prevent. The fallback
            // covers the serial path, where the two are the same.
            worktreePath ?? plan.worktreePath, brief, subTask, resolution.commitIdentity, {
                config,
                logger: api.logger,
                buildCanUseTool: () => canUseTool,
                runWorkerModel: async (params) => {
                    // Throws when the configuration was rejected, so a moved role
                    // fails loudly instead of quietly running on the default backend.
                    if (backendRouterError)
                        await ensureBackendReady();
                    if (backendRouter?.backendFor("worker").backend !== "opencode") {
                        return runWorkerSdk({ ...params, apiKey: await anthropicApiKey(), maxOutputTokens: config.models.max_output_tokens });
                    }
                    // The guard is proven live before the first turn, not assumed from
                    // the config we wrote: an agent that has stopped routing tool calls
                    // through `session/request_permission` looks identical from its own
                    // configuration file.
                    await ensureBackendReady();
                    const r = await runWorkerAcp({
                        agent: backendRouter.agentSpecFor("worker"),
                        worktreePath: params.worktreePath,
                        systemPrompt: params.systemPrompt,
                        userMessage: params.userMessage,
                        model: backendRouter.backendFor("worker").model ?? params.model,
                        resumeSessionId: params.resumeSessionId,
                        timeoutSeconds: params.timeoutSeconds,
                        streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
                        firstTokenTimeoutSeconds: params.firstTokenTimeoutSeconds,
                        streamIdleWarnSeconds: params.streamIdleWarnSeconds,
                        onStreamSlow: params.onStreamSlow,
                        // NOT params.canUseTool: that guard keys on Claude Code tool
                        // names and would fall through to allow on every ACP call.
                        acpGuard: buildAcpGuard({
                            bash_whitelist: config.safety.bash_whitelist,
                            bash_denylist_tokens: config.safety.bash_denylist_tokens,
                            path_denylist: config.safety.path_denylist,
                            allow_git_push: config.safety.allow_git_push,
                            allow_network_commands: config.safety.allow_network_commands,
                        }),
                        logger: api.logger,
                    });
                    // Priced through the router so a provider that reports tokens
                    // without a cost is billed off the catalogue rather than recorded
                    // as a free turn.
                    return { ...r, costUsd: backendRouter.priceTurn("worker", r).costUsd ?? 0 };
                },
                gitBaseSha: (wt) => git.baseSha(wt),
                gitListChangedFiles: (wt, base) => git.listChangedFiles(wt, base),
                gitCommit: (wt, msg, id) => git.commit(wt, msg, id),
                // beta.47: reconcile commit sha when the worker self-commits.
                gitHeadSha: (wt) => git.baseSha(wt),
                gitListCommittedFiles: (wt, base) => git.listCommittedFiles(wt, base),
                // beta.53 (P2): capture uncommitted working-tree changes for the audit
                // + retry logic (wrote-but-didn't-commit vs zero-work).
                gitStatusPorcelain: (wt) => git.statusPorcelain(wt),
            }, resumeSessionId, dispatchHint, onStreamSlow, modelOverride, firstTokenTimeoutSecondsOverride);
        },
        runAdversary: async ({ brief, plan, runtime, requester, baseSha, priorFindings }) => {
            // beta.67 (Bug B): diff against the branch's persisted FORK-POINT sha
            // (captured at plan_ready) so the adversary sees ONLY this branch's own
            // commits. beta.66 smoke #4 diffed against config.repos.default_base_branch
            // (main-at-review-time), which carried accumulated prior-PR/prior-smoke
            // history the branch never contained -- the adversary hallucinated "5
            // unrelated commits" and false-positive-revised a 1-commit branch,
            // wasting a full cycle. Fall back to the base-branch name only when no
            // fork-point was captured (probe unwired / pre-beta.67 session).
            const diffBase = baseSha && baseSha.length > 0 ? baseSha : config.repos.default_base_branch;
            // beta.74: resolve the requester's GitHub token for this repo so the diff's
            // promisor base-sha fetch authenticates (same pat.resolve path as
            // allocateWorktree). Best-effort -- if it can't resolve, fall back to a
            // token-less diff (prior behaviour; fine for public repos / local base).
            let adversaryGhToken;
            try {
                const [owner] = plan.repo.split("/");
                const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner, repoFullName: plan.repo });
                adversaryGhToken = await resolveGitToken(resolution);
            }
            catch (err) {
                api.logger.warn("[harness] adversary diff: could not resolve GitHub token (promisor fetch may fail on a private repo)", { repo: plan.repo, err: String(err) });
            }
            const diffText = await git.diff(plan.worktreePath, diffBase, adversaryGhToken);
            const diffFile = resolve(config.storage.worktree_root.replace(/^~/, process.env.HOME ?? ""), `${Date.now()}.diff`);
            await mkdir(dirname(diffFile), { recursive: true });
            await writeFile(diffFile, diffText, "utf8");
            // beta.57 (P3): the diff file was written into worktree_root and never
            // deleted -- one leaked <ts>.diff per review cycle, forever.
            try {
                return await runAdversaryCore({
                    // beta.56 (P0-2): pass the FULL brief, not just the title. The
                    // adversary judges spec fidelity against acceptance criteria; it
                    // previously never saw them (and the title alone was also dropped
                    // by the prompt builder -- fixed in adversary.ts).
                    crystallisedPrompt: [
                        `Title: ${brief.title}`,
                        `Motivation: ${brief.motivation}`,
                        `Acceptance criteria:`,
                        ...brief.acceptanceCriteria.map((c) => `- ${c}`),
                        ...(brief.outOfScope?.length ? ["Out of scope:", ...brief.outOfScope.map((c) => `- ${c}`)] : []),
                    ].join("\n"),
                    diffPath: diffFile,
                    repoPath: plan.worktreePath,
                    runtime,
                    reviewChecklist: plan.reviewChecklist,
                    model: config.models.adversary,
                    timeoutSeconds: config.loop.adversary_timeout_seconds,
                    // beta.63 (Fix 1): carry the repo conventions ingested at brief build
                    // so the adversary flags convention violations even when CI is green.
                    repoConventions: brief.repoConventions,
                    // beta.69 (F3): prior-cycle findings for provenance + the verdict gate.
                    priorFindings,
                    // beta.69 (F1): a "no tests" finding is only diff-addressable when the
                    // repo actually declares a `test` script. Detect it from the worktree
                    // package.json so the classifier treats its absence as a process
                    // concern (the repo has no test script by design), not a diff defect.
                    repoHasTestScript: (() => {
                        try {
                            return discoverCheckScripts(plan.worktreePath).some((s) => s.name === "test");
                        }
                        catch {
                            return false;
                        }
                    })(),
                }, {
                    logger: api.logger,
                    readDiff: async (p) => (await readFile(p, "utf8")),
                    // beta.91 (Staging pass-2 nit): surface file-attribution retry
                    // before/after counts so a WORSE retry (rejected by the guard, e.g.
                    // the priorFindings-conflation edge) is visible in prod logs.
                    onFileAttributionRetry: (info) => api.logger.info("[adversary] loop.file_attribution_retry", {
                        event: "loop.file_attribution_retry",
                        before: info.before,
                        after: info.after,
                        applied: info.applied,
                        hadPriorFindings: info.hadPriorFindings,
                    }),
                    callAdversaryModel: async (params) => {
                        const r = await runAdversarySdk({
                            ...params,
                            execute: executorFor("adversary"),
                            apiKey: await anthropicApiKey(),
                        });
                        return {
                            parsed: {
                                verdict: r.parsed.verdict,
                                findings: r.parsed.findings.map((f) => ({
                                    dimension: f.dimension ?? "quality",
                                    // rc.3: was `f.severity ?? "low"`, which made a missing
                                    // severity non-blocking and passed "Medium" through verbatim
                                    // for `isBlockingFinding` to reject on casing.
                                    severity: normaliseSeverity(f.severity),
                                    title: f.title ?? "(untitled)",
                                    detail: f.detail ?? "",
                                    file: f.file,
                                    line: f.line,
                                    // beta.119: the other paths the fix needs. This mapper picks
                                    // fields explicitly, so an unlisted one is silently dropped
                                    // however well the prompt asks for it.
                                    relatedFiles: Array.isArray(f.relatedFiles)
                                        ? f.relatedFiles.filter((p) => typeof p === "string" && p.trim().length > 0)
                                        : undefined,
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
            }
            finally {
                await rm(diffFile, { force: true }).catch(() => undefined);
            }
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
            // beta.34: vault-first + env fallback (was vault-only, which lost the
            // token on the vault-less Staging container).
            const token = await resolveVercelToken();
            if (!token) {
                // No token from vault or env -> deploy verification unavailable.
                // Surface it explicitly rather than calling the API unauthenticated.
                return {
                    provider: "vercel",
                    status: "unavailable",
                    logsExcerpt: "Vercel token unavailable (no vault entry and env fallback unset). Set VERCEL_TOKEN or the vault service.",
                    errorCount: undefined,
                };
            }
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
                // beta.57 (P3): route through the resolved API base (GH Enterprise).
                apiBase: resolution.apiBase,
                // beta.32: default to NON-draft. Opening a draft PR on a repo that
                // doesn't support drafts (private/free) returns HTTP 422 and killed
                // the run at the final step. Only draft when explicitly enabled; the
                // adapter also retries non-draft on a 422. The verdict warning is in
                // the PR body regardless.
                draft: (config.repos.draft_pr_on_nonpass ?? false) && reviewReport.verdict !== "pass",
                // rc.3: the do-not-merge warning was PR body text and a column in the
                // harness's DB -- nothing a branch-protection rule or a PR list could
                // see. A label is checkable.
                labels: prLabelsFor(reviewReport),
                logger: api.logger,
            });
            // beta.75 (#1): post the review verdict + findings as a PR COMMENT on
            // EVERY review -- not just at PR creation. createPullRequest writes the
            // review into the PR body only on the first open; when the PR already
            // exists (updatedExisting: a revise, or a harness_run D2-promoted onto an
            // open-PR branch) the body is NOT rewritten, so the new verdict/findings
            // were invisible on the PR (Carel on #876). A fresh comment per review
            // surfaces the current verdict/findings on the PR timeline. Best-effort:
            // NEVER fail the run on a comment error -- the code + PR already landed.
            try {
                const commentBody = renderReviewComment(reviewReport, {
                    updatedExisting: !!pr.updatedExisting,
                    operatorGuidance: brief.operatorGuidance,
                });
                const c = await postPrComment({ repoFullName: plan.repo, prNumber: pr.number, body: commentBody, ghToken, apiBase: resolution.apiBase });
                if (!c.ok) {
                    api.logger.warn("[harness] PR review comment post failed (non-fatal)", { repo: plan.repo, prNumber: pr.number, status: c.status, error: c.error });
                }
            }
            catch (err) {
                api.logger.warn("[harness] PR review comment post threw (non-fatal)", { repo: plan.repo, prNumber: pr.number, err: String(err) });
            }
            return pr.htmlUrl;
        },
        // beta.8 fix #1: HARNESS-SIDE observable-side-effect probes. The loop
        // runs these after every sub-task, independent of the worker. They hit
        // git / the provider REST API / disk directly so a confabulated
        // "I pushed" / "I opened a PR" is caught deterministically.
        // beta.129: this MUST throw rather than resolve to "". The abort-salvage
        // guard reads an empty sha as "no commits to protect" and deletes the
        // worktree, so swallowing here turned every probe failure into work loss
        // (b119 in full, d48ba433 again). Every other call site applies its own
        // `.catch(() => "")`, which is the right place for it -- they want a
        // best-effort sha; only the salvage guard needs to know it failed.
        worktreeHeadSha: async (worktreePath) => git.baseSha(worktreePath),
        // beta.67 (Bug B): fork-point + branch commit-count probes for the
        // plan_base_sha capture (at plan_ready) and the adversary diff-base sanity
        // log. The adversary review then diffs against the branch's own
        // fork-point, not against main-at-review-time.
        worktreeMergeBase: async (worktreePath, baseBranch) => git.mergeBase(worktreePath, baseBranch).catch(() => ""),
        worktreeCommitCount: async (worktreePath, base) => git.commitCount(worktreePath, base).catch(() => -1),
        // beta.101: ledger-reachability probe. Returns [] on failure so the guard
        // fails OPEN -- a broken probe must never block an otherwise sound run.
        unreachableCommits: async (worktreePath, from, shas) => git.unreachableCommits(worktreePath, from, shas).catch(() => []),
        // beta.101: tracked-file listing for plan-time fictional-path detection.
        listRepoFiles: async (worktreePath) => git.listTrackedFiles(worktreePath).catch(() => []),
        // beta.64 (P0-3/P0-4): diff-stat + scripted tsc for the best-effort-verify
        // clean-diff gate and the scripted verifier fallback of a timed-out LLM
        // VERIFY sub-task. A "run tsc/diff/check-scripts" verify step needs no model.
        gitDiffStat: async (worktreePath, base) => git.diffStat(worktreePath, base).catch(() => ""),
        // beta.94 (Feature 1b): committed files in <base>..HEAD for the deterministic
        // final-scope check (out-of-scope commit -> fit/medium review finding).
        worktreeCommittedFiles: async (worktreePath, base) => git.listCommittedFiles(worktreePath, base).catch(() => []),
        // beta.115: the typecheck gate's escape hatch when `npm run typecheck` is
        // unrunnable, plus the evidence needed to explain why it was.
        runTypecheckDirect: (worktreePath, timeoutMs) => runTypecheckDirect(worktreePath, timeoutMs),
        diagnoseCheckEnv: (worktreePath) => diagnoseCheckEnv(worktreePath),
        runScriptedTsc: async (worktreePath, timeoutMs) => {
            const res = spawnSync("npx", ["tsc", "--noEmit"], { cwd: worktreePath, timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
            const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
            return { ok: !res.error && (res.status ?? 1) === 0, output: output.slice(-4000) };
        },
        // beta.81 (Track B / B2): post-push CI verification. Poll the combined
        // GitHub status/check-runs for the pushed head SHA (getCombinedStatus is
        // the existing beta.34 primitive). Token resolved via the same pat.resolve
        // path as the push; a token-less read still works for public repos.
        ciCombinedStatus: async ({ repoFullName, sha, requester }) => {
            const [owner] = repoFullName.split("/");
            const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner, repoFullName });
            const ghToken = await resolveGitToken(resolution).catch(() => "");
            return getCombinedStatus({ repoFullName, sha, ghToken, apiBase: resolution.apiBase });
        },
        // beta.119: the structured read behind the verdict. The polling loop needs
        // the check-run COUNT (not just the state) to reject a stale, shrunken
        // check list that would otherwise read as green.
        ciSnapshot: async ({ repoFullName, sha, requester }) => {
            const [owner] = repoFullName.split("/");
            const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner, repoFullName });
            const ghToken = await resolveGitToken(resolution).catch(() => "");
            return getCiSnapshot({
                repoFullName, sha, ghToken, apiBase: resolution.apiBase,
                workflowRunsFallback: config.ci?.workflow_runs_fallback !== false,
            });
        },
        // beta.119: can this repo's token push workflow files? Resolved through the
        // same pat.resolve path as the push, so the answer is about the token that
        // will actually do the pushing.
        tokenScopes: async ({ repoFullName, requester }) => {
            const [owner] = repoFullName.split("/");
            const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner, repoFullName });
            const ghToken = await resolveGitToken(resolution).catch(() => "");
            if (!ghToken)
                return null;
            return canPushWorkflows(await getTokenScopes({ ghToken, apiBase: resolution.apiBase }));
        },
        // beta.81 (Track B / B2): on CI failure, fetch the failing check-run logs
        // (names + output summaries) as the revise finding source. Best-effort.
        ciFailingLogs: async ({ repoFullName, sha, requester }) => {
            const [owner] = repoFullName.split("/");
            const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner, repoFullName });
            const ghToken = await resolveGitToken(resolution).catch(() => "");
            return getFailingCheckLogs({ repoFullName, sha, ghToken, apiBase: resolution.apiBase });
        },
        // beta.81 (Track B / B3): when a repo has no CI, author + commit a GitHub
        // Actions workflow running its declared check scripts so CI runs on GitHub
        // (never a local fallback). Committed with the harness commit identity.
        ciAuthorWorkflow: async ({ worktreePath }) => {
            // The commit is a CI-config file; identity is cosmetic. Use the first
            // configured commit identity when present, else a stable harness default.
            const anyIdentity = Object.values(config.pat_routing.commit_identity ?? {})[0];
            return authorCiWorkflow({
                worktreePath,
                gitCommit: (wt, msg) => git.commit(wt, msg, {
                    name: anyIdentity?.name || "openclaw-agent-harness",
                    email: anyIdentity?.email || "harness@openclaw.local",
                }),
            });
        },
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
        buildVerifyProbes: createVerifyProbes({ git, pat, config, resolveGitToken }),
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
        // beta.37: progress is surfaced via the POLL model, not a direct Slack
        // post. The harness is tool-driven (beta.34 removed the Slack listener),
        // so it must NOT talk to Slack itself. The old implementation posted to
        // sessions.slack_channel/thread — which are ""/"agent:<uuid>" for
        // agent-orchestrated runs — so every post was rejected by Slack and
        // swallowed by a blind .catch(() => {}); not a single line ever reached
        // anyone. Now reportProgress ONLY writes a `loop.progress` audit row so the
        // phase transition shows up in the event tail that `harness_progress`
        // returns. The calling OpenClaw agent polls `harness_progress` and relays
        // updates to Slack in its own voice.
        reportProgress: async (sessionId, status, meta) => {
            try {
                state.audit("loop.progress", { status, ...(meta && typeof meta === "object" ? meta : { meta }) }, sessionId);
            }
            catch (err) {
                api.logger.warn("[harness] reportProgress audit failed", { sessionId, status, err: String(err) });
            }
        },
        // beta.77: harness-native OUTBOUND progress/terminal delivery. Fired from
        // the loop's `setStatus` on EVERY phase + terminal transition. Best-effort
        // direct `chat.postMessage` to Slack via the vault bot token -- an
        // INDEPENDENT path from the wedge-prone agent `api.sendMessage` turn, so a
        // wedged channel-agent poller can no longer blind a run's progress/terminal.
        // Gated: (1) a poster was built (credential_service resolved a token), (2)
        // native_progress_delivery not disabled, (3) the session has a REAL Slack
        // binding (channel + non-synthetic thread passed on harness_run). Otherwise
        // no-op -> graceful fallback to the poll model (unchanged behaviour).
        // Clarifications/inbound stay agent-mediated (harness_answer) -- untouched.
        deliverProgress: (sessionId, status) => {
            // beta.88 [E4]: evict this session's de-dup entry on a terminal transition
            // so `lastProgressHeadline` doesn't grow one entry per session for the
            // life of the process. Done before the poster gate so it evicts even when
            // native delivery is off.
            if (status === "done" || status === "failed" || status === "aborted") {
                runtime.lastProgressHeadline?.delete(sessionId);
            }
            const poster = runtime.progressPoster;
            if (!poster)
                return; // no token -> poll-model fallback
            if (config.slack.native_progress_delivery === false)
                return;
            let bind;
            try {
                bind = state.db
                    .prepare(`SELECT slack_channel, slack_thread FROM sessions WHERE id = ?`)
                    .get(sessionId);
            }
            catch {
                return;
            }
            const channel = bind?.slack_channel ?? "";
            const thread = bind?.slack_thread ?? "";
            if (!hasRealSlackBinding(channel, thread))
                return; // agent-orchestrated run -> poll model
            // beta.96: a TERMINAL transition must ALWAYS speak. Pre-b96 a plan-phase
            // death had an empty ledger -> empty headline -> `if (!headline) return`
            // dropped the only failure signal (session 1b267b86, ~2h no feedback).
            const isTerminal = status === "done" || status === "failed" || status === "aborted";
            let headline = "";
            try {
                headline = buildProgressSnapshot(state.db, sessionId).headline;
            }
            catch {
                if (!isTerminal)
                    return; // snapshot failure only silences non-terminals
            }
            if (!headline && isTerminal)
                headline = terminalFallbackHeadline(state.db, sessionId, status);
            if (!headline)
                return;
            // beta.86: skip an IDENTICAL consecutive headline for this session (nit:
            // per-sub-task fire could double-post the same "Executing sub-task N/M"
            // line for two back-to-back sub-tasks before the ledger differs).
            const dedup = (runtime.lastProgressHeadline ??= new Map());
            if (dedup.get(sessionId) === headline)
                return;
            dedup.set(sessionId, headline);
            // beta.97 (Fix #4): the TERMINAL post is the one message a run must not
            // lose -- b96 guaranteed we always GENERATE a reason-bearing terminal
            // headline, but a single fire-and-forget best-effort POST still drops it
            // on a transient Slack 429/5xx/network blip (zero-feedback death via the
            // transport vector). Route terminal posts through the bounded-retry
            // Retry-After path; keep the high-frequency PROGRESS stream on the
            // best-effort single-shot post (a dropped mid-run headline is harmless).
            // Both never throw.
            if (isTerminal) {
                void poster.postTerminal(channel, thread, `:robot_face: ${headline}`).catch(() => undefined);
            }
            else {
                void poster.post(channel, thread, `:robot_face: ${headline}`).catch(() => undefined);
            }
        },
        // beta.78 (Feature 1+2): ad-hoc warning delivery over the SAME independent
        // direct-post channel as deliverProgress. Same gating (poster present +
        // native_progress_delivery not disabled + real Slack binding). No-op for
        // agent-orchestrated runs (they get the warning via the poll model /
        // harness_progress). Best-effort; never throws.
        postWarning: (sessionId, text) => {
            const poster = runtime.progressPoster;
            if (!poster)
                return;
            if (config.slack.native_progress_delivery === false)
                return;
            let bind;
            try {
                bind = state.db
                    .prepare(`SELECT slack_channel, slack_thread FROM sessions WHERE id = ?`)
                    .get(sessionId);
            }
            catch {
                return;
            }
            const channel = bind?.slack_channel ?? "";
            const thread = bind?.slack_thread ?? "";
            if (!hasRealSlackBinding(channel, thread))
                return;
            if (!text)
                return;
            void poster.post(channel, thread, text).catch(() => undefined);
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
        config, state, budget, pat, loop, interactionLog, listener, dispatcher, slack, git, creds,
        vault, vaultError: vaultOpenError,
        // beta.77: built during async bootstrap when slack.credential_service
        // resolves a token; null until then (and forever without one).
        progressPoster: null,
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
        routeOverlay,
        gitResolutionFor: (repoFullName, slackUserId) => {
            const repo = repoFullName ?? config.repos.allowed.find((r) => !r.includes("*")) ?? config.repos.allowed[0];
            if (!repo)
                return undefined;
            const glob = "/" + "*";
            const concrete = repo.endsWith(glob) ? repo.slice(0, -1) + "_probe" : repo;
            try {
                const r = pat.resolve({
                    // beta.133: onboarding needs the name THIS requester resolves to, not
                    // whatever the first authorised user would get. With a {userid} or
                    // {requester} pattern those differ, which is exactly the case the
                    // onboard consistency check exists to catch.
                    slackUserId: slackUserId ?? config.slack.authorised_users[0] ?? "unknown",
                    gitHubUser: concrete.split("/")[0],
                    repoFullName: concrete,
                });
                const tp = r.tokenPointer;
                const tokenSource = tp ? (tp.vault ? "vault" : tp.env ? "env" : "value") : undefined;
                return {
                    credentialService: r.credentialService,
                    provider: r.provider,
                    apiBase: r.apiBase,
                    apiKeyEnv: r.apiKeyEnv,
                    tokenSource,
                    vaultPointer: tp?.vault,
                };
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
                // beta.57 (P3): GitLab MR creation is not implemented yet (issue #25).
                // Say so at PREFLIGHT, before any spend, instead of letting the run
                // burn its whole budget and fail at the final push-and-open-MR step.
                const gitlabNote = resolution.provider === "gitlab"
                    ? "Note: automated merge-request creation for GitLab is not yet implemented (issue #25). The run will complete and push its branch, but you will need to open the MR manually."
                    : "";
                return { ok: true, missing: [], message: gitlabNote, provenance: resolution.provenance };
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
        mergePr: async ({ sessionId, invokedBy, repairBudgetUsd }) => {
            // beta.57 (P2): invokedBy is REQUIRED. It used to be optional and only
            // checked when present, so omitting it merged a PR with no authorisation.
            if (!invokedBy || !config.slack.authorised_users.includes(invokedBy)) {
                return { ok: false, message: `Invoker ${invokedBy ?? "(missing)"} is not authorised (invokedBy is required).` };
            }
            const row = state.db
                .prepare(`SELECT repo, requester_gh, requester, status, pr_number, final_pr_url, merge_recommendation, merge_recommendation_reason, pr_merged
             FROM sessions WHERE id = ?`)
                .get(sessionId);
            if (!row)
                return { ok: false, message: `No session ${sessionId}.` };
            if (!row.pr_number || !row.final_pr_url) {
                return { ok: false, message: `Session ${sessionId} has no open PR to merge (status: ${row.status}).` };
            }
            if (row.pr_merged === 1) {
                return { ok: false, merged: true, message: `PR #${row.pr_number} is already merged.` };
            }
            // Is this project Vercel-configured? That decides the gate policy.
            const vercelConfigured = !!(config.vercel?.enabled && config.vercel.project_id);
            // The FINAL adversary verdict for this session (distinguishes a
            // "revise" do-not-merge from a genuinely blocking one).
            const lastReviewRow = state.db
                .prepare(`SELECT verdict, findings FROM reviews WHERE session_id = ? ORDER BY cycle DESC LIMIT 1`)
                .get(sessionId);
            const lastVerdict = (lastReviewRow?.verdict ?? "").toLowerCase();
            let hasBlockingFinding = false;
            // rc.5: true when EVERY finding standing between this PR and a merge is an
            // `env` one -- the harness reporting it could not verify something, rather
            // than a defect anybody can fix. Those are cleared by a green pipeline,
            // not by a code change, so they are resolved against CI further down
            // instead of hard-refusing here.
            let envOnlyBlock = false;
            try {
                const findings = lastReviewRow?.findings ? JSON.parse(lastReviewRow.findings) : [];
                // rc.3: this used to count only high/critical, so a `medium` finding --
                // blocking everywhere else in the system -- left the PR eligible for the
                // Vercel override.
                //
                // rc.5: and it read severity with no classification at all, so it
                // disagreed with the recommendation it was gating on. The beta.115
                // typecheck-gate finding is deliberately `high` and deliberately
                // non-blocking; severity alone made it an unoverridable blocker on every
                // run on a host with no `tsc`, which is a permanent refusal rather than
                // a safety check. Classify, then ask what the class means for a merge.
                const blockers = findings.filter((f) => blocksMerge(f, classifyFinding(f, { repoHasTestScript: true })));
                hasBlockingFinding = blockers.length > 0;
                envOnlyBlock =
                    blockers.length > 0 &&
                        blockers.every((f) => classifyFinding(f, { repoHasTestScript: true }) === "env");
            }
            catch { /* ignore malformed */ }
            // ---- GATE (beta.36: Vercel-aware) ----
            // Baseline recommendation from ship time.
            const rec = (row.merge_recommendation ?? "do_not_merge");
            // beta.62: `needs_human_review` (graceful PR opened after a review crash,
            // work self-verified green but the adversary never signed off) is NEVER
            // auto-overridable -- there is no machine verdict to lean on, so a human
            // MUST look. It always takes the hard-refuse branch regardless of Vercel.
            const reviewCrashPr = rec === "needs_human_review";
            // A do-not-merge is OVERRIDABLE (auto-merge allowed) ONLY when:
            //   - the project is Vercel-configured (so the post-merge deploy
            //     verification is the runtime arbiter the loop never had), AND
            //   - the reason is a `revise` verdict (improvable), NOT a `block`
            //     verdict and NOT a surviving blocking-severity finding.
            // A `block` verdict, a blocking-severity finding, or a non-Vercel
            // project keeps the HARD refuse (human merges via the GitHub UI).
            const reviseOnly = lastVerdict === "revise" && !hasBlockingFinding;
            const overridable = vercelConfigured && reviseOnly && !reviewCrashPr;
            // rc.5: an env-ONLY block asks a question CI can answer, so it is deferred
            // rather than refused here. "The harness could not typecheck this" matters
            // only if nothing else did -- and the merge path below already refuses
            // unless CI is EXPLICITLY green (beta.119 made failure, pending and
            // unreadable all hard refusals). So if the repo's own pipeline went green,
            // the thing the harness could not verify has been verified, and a missing
            // local `tsc` should not be a permanent bar to every merge on that host.
            // If CI is absent or not green, the deferral is refused below.
            const deferToCi = rec !== "merge" && !overridable && envOnlyBlock && !reviewCrashPr && lastVerdict !== "block";
            if (rec !== "merge" && !overridable && !deferToCi) {
                state.audit("tool.merge_refused", { sessionId, prNumber: row.pr_number, recommendation: rec, lastVerdict, hasBlockingFinding, vercelConfigured }, sessionId);
                return {
                    ok: false,
                    refused: true,
                    recommendation: rec,
                    message: `Refusing to merge PR #${row.pr_number}. HARD SAFETY GATE. ` +
                        (reviewCrashPr
                            ? `Recommendation: NEEDS HUMAN REVIEW — ${row.merge_recommendation_reason ?? "the adversary review did not complete"}. The code work self-verified green but the adversary never produced a sign-off, so a human MUST review before merge. `
                            : `Recommendation: DO NOT MERGE — ${row.merge_recommendation_reason ?? "no clean adversary sign-off"}. `) +
                        (lastVerdict === "block" || hasBlockingFinding
                            ? `The adversary raised a BLOCKING concern; this is never auto-overridden. `
                            : reviewCrashPr
                                ? `An incomplete adversary review is never auto-overridden. `
                                : !vercelConfigured
                                    ? `This project has no Vercel deploy verification, so there's no runtime arbiter to auto-merge behind. `
                                    : ``) +
                        `To merge anyway, use the GitHub UI (deliberately outside this automation).`,
                };
            }
            if (rec !== "merge" && overridable) {
                state.audit("tool.merge_override", { sessionId, prNumber: row.pr_number, reason: "vercel_revise_override", lastVerdict }, sessionId);
            }
            // Resolve token for the repo.
            let ghToken;
            try {
                const resolution = pat.resolve({
                    slackUserId: row.requester,
                    gitHubUser: row.repo.split("/")[0],
                    repoFullName: row.repo,
                });
                ghToken = await resolveGitToken(resolution);
            }
            catch (err) {
                return { ok: false, recommendation: rec, message: `Could not resolve a token to merge PR #${row.pr_number}: ${String(err)}` };
            }
            // Re-check CI on the PR head right before merge (recommendation was
            // computed at ship time; CI may have moved).
            let mergeSha = "";
            try {
                const pr = await getPullRequest({ repoFullName: row.repo, prNumber: row.pr_number, ghToken });
                if (pr.merged) {
                    state.db.prepare(`UPDATE sessions SET pr_merged = 1, pr_merged_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), sessionId);
                    return { ok: true, merged: true, recommendation: rec, message: `PR #${row.pr_number} was already merged on GitHub.` };
                }
                const ciSnap = await getCiSnapshot({ repoFullName: row.repo, sha: pr.headSha, ghToken });
                const ci = ciSnap.state;
                if (ci === "failure") {
                    state.audit("tool.merge_refused", { sessionId, prNumber: row.pr_number, reason: "ci_failure", ciReason: ciSnap.reason }, sessionId);
                    return {
                        ok: false, refused: true, recommendation: rec,
                        message: `Refusing to merge PR #${row.pr_number}: CI is FAILING on the head commit (${ciSnap.reason}). Hard gate — fix CI or merge from the GitHub UI.`,
                    };
                }
                // beta.119: an unreadable CI state is not a green one. Pre-b119 this
                // gate only refused on an explicit "failure", so the same unreadable
                // check-run list that faked a green ship would also have waved the
                // merge through. Refuse and make a human look.
                if (ci === "unknown") {
                    state.audit("tool.merge_refused", { sessionId, prNumber: row.pr_number, reason: "ci_indeterminate", ciReason: ciSnap.reason }, sessionId);
                    return {
                        ok: false, refused: true, recommendation: rec,
                        message: `Refusing to merge PR #${row.pr_number}: could not determine CI state on the head commit (${ciSnap.reason}). Hard gate — check the PR's checks tab, or merge from the GitHub UI.`,
                    };
                }
                // beta.119: still-running checks are likewise not a pass. The b118
                // false-green shipped while Tests was mid-flight and Tests later failed.
                if (ci === "pending") {
                    state.audit("tool.merge_refused", { sessionId, prNumber: row.pr_number, reason: "ci_pending", ciReason: ciSnap.reason }, sessionId);
                    return {
                        ok: false, refused: true, recommendation: rec,
                        message: `Refusing to merge PR #${row.pr_number}: CI is still running on the head commit (${ciSnap.reason}). Hard gate — wait for CI, then retry.`,
                    };
                }
                // rc.5: resolve the env-only deferral. The three refusals above have
                // already taken failure, unreadable and pending, so the only non-green
                // state left here is `none` -- a repo with no checks configured. That is
                // the case the beta.115 finding exists for: the harness could not verify
                // the code and neither did anything else, so nothing has. Refuse.
                // Written as `!== "success"` rather than `=== "none"` so a new CI state
                // fails toward the refusal.
                if (deferToCi && ci !== "success") {
                    state.audit("tool.merge_refused", { sessionId, prNumber: row.pr_number, reason: "env_block_no_green_ci", ci, ciReason: ciSnap.reason }, sessionId);
                    return {
                        ok: false, refused: true, recommendation: rec,
                        message: `Refusing to merge PR #${row.pr_number}. ${row.merge_recommendation_reason ?? "The harness could not verify this change."} ` +
                            `CI could not clear it either (${ciSnap.reason}), so nothing has verified this code. ` +
                            `Hard gate — fix the harness's check environment, add CI, or merge from the GitHub UI.`,
                    };
                }
                if (deferToCi) {
                    state.audit("tool.merge_override", { sessionId, prNumber: row.pr_number, reason: "env_block_cleared_by_green_ci", ci }, sessionId);
                }
                const merged = await mergePullRequest({ repoFullName: row.repo, prNumber: row.pr_number, ghToken, method: "squash" });
                mergeSha = merged.sha;
                state.db.prepare(`UPDATE sessions SET pr_merged = 1, pr_merged_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), sessionId);
                state.audit("tool.merged", { sessionId, prNumber: row.pr_number, mergeSha, ci }, sessionId);
            }
            catch (err) {
                return { ok: false, recommendation: rec, message: `Merge of PR #${row.pr_number} failed: ${String(err)}` };
            }
            // ---- Post-merge Vercel deploy verification (+ beta.36 repair loop) ----
            let deploy;
            let repairMessage = "";
            if (config.vercel?.enabled) {
                const vToken = await resolveVercelToken();
                if (!vToken) {
                    deploy = { status: "unavailable", detail: "Vercel enabled but no token (vault + env empty)." };
                    state.db.prepare(`UPDATE sessions SET deploy_status = ?, deploy_detail = ?, updated_at = ? WHERE id = ?`).run("unavailable", deploy.detail, Date.now(), sessionId);
                }
                else {
                    const dv = await verifyDeploymentForSha({
                        vercelToken: vToken,
                        teamId: config.vercel.team_id,
                        projectId: config.vercel.project_id,
                        sha: mergeSha,
                        waitSeconds: config.vercel.preview_wait_seconds,
                        logger: api.logger,
                    });
                    deploy = { status: dv.status, detail: dv.detail, deploymentUrl: dv.deploymentUrl, logsExcerpt: dv.logsExcerpt };
                    state.db.prepare(`UPDATE sessions SET deploy_status = ?, deploy_detail = ?, updated_at = ? WHERE id = ?`).run(dv.status, `${dv.detail}${dv.logsExcerpt ? "\n" + dv.logsExcerpt : ""}`.slice(0, 5000), Date.now(), sessionId);
                    state.audit("tool.deploy_verified", { sessionId, mergeSha, deployStatus: dv.status }, sessionId);
                    // ---- beta.36: deploy ERRORED -> auto-repair loop ----
                    const repairCfg = config.vercel.deploy_repair;
                    if (dv.status === "error" && repairCfg?.enabled) {
                        const repairBudget = repairBudgetUsd && repairBudgetUsd > 0
                            ? repairBudgetUsd
                            : config.budgets.daily_max_usd * repairCfg.budget_ratio;
                        const repairResult = await runDeployRepair(buildDeployRepairDeps({ config, state, git, pat, crystallise, loop, api, resolveGitToken, resolveVercelToken, requester: row.requester }), {
                            sessionId,
                            repoFullName: row.repo,
                            originalMergeSha: mergeSha,
                            originalDeploy: { status: "error", detail: dv.detail, deploymentUrl: dv.deploymentUrl, logsExcerpt: dv.logsExcerpt },
                            maxAttempts: repairCfg.max_attempts,
                            repairBudgetUsd: repairBudget,
                        });
                        repairMessage = ` ${repairResult.message}`;
                        if (repairResult.outcome === "repaired" && repairResult.finalDeploy) {
                            deploy = {
                                status: repairResult.finalDeploy.status,
                                detail: repairResult.finalDeploy.detail,
                                deploymentUrl: repairResult.finalDeploy.deploymentUrl,
                                logsExcerpt: repairResult.finalDeploy.logsExcerpt,
                            };
                        }
                    }
                }
            }
            const deployMsg = deploy?.status === "ready" ? ` Deploy is READY (${deploy.deploymentUrl}).`
                : deploy?.status === "error" ? ` \u26a0\ufe0f Deploy ERRORED — ${deploy.detail}`
                    : deploy?.status === "pending" ? ` Deploy still building — ${deploy.detail}`
                        : deploy?.status === "unavailable" ? ` Deploy status unavailable — ${deploy.detail}`
                            : "";
            return {
                ok: true, merged: true, mergeSha, recommendation: rec, deploy,
                message: `Merged PR #${row.pr_number} (squash, ${mergeSha.slice(0, 12)}).${deployMsg}${repairMessage}`,
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
    // beta.34: the harness Slack LISTENER is removed. The harness is a pure
    // tool-driven engine: the OpenClaw agent is the SOLE operator and drives it
    // via harness_run / harness_start_session / harness_merge_pr / ... The
    // harness NEVER subscribes to inbound Slack messages, so:
    //   - it can never be independently addressed in a channel (the privileged
    //     surface — PATs, PR merges — is only reachable through the agent's tool
    //     layer, which carries the agent's auth/approval context);
    //   - the bot-to-bot loop risk is structurally eliminated (no two OpenClaws
    //     talking in a channel).
    // beta.133: `slack.listener_enabled` is no longer part of the config at all.
    // The key is still accepted from older configs and discarded during parse, so
    // the question "was it set?" can only be asked of the RAW input. Progress
    // posting to a channel/thread explicitly passed into a tool call still
    // works via the dispatcher/slack adapter — that's OUTBOUND only.
    void messageHandler; // retained for potential future use; never subscribed.
    if (declaresRemovedListenerFlag(rawConfig)) {
        api.logger.warn("[harness] slack.listener_enabled was removed in beta.133 and has been IGNORED since beta.34, " +
            "when the Slack listener was deleted. The harness is tool-driven only (drive it via " +
            "harness_run / harness_start_session / harness_merge_pr). Remove this config key.");
    }
    else {
        api.logger.info("[harness] tool-driven mode -- the harness does NOT listen to Slack. " +
            "Drive it via harness_run / harness_start_session / harness_merge_pr tools.");
    }
    // v2.0.0: parallel sub-task dispatch is gone. Warn rather than refuse: a
    // config naming these keys is not wrong, it is old, and refusing it would
    // take the plugin offline over a setting that no longer does anything.
    const removedParallelKeys = declaresRemovedParallelKeys(rawConfig);
    if (removedParallelKeys.length > 0) {
        api.logger.warn(`[harness] loop.${removedParallelKeys.join(", loop.")} ` +
            `${removedParallelKeys.length === 1 ? "was" : "were"} removed in v2.0.0 and ${removedParallelKeys.length === 1 ? "is" : "are"} now IGNORED. ` +
            "Sub-tasks run one at a time, in the session worktree. " +
            `Remove ${removedParallelKeys.length === 1 ? "this key" : "these keys"} from your config.`);
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
                // beta.57 (P3): use the shared vault-first + ENV-FALLBACK resolver.
                // The watcher previously called creds.getToken() directly (vault-only),
                // so on the vault-less Staging container every poll failed even though
                // GH_TOKEN was set -- merged PRs were never noticed and their
                // worktrees never released.
                return resolveGitToken(resolution);
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
    // beta.67 (Bug A): EXTERNAL stall-sweep service. beta.66 smoke #4 died
    // between a worker sdk_response and the next handler step -- the loop-runner
    // PROCESS was gone, so beta.63's in-process checkStalls could never fire (a
    // dead process cannot watchdog its own death) and a pending harness_cancel
    // was never consumed. This periodic service runs INDEPENDENT of any
    // loop-runner process and drives loop.sweepStalls() (which runs the existing
    // checkStalls fast path + reaps pending-cancel dead-loop sessions). Uses the
    // same api.registerService lifecycle as pr-watcher / retention-nightly, with
    // an in-process setInterval fallback when the runtime has no service hook.
    {
        const sweepSeconds = config.loop.stall_sweep_interval_seconds ?? 60;
        const sweepMs = Math.max(15, Math.min(600, sweepSeconds)) * 1000;
        let timer;
        let inFlight = false;
        const tick = () => {
            if (inFlight)
                return; // never overlap sweeps
            inFlight = true;
            void loop
                .sweepStalls()
                .then((r) => {
                if (r.recovered.length > 0 || r.terminated.length > 0) {
                    api.logger.info("[harness] stall-sweep acted", {
                        recovered: r.recovered.length,
                        terminated: r.terminated.length,
                    });
                }
            })
                .catch((err) => api.logger.warn("[harness] stall-sweep tick failed", { err: String(err) }))
                .finally(() => { inFlight = false; });
        };
        if (api.registerService) {
            const dispose = api.registerService({
                id: `${PLUGIN_ID}:stall-sweep`,
                start: () => { timer = setInterval(tick, sweepMs); },
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
            timer = setInterval(tick, sweepMs);
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
    // beta.78 (Feature 3): loudly surface incoherent budget configs at startup.
    // Non-fatal (the truly nonsensical cases already throw in normaliseConfig);
    // this warns on soft incoherence like daily_max > monthly_per_user.
    try {
        const budgetWarnings = assessBudgetCoherence(config.budgets);
        for (const w of budgetWarnings) {
            api.logger.warn(`[harness] budget config INCOHERENT: ${w}`);
        }
        if (budgetWarnings.length > 0) {
            state.audit("harness.budget_incoherent", { warnings: budgetWarnings, budgets: config.budgets });
        }
    }
    catch (err) {
        api.logger.warn("[harness] budget coherence check threw (non-fatal)", { err: String(err) });
    }
    // Reactions poller (only if slack.credential_service is set so we have a bot token).
    if (config.slack.credential_service) {
        try {
            const slackToken = await creds.getToken(config.slack.credential_service);
            // beta.77: build the harness-native progress poster from the SAME token.
            // Enables direct chat.postMessage for progress/terminal (bypassing the
            // wedge-prone agent api.sendMessage turn) when a session is really bound.
            if (config.slack.native_progress_delivery !== false) {
                runtime.progressPoster = new SlackProgressPoster({ slackToken, logger: api.logger });
                api.logger.info("[harness] native progress poster armed (direct chat.postMessage on real Slack bindings)");
            }
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
    // beta.61: startup model-pricing health check (Carel's ask -- "the harness
    // should check latest pricing on the anthropic api"). LIMITATION: Anthropic
    // has NO pricing API -- GET /v1/models returns model IDs only, not per-token
    // prices. So we cannot auto-refresh the PRICES numbers; what we CAN do is
    // fetch the live model list and warn when a CONFIGURED model is (a) not in
    // our price table (projections fall back to the most-expensive tier -- add a
    // price_override) or (b) not in the live model list (renamed/deprecated id).
    // This is exactly the b60 trap: worker swapped sonnet->opus but the opus id
    // wasn't priced, so budget projections silently ran ~5x low. Best-effort,
    // never throws, never blocks bootstrap.
    try {
        const configuredModels = [config.models.lead, config.models.worker, config.models.adversary, config.models.classifier];
        const apiKey = await runtime.anthropicApiKey();
        const liveIds = apiKey ? await fetchLiveModelIds(apiKey) : null;
        const health = assessModelPricingHealth(configuredModels, liveIds, config.models.price_overrides);
        const unpriced = health.filter((h) => h.unpriced).map((h) => h.model);
        const notLive = health.filter((h) => h.notLive === true).map((h) => h.model);
        if (unpriced.length > 0) {
            api.logger.warn("[harness] model pricing health: configured model(s) have NO price-table entry; budget projections fall back to the most-expensive tier. Add harness.models.price_overrides for accurate budgeting.", { unpriced });
            state.audit("harness.model_pricing_unpriced", { unpriced, notLive }, "");
        }
        if (notLive.length > 0) {
            api.logger.warn("[harness] model pricing health: configured model(s) not found in the live Anthropic /v1/models list; the id may be renamed or deprecated.", { notLive });
        }
        if (liveIds === null) {
            api.logger.info("[harness] model pricing health: /v1/models unreachable (no key or network); using static price table.");
        }
    }
    catch (err) {
        api.logger.warn("[harness] model pricing health check failed (non-fatal)", { err: String(err) });
    }
    // beta.72 (D-A): worktrees-root ownership preflight. Runs BEFORE the
    // self-heal so we surface a root-owned worktrees dir (the recurring
    // EACCES-at-planning-$0.00 footgun) with an actionable chown command at
    // boot, and create the root node-owned on a fresh install so no manual
    // chown is ever needed. See src/state/worktrees-preflight.ts.
    try {
        const { ensureWorktreesRootWritable } = await import("./state/worktrees-preflight.js");
        const { existsSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const worktreesRoot = config.storage.worktree_root.replace(/^~/, process.env.HOME ?? "");
        const pf = ensureWorktreesRootWritable({
            worktreesRoot,
            exists: (p) => existsSync(p),
            mkdirp: (p) => mkdirSync(p, { recursive: true }),
            probeWritable: (p) => {
                const probe = join(p, `.oah-write-probe-${process.pid}-${Date.now()}`);
                try {
                    writeFileSync(probe, "");
                    rmSync(probe, { force: true });
                    return true;
                }
                catch {
                    return false;
                }
            },
            getuid: () => (typeof process.getuid === "function" ? process.getuid() : null),
        });
        if (pf.ok) {
            if (pf.created) {
                api.logger.info("[harness] worktrees root created (node-owned)", { worktreesRoot: pf.worktreesRoot });
            }
            state.audit("harness.worktrees_preflight", { ok: true, created: pf.created, worktreesRoot: pf.worktreesRoot });
        }
        else {
            // BLOCKING diagnostic: a run WILL die with EACCES until this is fixed.
            api.logger.error(`[harness] ${pf.message}`, { worktreesRoot: pf.worktreesRoot, uid: pf.uid, chownCommand: pf.chownCommand });
            state.audit("harness.worktrees_root_not_writable", {
                worktreesRoot: pf.worktreesRoot,
                uid: pf.uid,
                chownCommand: pf.chownCommand,
            });
        }
    }
    catch (err) {
        api.logger.warn("[harness] worktrees-root preflight failed (non-fatal)", { err: String(err) });
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
        // beta.45: resolve worktree paths for loops running in THIS process so the
        // self-heal never reaps a live run's worktree. A concurrent bootstrap
        // (gateway plugin-registry re-registration when an unrelated plugin
        // reloads -- see openclaw#87046 / #107596 eviction family) would otherwise
        // race in and remove the running revise/worker worktree as an "orphan",
        // because the sessions row's `worktree_path` isn't written until AFTER the
        // lead plan completes. Protect by both DB-resolved path and by simply
        // passing the live session ids' recorded worktree_path where available.
        const liveSessionIds = runningSessionIds();
        const protectedWorktreePaths = [];
        if (liveSessionIds.length > 0) {
            try {
                const placeholders = liveSessionIds.map(() => "?").join(",");
                const liveRows = state.db
                    .prepare(`SELECT worktree_path FROM sessions WHERE id IN (${placeholders})`)
                    .all(...liveSessionIds);
                // NOTE: worktree_path is '' (empty) at session INSERT and only gets the
                // real pending-<ts> path at loop.ts:481 AFTER the lead plan completes.
                // During that planning window Guard 1 (path) can't match -- Guard 2
                // (mtime grace window) is the primary protection then. Skip empties.
                for (const r of liveRows)
                    if (r.worktree_path && r.worktree_path.trim())
                        protectedWorktreePaths.push(r.worktree_path);
            }
            catch (err) {
                api.logger.warn("[harness] worktree-heal: failed to resolve live session worktrees", { err: String(err) });
            }
        }
        // beta.55 (B2): a session paused in `awaiting_clarification` is NOT running
        // (its loop returned), so runningSessionIds() misses it -- but its worktree
        // MUST survive so harness_answer can re-drive in place. Add those paths to
        // the protect set explicitly.
        try {
            const pausedRows = state.db
                .prepare(`SELECT worktree_path FROM sessions WHERE status = 'awaiting_clarification'`)
                .all();
            for (const r of pausedRows)
                if (r.worktree_path && r.worktree_path.trim())
                    protectedWorktreePaths.push(r.worktree_path);
        }
        catch (err) {
            api.logger.warn("[harness] worktree-heal: failed to resolve awaiting_clarification worktrees", { err: String(err) });
        }
        // beta.57 (P3): paths with an allocation IN FLIGHT in this process. These
        // have no session row / worktree_path yet; before this the only shield
        // was the 2-minute mtime grace window, which a slow `npm ci` bootstrap
        // could outlive -- letting a concurrent heal reap a mid-allocation dir.
        try {
            const { inFlightWorktreePaths } = await import("./adapters/git-worktree.js");
            protectedWorktreePaths.push(...inFlightWorktreePaths());
        }
        catch (err) {
            api.logger.warn("[harness] worktree-heal: failed to resolve in-flight allocations", { err: String(err) });
        }
        const { statSync } = await import("node:fs");
        const healResult = await healOrphanedWorktrees(state, {
            listWorktreeDirs: () => git.listWorktreeDirs(),
            releaseByPath: (path, repo) => git.releaseByPath(path, repo),
            logger: api.logger,
            fallbackRepoFullName: config.repos.allowed?.[0]?.replace("*", "repo") ?? undefined,
            protectedWorktreePaths,
            dirMtimeMs: (p) => {
                try {
                    return statSync(p).mtimeMs;
                }
                catch {
                    return null;
                }
            },
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
    // notify their Slack threads. Fresh in-flight sessions AUTO-RESUME (re-drive
    // the loop) -- there is no reaction poller or listener to resume them
    // otherwise, so they would strand silently (beta.30 fix for the ProjectThanos
    // symptom). The alternative, leaving them 'resumable' for a human reaction,
    // belonged to listener mode; beta.133 removed the setting that selected it.
    const agentOrchestrated = true;
    try {
        const { recoverSessions } = await import("./state/recovery.js");
        const result = await recoverSessions(state, {
            staleAfterSeconds: config.loop.session_hard_timeout_seconds,
            logger: api.logger,
            agentOrchestrated,
            // beta.81 (Track C / C4): recovery-resume circuit breaker thresholds.
            maxResumes: config.loop.recovery_max_resumes ?? 3,
            resumeWindowSeconds: config.loop.recovery_resume_window_seconds ?? 60,
            // beta.107: ask the live-runner question BEFORE the breaker counts an
            // attempt, not after. The b47 check inside autoResume below stays as
            // defence in depth, but by then the ledger entry already exists.
            isLiveRunner: (id) => runningSessionIds().includes(id),
            autoResume: async (s) => {
                // beta.47: recovery runs on every bootstrap (incl. plugin re-register
                // churn while a session is still mid-flight). If a loop for this
                // session is ALREADY running in-process, re-driving it is pointless
                // noise: the beta.38 re-entrancy guard would just skip it with
                // `loop.run_skipped_already_running` (session 94a516a0 emitted two of
                // those, staleMs 8/11, during a <2min planning window). Skip the
                // re-drive entirely instead of flipping status + re-calling run().
                if (runningSessionIds().includes(s.id)) {
                    api.logger.info("[harness] recovery: session loop already running in-process, skipping auto-resume", { sessionId: s.id });
                    return;
                }
                const row = state.db
                    .prepare(`SELECT crystallised_prompt, lead_plan_json, repo, branch, worktree_path, cycles_ran, cost_usd, final_pr_url
               FROM sessions WHERE id = ?`)
                    .get(s.id);
                if (!row?.crystallised_prompt) {
                    api.logger.warn("[harness] recovery auto-resume: no crystallised brief, marking interrupted", { sessionId: s.id });
                    state.db.prepare(`UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE id = ?`).run(Date.now(), s.id);
                    return;
                }
                // beta.81 (Track C / C3): resume-AT-failed-sub-task instead of a FULL
                // SESSION RESTART. A session interrupted mid-`executing` (forensic
                // d01a7484) has a persisted plan + completed sub-task COMMITS on the
                // worktree. The pre-beta.81 path re-drove `loop.run`, which re-planned
                // from scratch AND re-executed the already-completed sub-tasks
                // (re-burning ~$5) -- and the re-plan itself crashed on an extractJson
                // prose-drift. Instead: mark the orphaned `running` sub-task row(s)
                // `failed`, emit `recovery.resume_at_subtask`, and FAIL the session
                // cleanly, PRESERVING the worktree so the completed commits stay
                // reviewable. This removes the re-burn + the re-plan crash trigger
                // entirely (per the beta.81 spec's terminal datapoint). Gated by
                // loop.recovery_resume_at_subtask (default on) and only for a session
                // that was actually mid-execution with a persisted plan.
                const resumeAtSubtask = config.loop.recovery_resume_at_subtask !== false;
                if (resumeAtSubtask && s.status === "executing" && row.lead_plan_json) {
                    const orphaned = state.db
                        .prepare(`SELECT id, seq FROM sub_tasks WHERE session_id = ? AND status = 'running'`)
                        .all(s.id);
                    for (const o of orphaned) {
                        state.db
                            .prepare(`UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE id = ?`)
                            .run("orphaned by restart; failed on recovery (resume-at-subtask, no full re-plan)", Date.now(), o.id);
                    }
                    // beta.132: `failed` is terminal, and the startup self-heal reaps
                    // every worktree whose session is terminal -- so this path has been
                    // promising preserved commits and then deleting them at the next
                    // bounce, which is precisely the broken promise b129 fixed for
                    // aborts. The flag is what actually keeps it.
                    state.db
                        .prepare(`UPDATE sessions SET status = 'failed', worktree_preserved = 1, updated_at = ? WHERE id = ?`)
                        .run(Date.now(), s.id);
                    state.audit("recovery.resume_at_subtask", { sessionId: s.id, wasStatus: s.status, orphanedSubTasks: orphaned.map((o) => o.seq), reason: "resume_at_failed_subtask_no_replan" }, s.id);
                    api.logger.warn("[harness] recovery: resume-at-subtask -- marked orphaned sub-task(s) failed, session failed cleanly (worktree preserved, no re-plan/re-burn)", { sessionId: s.id, orphaned: orphaned.map((o) => o.seq) });
                    if (s.slack_channel && s.slack_thread) {
                        await slack
                            .replyInThread(s.slack_channel, s.slack_thread, `:warning: Harness restarted mid-execution; the interrupted sub-task was failed and the run stopped (completed sub-task commits are preserved on branch \`${row.branch ?? "?"}\` for review). Re-run to continue -- prior work will not be re-burned.`)
                            .catch(() => undefined);
                    }
                    return;
                }
                // beta.132: b81 protected `executing`. Every other phase of a run that
                // already has a plan fell straight through to the re-drive below, and
                // that re-drive is a FULL RE-PLAN: a fresh lead call and scout ($6.24
                // on average across this repo's own audit history), `cycles_ran` reset
                // to zero, and every sub-task re-run against a branch that already
                // carries their commits.
                //
                // Nobody asks for this. It fires on plugin boot, unattended, for any
                // session left non-terminal -- and restarting the container is how a
                // new build gets installed, so a restart landing on a mid-flight run
                // is routine rather than exotic. Session 2b4c1d33 sat at `planning`
                // holding a $6.03 plan and two finished cycles when a boot picked it
                // up.
                //
                // A session with no plan yet has nothing to lose and still resumes
                // below; the cheap re-drive is the whole point of that path.
                const cyclesRan = Number(row.cycles_ran ?? 0);
                const prUrl = (row.final_pr_url ?? "").trim();
                const verdict = decideRecoveryResume({
                    enabled: config.loop.recovery_replan_guard !== false,
                    hasPlan: Boolean(row.lead_plan_json),
                    cyclesRan,
                    prUrl,
                });
                if (!verdict.resume) {
                    const spent = Number(row.cost_usd ?? 0);
                    if (verdict.outcome === "ship_for_review") {
                        // The work reached GitHub before the restart, so there is nothing
                        // left to rescue -- only a verdict to record.
                        state.db
                            .prepare(`UPDATE sessions SET status = 'done', merge_recommendation = 'needs_human_review',
                        merge_recommendation_reason = ?, updated_at = ? WHERE id = ?`)
                            .run(`The harness restarted while this run was mid-flight, after its PR was already open. Resuming ` +
                            `would have re-planned from scratch and re-spent the lead and scout, so it was left for a human.`, Date.now(), s.id);
                    }
                    else {
                        state.db
                            .prepare(`UPDATE sessions SET status = 'failed', worktree_preserved = 1, updated_at = ? WHERE id = ?`)
                            .run(Date.now(), s.id);
                    }
                    state.audit("recovery.replan_refused", {
                        sessionId: s.id, wasStatus: s.status, cyclesRan, spentUsd: Number(spent.toFixed(4)),
                        hasPr: Boolean(prUrl), branch: row.branch ?? null,
                        outcome: verdict.outcome,
                        reason: "would_replan_from_scratch",
                    }, s.id);
                    api.logger.warn("[harness] recovery: refusing to auto-resume -- this session already has a plan and finished cycles, so resuming would re-plan from scratch and re-spend the lead and scout", { sessionId: s.id, wasStatus: s.status, cyclesRan, spentUsd: spent, hasPr: Boolean(prUrl) });
                    if (s.slack_channel && s.slack_thread) {
                        await slack
                            .replyInThread(s.slack_channel, s.slack_thread, prUrl
                            ? `:warning: Harness restarted mid-run, after this session's PR was already open. It was NOT auto-resumed: that would re-plan from scratch and re-spend the lead and scout. Review ${prUrl} — CI on it may be unfinished.`
                            : `:warning: Harness restarted mid-run (cycle ${cyclesRan}). It was NOT auto-resumed: that would re-plan from scratch and re-spend the lead and scout ($${spent.toFixed(2)} already spent). The commits are preserved on branch \`${row.branch ?? "?"}\`.`)
                            .catch(() => undefined);
                    }
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
/** beta.36: extract a PR/MR number from a GitHub/GitLab PR URL. */
/**
 * beta.96: minimal reason-bearing terminal headline for the native Slack post
 * when `buildProgressSnapshot` yields an empty headline (a plan-phase death has
 * an empty sub-task ledger). Reads the canonical `loop.failed`/`loop.plan_failed`
 * {reason|err}. Guarantees a terminal transition ALWAYS announces itself (the
 * 1b267b86 zero-feedback class). Best-effort; never throws.
 */
function terminalFallbackHeadline(db, sessionId, status) {
    let reason = "";
    try {
        const fr = db
            .prepare(`SELECT payload FROM audit_log
           WHERE session_id = ? AND event IN ('loop.failed','loop.plan_failed')
           ORDER BY created_at DESC, id DESC LIMIT 1`)
            .get(sessionId);
        if (fr?.payload) {
            const p = JSON.parse(fr.payload);
            reason = (p.reason ?? p.err ?? "").toString().slice(0, 300);
        }
    }
    catch {
        /* best-effort: a missing/garbled reason must never re-silence the terminal */
    }
    const label = status === "done" ? "completed" : status;
    return reason ? `Run ${label} — ${reason}.` : `Run ${label}.`;
}
function parsePrNumber(prUrl) {
    const m = /\/pull\/(\d+)/.exec(prUrl) ?? /\/merge_requests\/(\d+)/.exec(prUrl);
    return m ? Number(m[1]) : undefined;
}
/**
 * beta.36: build the deps bundle for the post-merge deploy-repair state
 * machine. All I/O the machine needs (run a repair pipeline, verify a deploy,
 * revert merges, persist) is closed over the runtime's adapters here.
 */
function buildDeployRepairDeps(ctx) {
    const { config, state, git, pat, crystallise, loop, api, resolveGitToken, resolveVercelToken, requester } = ctx;
    const tokenFor = async (repoFullName) => {
        const resolution = pat.resolve({ slackUserId: requester, gitHubUser: repoFullName.split("/")[0], repoFullName });
        return resolveGitToken(resolution);
    };
    return {
        audit: (event, payload, sessionId) => state.audit(event, payload, sessionId),
        logger: api.logger,
        persist: (sessionId, patch) => {
            const cols = Object.keys(patch);
            if (cols.length === 0)
                return;
            const set = cols.map((c) => `${c} = ?`).join(", ");
            const vals = cols.map((c) => patch[c]);
            state.db.prepare(`UPDATE sessions SET ${set}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), sessionId);
        },
        verifyDeploy: async ({ repoFullName, sha }) => {
            void repoFullName;
            const vToken = await resolveVercelToken();
            if (!vToken || !config.vercel?.project_id) {
                return { status: "unavailable", detail: "no vercel token/project" };
            }
            const dv = await verifyDeploymentForSha({
                vercelToken: vToken,
                teamId: config.vercel.team_id,
                projectId: config.vercel.project_id,
                sha,
                waitSeconds: config.vercel.preview_wait_seconds,
                logger: api.logger,
            });
            return { status: dv.status, detail: dv.detail, deploymentUrl: dv.deploymentUrl, logsExcerpt: dv.logsExcerpt };
        },
        revertMerges: async ({ sessionId, repoFullName, shas }) => {
            const ghToken = await tokenFor(repoFullName);
            const r = await git.revertCommits(repoFullName, shas, ghToken, { baseBranch: config.repos.default_base_branch });
            if (r.pushedToMain) {
                return { ok: true, pushedToMain: true, detail: `reverted ${r.revertedShas.length} commit(s) straight to ${config.repos.default_base_branch}` };
            }
            // Branch-protected: open + auto-merge a revert PR.
            try {
                const resolution = pat.resolve({ slackUserId: requester, gitHubUser: repoFullName.split("/")[0], repoFullName });
                const pr = await createPullRequest({
                    repoFullName,
                    head: r.branch,
                    base: config.repos.default_base_branch,
                    apiBase: resolution.apiBase,
                    title: `harness: revert failed deploy-repair chain (session ${sessionId.slice(0, 8)})`,
                    body: `Automated revert of a deploy-repair chain that could not produce a healthy Vercel deployment. Reverts ${r.revertedShas.length} merge(s) to restore \`${config.repos.default_base_branch}\` to a working state.`,
                    ghToken,
                    draft: false,
                });
                await mergePullRequest({ repoFullName, prNumber: pr.number, ghToken, method: "merge" });
                await git.releaseByPath(r.worktreePath, repoFullName).catch(() => { });
                return { ok: true, pushedToMain: false, revertPrUrl: pr.htmlUrl, detail: `reverted via auto-merged revert PR ${pr.htmlUrl}` };
            }
            catch (err) {
                await git.releaseByPath(r.worktreePath, repoFullName).catch(() => { });
                throw new Error(`revert branch pushed but revert-PR merge failed: ${String(err)}`);
            }
        },
        runRepairAttempt: async ({ sessionId, repoFullName, attempt, deploy, budgetRemaining }) => {
            // Build a repair brief from the deploy error + logs.
            const logs = (deploy.logsExcerpt ?? deploy.detail ?? "").slice(0, 6000);
            const repairText = `The production Vercel deployment for the merge to \`${config.repos.default_base_branch}\` FAILED to build/deploy. ` +
                `Diagnose the cause from the build output below and fix it. This is deploy-repair attempt ${attempt}. ` +
                `Make the minimal change that makes the deployment succeed; do not change unrelated behaviour.\n\n` +
                `Vercel deploy error: ${deploy.detail}\n\nBuild log excerpt:\n${logs}`;
            let brief;
            try {
                const c = await crystallise(repairText);
                if (c.kind !== "brief") {
                    return { shipped: false, costUsd: 0, reason: `crystallise did not yield a brief (${c.kind})` };
                }
                brief = { ...c.brief, repoHint: repoFullName };
            }
            catch (err) {
                return { shipped: false, costUsd: 0, reason: `crystallise threw: ${String(err)}` };
            }
            // Create a distinct repair session sharing the parent's requester,
            // budgeted by the remaining repair pool.
            const repairSessionId = globalThis.crypto?.randomUUID?.() ?? `repair-${Date.now()}`;
            state.db
                .prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran, parent_session_id)
           VALUES (?, ?, '', ?, ?, '', '', '', 'planning', ?, ?, ?, ?, 0, 0, ?)`)
                .run(repairSessionId, `agent:${repairSessionId}`, requester, requester, JSON.stringify(brief), Date.now(), Date.now(), budgetRemaining, sessionId);
            state.audit("deploy.repair_session_started", { sessionId, repairSessionId, attempt }, sessionId);
            let outcome;
            try {
                outcome = await loop.run(repairSessionId, brief);
            }
            catch (err) {
                return { shipped: false, costUsd: 0, reason: `repair loop threw: ${String(err)}` };
            }
            if (outcome.status !== "shipped") {
                // Read whatever PR (if any) the repair session opened for the handoff.
                const rr = state.db.prepare(`SELECT final_pr_url FROM sessions WHERE id = ?`).get(repairSessionId);
                return { shipped: false, costUsd: outcome.totalCostUsd, reason: `repair pipeline ${outcome.status}: ${"reason" in outcome ? outcome.reason : ""}`, prUrl: rr?.final_pr_url ?? undefined };
            }
            // Merge the repair PR.
            const prNumber = parsePrNumber(outcome.prUrl);
            if (!prNumber)
                return { shipped: false, costUsd: outcome.totalCostUsd, reason: `could not parse PR number from ${outcome.prUrl}`, prUrl: outcome.prUrl };
            try {
                const ghToken = await tokenFor(repoFullName);
                const merged = await mergePullRequest({ repoFullName, prNumber, ghToken, method: "squash" });
                state.db.prepare(`UPDATE sessions SET pr_merged = 1, pr_merged_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), repairSessionId);
                return { shipped: true, prUrl: outcome.prUrl, prNumber, mergeSha: merged.sha, costUsd: outcome.totalCostUsd };
            }
            catch (err) {
                return { shipped: false, costUsd: outcome.totalCostUsd, reason: `repair PR merge failed: ${String(err)}`, prUrl: outcome.prUrl, prNumber };
            }
        },
    };
}
// beta.75 (#1): compact review comment posted on the PR after EVERY review.
// Distinct from renderPrBody (the one-time PR description): this is a timeline
// comment carrying THIS review's verdict + findings, so a re-push to an
// existing PR surfaces the current outcome (e.g. a `revise`/`block` verdict or
// a specific out-of-scope finding) instead of it living only in the harness DB.
function renderReviewComment(review, opts = { updatedExisting: false }) {
    const verdict = String(review.verdict ?? "").toLowerCase();
    const emoji = verdict === "pass" ? "\u2705" : verdict === "block" ? "\u26d4" : "\u{1f501}";
    const gate = verdict === "pass"
        ? "No blocking findings from this review. The `harness_merge_pr` gate still applies."
        : "This review did NOT sign off (`" + verdict + "`). Address the findings below; `harness_merge_pr` will refuse a non-pass verdict.";
    const findings = review.findings ?? [];
    // The operator's steer for this revise, above the verdict it was reviewed
    // against. A revise updates an existing PR and createPullRequest only writes a
    // body on first open (beta.75), so the PR body -- which does render guidance,
    // via acceptanceCriteria -- is never rewritten for the case guidance exists
    // for. Without this the steer would be invisible on the only PR it applies to.
    const guidanceLines = opts.operatorGuidance ? guidanceCommentSection(opts.operatorGuidance) : [];
    const lines = [
        `## ${emoji} Harness adversarial review \u2014 verdict: \`${review.verdict}\`${opts.updatedExisting ? " (updated PR)" : ""}`,
        ``,
        gate,
        ``,
        ...guidanceLines,
        review.summary ? review.summary : "",
        ``,
        findings.length ? `### Findings (${findings.length})` : "_No findings._",
        ...findings.map((f) => `- **${String(f.severity ?? "info").toUpperCase()}** [${f.dimension ?? "?"}] ${f.title ?? ""}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}${f.detail ? `\n  ${f.detail}` : ""}`),
        ``,
        `---`,
        `_Posted by openclaw-agent-harness${typeof review.costUsd === "number" ? ` \u2014 review cost $${review.costUsd.toFixed(2)}` : ""}. This comment is auto-generated on every review._`,
    ];
    return lines.filter((l) => l !== "" || true).join("\n");
}
function renderPrBody(brief, review) {
    // beta.35 fix #3: when the run ships WITHOUT a clean adversary pass
    // (verdict !== 'pass'), the reviewer's outstanding findings -- typically
    // "no runtime evidence" ones the loop structurally cannot satisfy (no
    // in-loop preview deploy) -- become an explicit, honest PR annotation
    // instead of silently killing the run. The runtime-dimension findings in
    // particular are exactly what the post-merge Vercel deploy verification
    // (harness_merge_pr) checks for real, so we call that out: the loop
    // couldn't render it, but the merge step will verify the actual deploy.
    const shippedWithoutCleanPass = review.verdict !== "pass";
    const runtimeFindings = (review.findings ?? []).filter((f) => f?.dimension === "runtime" ||
        /runtime|preview|deploy|render/i.test(String(f?.title ?? "") + " " + String(f?.detail ?? "")));
    // rc.3: a `pass` the gate manufactured from a `revise` is not the same thing
    // as a `pass` the adversary gave, and it lands on the PR looking identical.
    // Say so, because this one is auto-mergeable.
    const downgradedAnnotation = review.verdictDowngraded
        ? [
            ``,
            `## \u26a0\ufe0f This \`pass\` was downgraded from \`revise\``,
            `The adversary returned \`revise\`. The harness downgraded it to \`pass\` because no NEW finding was ` +
                `both diff-addressable and at least medium severity -- the remaining findings were judged to be about ` +
                `process, environment, architecture or unproven runtime rather than this diff. That judgement is made ` +
                `by keyword matching on the finding text, so read the findings below before merging rather than ` +
                `treating this as a clean review.`,
        ]
        : [];
    const reviseAnnotation = shippedWithoutCleanPass
        ? [
            ``,
            `## ⚠\ufe0f Shipped without a clean adversary pass (verdict: ${review.verdict})`,
            `The adversary did not sign off with \`pass\`. The outstanding findings below were judged non-blocking for merge purposes, ` +
                `but they are NOT resolved in-loop and must be verified before/at merge.`,
            runtimeFindings.length
                ? `\n**Runtime not verified in-loop (${runtimeFindings.length} finding${runtimeFindings.length === 1 ? "" : "s"}):** the harness has no in-loop preview-deploy pipeline, so it could not render/exercise this change. ` +
                    `The post-merge Vercel deploy verification (\`harness_merge_pr\`) will verify the real deployment for the merge commit (READY/ERROR + build logs).`
                : ``,
            ...runtimeFindings.map((f) => `- **${(f.severity ?? "info").toUpperCase()}** [${f.dimension}] ${f.title}`),
        ]
        : [];
    return [
        `## Motivation`,
        brief.motivation,
        ``,
        `## Acceptance criteria`,
        ...brief.acceptanceCriteria.map((c) => `- [ ] ${c}`),
        ...downgradedAnnotation,
        ...reviseAnnotation,
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
    // beta.41: DO NOT tear down the runtime (esp. `state.close()`) while a loop
    // from THIS runtime is still executing. A plugin RE-REGISTER (the recurring
    // OKF / gateway auto-discovery churn on Staging: `plugins.allow` empty ->
    // gateway re-runs discovery -> register() called on every plugin) schedules
    // a fire-and-forget teardown of the previous runtime. If that teardown closes
    // the DB out from under an in-flight `loop.run()` (which holds
    // `runtime.state.db`), the loop's next prepare() throws "database is not
    // open" -> `loop crashed`. This killed the beta.39 AND beta.40 ProjectThanos
    // smokes at exactly this point. So: drain running loops first, bounded by
    // `loop.teardown_drain_seconds`. The re-entrancy guard (beta.38) already
    // prevents the NEW runtime from double-driving the same session, so the old
    // loop keeps ownership until it finishes; we just hold its DB open for it.
    const drainSeconds = runtime.config?.loop?.teardown_drain_seconds ?? 3600;
    const drainDeadline = Date.now() + drainSeconds * 1000;
    const stuckThresholdMs = (runtime.config?.loop?.stuck_loop_seconds ?? 2700) * 1000;
    // beta.57 (P1): drain only on sessions THIS runtime's loop instance owns.
    // `runningSessionIds()` is the module-scoped registry shared across runtimes
    // (it deliberately survives a re-register), so draining on it made the
    // doomed runtime wait for the NEW runtime's loops too -- up to
    // teardown_drain_seconds for work whose DB handle it isn't even holding.
    const ownedRunning = () => typeof runtime.loop?.ownedRunningSessionIds === "function"
        ? runtime.loop.ownedRunningSessionIds()
        : runningSessionIds();
    // beta.82: read the freshest progress marker across the owned running
    // sessions so we can tell a LIVE-but-long loop from a WEDGED one. Best-effort
    // -- if the DB is already closed or the query throws, treat progress as
    // unknown (0), which errs toward the wedged classification (safe: a truly
    // live loop keeps advancing `updated_at`, so it will read fresh).
    const sampleProgress = () => {
        const running = ownedRunning();
        if (running.length === 0 || !runtime.state.isOpen())
            return { running, lastProgressMs: 0 };
        let lastProgressMs = 0;
        try {
            const placeholders = running.map(() => "?").join(",");
            const rows = runtime.state.db
                .prepare(`SELECT last_checkpoint_at, updated_at FROM sessions WHERE id IN (${placeholders})`)
                .all(...running);
            for (const r of rows) {
                lastProgressMs = Math.max(lastProgressMs, r.last_checkpoint_at ?? 0, r.updated_at ?? 0);
            }
        }
        catch {
            /* DB closed/racy: unknown progress */
        }
        return { running, lastProgressMs };
    };
    // beta.82: progress-aware drain. A HARD deadline used to guillotine the DB
    // out from under a still-live loop at exactly teardown_drain_seconds (this
    // orphaned b54/b60/b80/b81 feature runs). Now, past the deadline we ONLY
    // force-teardown if the owned loop has gone stale (wedged); a loop that is
    // still making progress keeps its DB held indefinitely.
    let waited = false;
    let prevProgressMs = 0;
    let forcedWedged = false;
    for (;;) {
        const sample = sampleProgress();
        const action = decideDrainAction({
            nowMs: Date.now(),
            deadlineMs: drainDeadline,
            sample,
            prevProgressMs,
            stuckThresholdMs,
        });
        if (action.kind === "drain-complete")
            break;
        if (action.kind === "force-teardown") {
            forcedWedged = true;
            api.logger.warn("[harness] teardown drain deadline exceeded AND owned loop(s) wedged (no progress past stuck_loop_seconds); proceeding with teardown", { running: sample.running, drainSeconds, stuckThresholdMs, lastProgressMs: sample.lastProgressMs });
            // Observability: a wedged loop is about to have its DB closed out from
            // under it; emit a clean terminal audit per session so it does not just
            // hang in `executing` with no terminal event. Best-effort (DB may race).
            for (const sid of sample.running) {
                try {
                    runtime.state.audit("loop.torn_down_while_running", {
                        sessionId: sid,
                        reason: "runtime torn down (re-register churn) while loop was wedged past stuck_loop_seconds",
                        drainSeconds,
                        stuckThresholdMs,
                    }, sid);
                }
                catch {
                    /* audit best-effort */
                }
            }
            break;
        }
        if (!waited) {
            api.logger.info("[harness] teardown deferred: waiting for running loop(s) to drain before closing runtime", {
                running: sample.running,
                drainSeconds,
            });
            waited = true;
        }
        else if (action.reason === "loop-still-progressing") {
            // Past the deadline but the loop is alive and advancing -- hold the DB
            // open for it rather than orphaning a good run. Log sparingly.
            api.logger.info("[harness] teardown drain past deadline but owned loop still progressing; continuing to hold DB open", {
                running: sample.running,
                lastProgressMs: sample.lastProgressMs,
            });
        }
        prevProgressMs = Math.max(prevProgressMs, sample.lastProgressMs);
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (!forcedWedged && waited) {
        api.logger.info("[harness] teardown drain complete; running loop(s) finished, proceeding to close runtime");
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