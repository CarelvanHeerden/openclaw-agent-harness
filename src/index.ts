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

import { createHash } from "node:crypto";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { HarnessConfig, TokenPointer } from "./config.js";
import { parseHarnessConfig, assessBudgetCoherence, declaresRemovedListenerFlag, declaresRemovedParallelKeys } from "./config.js";
import { openStateStore, openStateStoreSync } from "./state/store.js";
import { decideDrainAction, type DrainProgressSample } from "./state/teardown-drain.js";
import { decideRecoveryResume } from "./state/recovery-guard.js";
import { InteractionLog, resolveInteractionLogConfig } from "./state/interaction-log.js";
import { OrchestratorLoop, runningSessionIds } from "./orchestrator/loop.js";
import { resolveContractPath } from "./orchestrator/path-match.js";
import { createVerifyProbes } from "./orchestrator/verify-probes.js";
import { blocksMerge, classifyFinding, isAtLeastMedium, normaliseSeverity } from "./orchestrator/finding-classify.js";
import { prLabelsFor } from "./orchestrator/pr-labels.js";
import type { DatabaseSync } from "node:sqlite";
import { SlackChannelListener, type SlackMessageEvent } from "./slack/channel-listener.js";
import { Dispatcher } from "./slack/dispatcher.js";
import { PrMergedWatcher } from "./adapters/github-watcher.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { RouteOverlay } from "./auth/route-overlay.js";
import { pruneRetention } from "./state/retention.js";
import { registerHarnessTools } from "./tools/registration.js";
import { ControlPlaneService } from "./control/service.js";
import { ControlRepository } from "./control/repository.js";
import { AutonomousControlEngine } from "./control/engine.js";
import { InternalMergeService } from "./control/merge.js";
import {
  parseOkfBlocksFromContext,
  OkfConceptCache,
  decideAutoForward,
  buildRewrittenParams,
  cacheKeyForCtx,
} from "./hooks/okf-auto-forward.js";
import { setCurrentRuntime } from "./runtime-registry.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { CredentialVault, VAULT_KEY_ENV, type CredentialRecord } from "./adapters/credential-vault.js";
import { buildBackendRouter, type BackendRouter, type EffectiveBackendRoute } from "./adapters/backend-router.js";
import { runWorkerAcp } from "./adapters/acp.js";
import { buildAcpGuard } from "./safety/bash-guard.js";
import { focusedWorkerAcpGuard } from "./safety/focused-worker-acp-guard.js";
import { ROLE_NAMES, type RoleName } from "./adapters/backend.js";
import { catalogueStore } from "./state/price-cache.js";
import { memoiseSuccess } from "./adapters/shared/once.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import {
  buildScoutSystemPrompt,
  buildScoutUserMessage,
  SCOUT_ALLOWED_TOOLS,
  SCOUT_DENIED_TOOLS,
  SCOUT_MAX_TURNS,
} from "./orchestrator/lead-scout.js";
import { createPullRequest, getPullRequest, getCombinedStatus, getCiSnapshot, getFailingCheckLogs, getMergeBase, getTokenScopes, listPullRequestCommits, mergePullRequest, postPrComment } from "./adapters/github.js";
import { linkPullRequest } from "./orchestrator/pr-link.js";
import { canPushWorkflows } from "./orchestrator/workflow-scope.js";
import { authorCiWorkflow } from "./adapters/ci-workflow.js";
import { SlackAdapter } from "./adapters/slack.js";
import {
  estimateSubTaskCost,
  extractJson,
  runAdversarySdk,
  runClassifierSdk,
  runCrystalliserSdk,
  runLeadSdk,
  runLeadScoutSdk,
  runLeadWorkerContextSdk,
  runLeadReviseSpecSdk,
  runWorkerSdk,
  fetchLiveModelIds,
  assessModelPricingHealth,
  registerDeniedSdkEnvVar,
} from "./adapters/claude-code.js";
import { verifyDeploymentForSha } from "./vercel/logs.js";
import { crystallisePrompt, groundingFrom, type CrystallisedBrief } from "./crystallise/prompt-refiner.js";
import { runLeadPlanner } from "./orchestrator/lead.js";
import { runWorker as runWorkerCore, buildWorkerSystemPrompt } from "./orchestrator/worker.js";
import { runAdversary as runAdversaryCore, type ReviewFinding } from "./orchestrator/adversary.js";
import { discoverCheckScripts, ingestRepoConventions } from "./orchestrator/repo-conventions.js";
import { resolveGenerators } from "./orchestrator/generated-artifacts.js";
import { foldGeneratedFiles } from "./adapters/shared/diff.js";
import { diagnoseCheckEnv, runTypecheckDirect } from "./orchestrator/typecheck-fallback.js";
import { buildBashGuard } from "./safety/bash-guard.js";
import { scanPatchForSecrets } from "./safety/path-policy.js";
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION } from "./version.js";
import { assertDowngradeSafe } from "./state/runtime-compat.js";

/** Minimal shape of the OpenClaw plugin API surface that we use. */
export interface HarnessToolContext {
  /** Authenticated identities supplied by OpenClaw, never tool arguments. */
  requesterSenderId?: string;
  conversationId?: string;
  workspaceId?: string;
  hostEventId?: string;
  receivedAt?: number;
  trustedControlAttestation?: import("./control/service.js").TrustedControlContext["trustedControlAttestation"];
  senderIsOwner?: boolean;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
}

export interface HarnessToolDefinition {
  name: string;
  description: string;
  parameters?: unknown;
  inputSchema?: unknown;
  execute: (callIdOrInput: unknown, paramsOrCtx?: unknown, context?: unknown) => Promise<unknown> | unknown;
}

export interface HarnessPluginApi {
  /** Durable installed plugin root supplied by OpenClaw. */
  rootDir?: string;
  registrationMode?: "cli-metadata" | "runtime";
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
    debug?: (msg: string, meta?: unknown) => void;
  };
  registerTool: (
    definition: HarnessToolDefinition | ((context: HarnessToolContext) => HarnessToolDefinition),
    options?: unknown,
  ) => (() => void) | { dispose?: () => void; unregister?: () => void };
  /**
   * Subscribe to a lifecycle event on the OpenClaw event bus. Same shape as
   * a Node EventEmitter; hybrid-memory uses this for `message_received`,
   * `agent_end`, etc. Returns an unsubscribe function.
   */
  on?: (event: string, handler: (payload: unknown) => unknown) => (() => void) | undefined;
  /**
   * Register a named hook on the OpenClaw plugin registry.
   *
   * SDK signature (verified against openclaw-hybrid-memory's copy of the
   * openclaw runtime, `registry-*.js`):
   *
   *     registerHook(events: string | string[], handler, opts: { name, description? })
   *
   * `opts.name` is required -- the registry throws
   * `hook registration missing name` otherwise. This is a different beast
   * from `api.on(event, handler)`, which is a simple event-bus subscribe.
   *
   * We type both positional shapes because older mocks still use the
   * 2-arg form; the runtime call site always passes opts.
   */
  registerHook?: (
    events: string | string[],
    handler: (event: unknown) => unknown,
    opts?: { name: string; description?: string },
  ) => (() => void) | { dispose?: () => void };
  /** Host-dispatched commands bypass the model/tool path. */
  registerCommand?: (command: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    channels?: string[];
    handler: (context: {
      senderId?: string; channel?: string; isAuthorizedSender?: boolean;
      args?: string; commandBody?: string;
    }) => Promise<{ text: string }> | { text: string };
  }) => unknown;
  registerService?: (svc: {
    id: string;
    start?: () => Promise<void> | void;
    stop?: () => Promise<void> | void;
  }) => (() => void) | { dispose?: () => void };
  /** Deprecated: retained for backwards-compat with older mock APIs. Prefer `pluginConfig`. */
  getConfig?: () => unknown;
  /** OpenClaw plugin-SDK config surface (JSON parsed from `plugins.entries[<id>].config`). */
  pluginConfig?: unknown;
  workspaceDir?: string;

  /** Optional -- for sending Slack messages. Different runtimes wire this differently. */
  sendMessage?: (input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }) => Promise<{ ts: string }>;
  addReaction?: (input: { channel: string; ts: string; name: string }) => Promise<void>;

  /**
   * Optional -- lookup for calling another plugin's tool. beta.110: NO LONGER
   * used for credentials; the harness owns its vault. Retained for other
   * cross-plugin calls and for runtimes that still provide it.
   */
  callTool?: (name: string, input: unknown) => Promise<unknown>;
}

/**
 * beta.110: the vault surface the runtime depends on. Narrower than
 * `CredentialVault` so the sealed stub below (and tests) can stand in.
 */
export interface CredentialStore {
  get: (service: string, type?: "token" | "api_key") => string | undefined;
  set: (service: string, value: string, opts?: { type?: string; notes?: string }) => void;
  delete: (service: string) => boolean;
  list: () => CredentialRecord[];
}

/**
 * beta.110: stand-in for a vault that would not open. Every operation reports
 * the ORIGINAL failure, so an operator sees "the key does not match" rather
 * than a procession of "credential not found" errors sending them to look for
 * a missing entry that is in fact right there, sealed.
 */
function sealedVault(reason: string): CredentialStore {
  const fail = (): never => { throw new Error(`credential vault unavailable: ${reason}`); };
  return { get: fail, set: fail, delete: fail, list: fail };
}

export interface HarnessRuntime {
  config: HarnessConfig;
  /** One canonical description of the route each model role actually uses. */
  effectiveBackendRoutes: EffectiveBackendRoute[];
  ensureBackendReady: () => Promise<void>;
  state: Awaited<ReturnType<typeof openStateStore>>;
  budget: BudgetEnforcer;
  pat: PatRouter;
  loop: OrchestratorLoop;
  /**
   * beta.63 (Part B): durable, structured interaction log written OUTSIDE the
   * worktree. Threaded into the loop + SDK adapters so every LLM call, state
   * transition, verify probe, and stall/recovery event lands in a JSONL trail
   * that survives worktree release + container restart. Read via harness_logs.
   */
  interactionLog: InteractionLog;
  listener: SlackChannelListener;
  dispatcher: Dispatcher;
  slack: SlackAdapter;
  git: GitAdapter;
  creds: CredentialAdapter;
  /** beta.110: the harness-owned vault. Used by `harness_onboard` to STORE tokens. */
  vault: CredentialStore;
  /** beta.110: set when the vault could not be opened; surfaced by `harness_health`. */
  vaultError?: string;
  /**
   * Classify + crystallise a raw request into a structured brief. Shared by
   * the optional Slack dispatcher and the agent-callable `harness_run` tool.
   * Returns a discriminated union: a `brief` ready to run, a `clarify`
   * question to put back to the requester, or a `reject` with reason.
   */
  crystallise: (
    userText: string,
    /**
     * beta.21: optional OKF concept refs pre-attached by the caller
     * (typically the OpenClaw agent's context enrichment). Pass-through
     * only; the harness does not crawl OKF itself. Concepts propagate
     * into the crystallised brief so the lead planner and workers see
     * them downstream.
     */
    concepts?: import("./crystallise/prompt-refiner.js").OkfConceptRef[],
  ) => Promise<
    | { kind: "brief"; brief: CrystallisedBrief; costUsd: number }
    /**
     * rc.2: `reason` is the machine-readable WHY, so a pause is auditable
     * without parsing the question text.
     */
    | {
        kind: "clarify";
        question: string;
        reason: import("./crystallise/clarification-guard.js").ClarificationReason;
        costUsd: number;
      }
    | { kind: "reject"; intent: "not_dev" | "unsafe"; reason: string; costUsd: number }
  >;
  /**
   * Resolve the Anthropic API key for the embedded Claude Agent SDK.
   * Vault-first (`models.auth.credential_service`), then env fallback
   * (`models.auth.api_key_env`, default ANTHROPIC_API_KEY). Memoised.
   * Returns `undefined` if neither is configured/resolvable, in which case
   * the SDK keeps its default behaviour (may fall back to `/login`).
   */
  anthropicApiKey: () => Promise<string | undefined>;
  /**
   * Resolve a GitHub token for a given vault service name (vault-first, then
   * env fallback via `pat_routing.auth.api_key_env`, default GH_TOKEN).
   * Used by session start/push and by the health check.
   */
  githubToken: (service: string) => Promise<string>;
  /** Provider-aware token resolver: vault-first, then per-provider env fallback. */
  gitToken: (r: { credentialService: string; apiKeyEnv: string; provider: string; tokenPointer?: TokenPointer; person?: string }) => Promise<string>;
  /**
   * beta.25: preflight completeness check. Given a requester + concrete
   * repo, verify EVERYTHING the harness will need to commit + push on that
   * requester's behalf is present up front: routing entry, commit identity
   * (name + email), and a resolvable token. Returns { ok:true } or
   * { ok:false, missing:[...], message } describing exactly what to ask the
   * user for BEFORE a run starts. Never throws.
   */
  preflight: (args: { requester: string; repoFullName: string }) => Promise<PreflightResult>;
  /**
   * beta.34: hard-gated PR merge + post-merge Vercel deploy verification.
   * Enforces the merge recommendation: if the session's recommendation is
   * `do_not_merge`, it REFUSES (no override; the escape hatch is the GitHub
   * UI). Otherwise re-checks CI, merges (squash), records the merge, and
   * verifies the Vercel deployment for the merge commit. Never force-merges.
   */
  mergePr: (args: { sessionId: string; authenticatedActor?: string; repairBudgetUsd?: number }) => Promise<MergePrResult>;
  /** Ordinary-user control plane. Authority is accepted only through trusted host context. */
  controlPlane?: ControlPlaneService;
  /**
   * rc.4: associate an EXISTING pull request with the session that produced it,
   * after a failure lost the association.
   *
   * `pr_number` is written on the ship path only, so a session that pushed its
   * work, opened a PR and then failed holds neither -- and `a new confirmed change`
   * refuses a row with no PR. The only route back was to rebuild the feature.
   *
   * Two-phase by construction. The default is a read-only dry run that reports
   * the proposed association and its evidence; applying requires `apply: true`
   * plus the `expectedHeadSha` the dry run reported, and re-reads the PR so a
   * head that moved in between refuses instead of linking stale evidence.
   *
   * Linking is an association and nothing more. It does not start a run, push,
   * create or merge anything, and it leaves status, findings, spend and the
   * merge recommendation exactly as the failure left them.
   */
  linkPr: (args: {
    sessionId: string;
    /** `owner/name`. Required: a PR number alone is ambiguous across repositories. */
    repo: string;
    prNumber: number;
    invokedBy: string;
    /** Default false -- a read-only dry run. */
    apply?: boolean;
    /** Required when `apply` is true; must equal the PR head the dry run saw. */
    expectedHeadSha?: string;
  }) => Promise<LinkPrResult>;
  /**
   * Resolve the credential service name the pat-router would use for a repo
   * (or the first allowed repo when omitted). For health/introspection.
   */
  githubServiceFor: (repoFullName?: string) => string | undefined;
  /** Provider-aware resolution (service + provider + apiBase + apiKeyEnv) for health/introspection. */
  /**
   * Routes written by `harness_onboard`. The same instance the router reads,
   * so a route the tool writes is live for the next session without a restart.
   */
  routeOverlay?: RouteOverlay;
  gitResolutionFor: (repoFullName?: string, slackUserId?: string) => {
    credentialService: string;
    provider: string;
    apiBase: string;
    apiKeyEnv: string;
    /**
     * Where the token actually comes from when routing resolved through a
     * hierarchy or overlay entry, and the vault name it points at.
     *
     * `credentialService` is SYNTHETIC on those paths -- the router builds it
     * for logging and never looks a token up by it. Onboarding compares the
     * name it is about to write against what sessions read, so handing it the
     * synthetic name makes the check compare against a string nothing uses:
     * it refuses valid setups, and aligning the patterns to satisfy it stores
     * the token under a name that still is not read.
     */
    tokenSource?: "vault" | "env" | "value";
    vaultPointer?: string;
  } | undefined;
  disposers: Array<() => void | Promise<void>>;
  /**
   * Promise for the async bootstrap phase (reactions poller start,
   * session recovery). Populated by `register()` once it has kicked off
   * `bootstrapHarnessAsync`. Teardown awaits this to ensure recovery
   * notifications have flushed before closing the state DB.
   */
  asyncBootstrap?: Promise<void>;
  /**
   * beta.77: harness-native OUTBOUND progress/terminal poster. Built during
   * async bootstrap ONLY when `slack.credential_service` resolves a bot token
   * (same token as the reactions poller). Null until then (and forever if no
   * credential_service) -- `deliverProgress` reads this slot lazily and falls
   * back to the poll model when it's null. Direct `chat.postMessage`, bypassing
   * the wedge-prone agent `api.sendMessage` turn.
   */
  /**
   * beta.86 (Staging review nit): last progress headline posted per session, so
   * `deliverProgress` skips an IDENTICAL consecutive post. beta.85 #4 fires
   * deliverProgress per `loop.worker_end_turn`; two back-to-back sub-tasks whose
   * snapshot headline is byte-identical (e.g. same "Executing sub-task N/M"
   * before the ledger updates) would otherwise double-post. Correctness-neutral,
   * a UX de-dup only.
   */
}

export interface PreflightResult {
  ok: boolean;
  /** Machine-readable list of what's missing: 'token' | 'email' | 'name' | 'routing' | 'slack_user_id'. */
  missing: string[];
  /** Human-facing, actionable message to relay to the requester. Empty when ok. */
  message: string;
  /** Provenance of the routing decision, for logging. */
  provenance?: string;
}

/** beta.34: result of a harness_merge_pr invocation. */
export interface MergePrResult {
  ok: boolean;
  /** True when the hard gate refused the merge (recommendation = do_not_merge / needs_human_review). */
  refused?: boolean;
  merged?: boolean;
  mergeSha?: string;
  recommendation?: "merge" | "do_not_merge" | "needs_human_review";
  /** Deploy verification outcome (when Vercel enabled + a merge happened). */
  deploy?: { status: "ready" | "error" | "pending" | "unavailable"; detail: string; deploymentUrl?: string; logsExcerpt?: string };
  /** Human-facing message summarising the outcome. */
  message: string;
}

/** rc.4: result of a harness_link_pr invocation (dry run or apply). */
export interface LinkPrResult {
  ok: boolean;
  /** True when this was a read-only dry run. No row was written. */
  dryRun: boolean;
  /** True when the association was written by THIS call. */
  applied?: boolean;
  /** True when the identical association already existed; nothing was written. */
  alreadyLinked?: boolean;
  /** True when the caller is not authorised. Distinct from a verification failure. */
  unauthorised?: boolean;
  sessionId?: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  /** PR head sha the verification ran against. Echo it back to apply. */
  headSha?: string;
  /** Human-readable lines describing what was checked. */
  evidence?: string[];
  /** Why the link was refused. Empty iff ok. */
  blockers?: { kind: string; message: string }[];
  /** Human-facing message summarising the outcome. */
  message: string;
}

let currentRuntime: HarnessRuntime | null = null;

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
export function bootstrapHarnessSync(api: HarnessPluginApi): HarnessRuntime {
  // OpenClaw plugin SDK provides config via `api.pluginConfig`.
  // We fall back to `api.getConfig()` for backwards-compat with older mock harnesses.
  const rawConfig = (api.pluginConfig ?? api.getConfig?.() ?? {}) as unknown;
  const config = parseHarnessConfig(rawConfig);

  // Crystalliser closure. Shared by the (optional) Slack dispatcher AND the
  // agent-callable `harness_run` tool, so the agent-orchestrated path uses
  // exactly the same classify -> refine pipeline as the autonomous listener.
  const crystallise: HarnessRuntime["crystallise"] = async (userText, concepts) => {
    const result = await crystallisePrompt(
      userText,
      {
        config,
        logger: api.logger,
        // rc.2: durable trail for clarification decisions, including withheld
        // ones. `harness_run` clarifies before a session exists, so there is no
        // session id to hang these off -- they are global audit rows.
        audit: (event, payload) => state.audit(event, payload),
        callClassifier: async () => runClassifierSdk({
          execute: executorFor("classifier"),
          model: config.models.classifier,
          userText,
          timeoutSeconds: 60,
          apiKey: await apiKeyForRole("classifier"),
          // rc.2: the allow-list and the checkout policy, so the classifier
          // stops treating a resolvable repository name and a harness-owned
          // branch decision as missing information.
          grounding: groundingFrom(config),
        }),
        // beta.21: forward pre-attached concepts (if any) into the SDK-side
        // crystalliser prompt. Undefined/empty is identical to pre-beta.21
        // behaviour.
        callCrystalliser: async (_userText, _cls, ctxConcepts) => runCrystalliserSdk({
          execute: executorFor("crystalliser"),
          model: config.models.lead,
          userText,
          timeoutSeconds: 120,
          apiKey: await apiKeyForRole("crystalliser"),
          concepts: ctxConcepts,
          // beta.80: repo-only invariant + bimodality self-report prompt gates.
          repoOnlyInvariant: config.brief.repo_only_invariant,
          bimodalClarify: config.brief.bimodal_clarify,
          grounding: groundingFrom(config),
        }),
      },
      concepts,
    );
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
      ? { kind: "brief" as const, brief: result.brief, costUsd }
      : result.kind === "clarify"
        ? { kind: "clarify" as const, question: result.question, reason: result.reason, costUsd }
        : { kind: "reject" as const, intent: result.intent as "not_dev" | "unsafe", reason: result.reason ?? "", costUsd };
  };

  const dbPath = config.storage.state_db_path.replace(/^~/, process.env.HOME ?? "");
  mkdirSync(dirname(dbPath), { recursive: true });
  const state = openStateStoreSync(dbPath);
  assertDowngradeSafe(state.db, PLUGIN_VERSION.pluginVersion);

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

  let vaultOpenError: string | undefined;
  let vault: CredentialStore;
  try {
    vault = CredentialVault.open({
      dir: vaultDir,
      keyEnvVar: credCfg.key_env,
      keyFile: credCfg.key_file,
      logger: api.logger,
      // Records the SERVICE NAME and never the value, so a read is traceable
      // without the audit log becoming a second copy of the secret store.
      audit: (event, payload) => { try { state.audit(event, payload, ""); } catch { /* audit must never break a read */ } },
    });
    api.logger.info("[harness] credential vault opened", { dir: vaultDir, keySource: (vault as CredentialVault).keySource });
  } catch (err) {
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
  /**
   * The v1 `models.*` value for a role: what it runs on when no v2 backend
   * entry names a model. Declared here rather than beside its other use so the
   * startup route log can fill the same blanks the runtime route table does.
   */
  const legacyModelForRole = (role: RoleName): string => {
    if (role === "worker") return config.models.worker;
    if (role === "adversary") return config.models.adversary;
    if (role === "classifier") return config.models.classifier;
    return config.models.lead;
  };
  let backendRouter: BackendRouter | undefined;
  let backendRouterError: string | undefined;
  try {
    backendRouter = buildBackendRouter({
      backends: config.backends,
      providers: config.providers,
      // Synchronous by necessity: `register()` cannot await. The vault's own
      // read is sync; only `CredentialAdapter` adds a promise.
      resolveKey: (service) => {
        // `api_key` first, then `token`. `vault.mjs set` stores `token` unless
        // told otherwise, so looking up only `api_key` meant the documented way
        // to seed a provider key produced an entry the router could not see --
        // and the symptom, "provider dropped: no credential in the vault", is
        // the one message that actively argues the operator did not store it.
        // Reading both is safe: the two namespaces are per-service, so this can
        // only find a key the operator put there under this exact name.
        try {
          const v = vault as CredentialStore;
          return v.get(service, "api_key") ?? v.get(service, "token");
        } catch { return undefined; }
      },
      scratchDir: dataDir,
      pluginRoot: api.rootDir,
      // The same overrides the v1 paths use. Omitting them here made
      // `models.price_overrides` a no-op on OpenCode -- see `priceOverrides`.
      priceOverrides: config.models.price_overrides,
      logger: api.logger,
      audit: (event, payload) => { try { state.audit(event, payload, ""); } catch { /* audit must never break boot */ } },
    });
    if (backendRouter) {
      // rc.2: with the legacy fallback, so a role still on Claude logs the
      // model it will actually use instead of `model: undefined`. The startup
      // route table is the first thing an operator reads to answer "what is
      // running my work", and half of it was blank.
      const routes = backendRouter.describe(legacyModelForRole);
      api.logger.info("[harness] per-role backends configured", { roles: routes });
      state.audit("backend.routes", { roles: routes }, "");
    }
  } catch (err) {
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
  //
  // `memoiseSuccess`, NOT a `??=` promise memo. A memoised promise caches the
  // settled value, and a rejection is a settled value -- so the first failure
  // would be cached forever and every later session would await the same dead
  // promise. `preflight()` sets its own flag only on success and is perfectly
  // willing to retry; nothing would ever ask it to. One transient hiccup and
  // every OpenCode role stays down until the gateway restarts, which on most
  // hosts means a human. Failing closed is right; failing closed with no route
  // back is not.
  const backendProbe = memoiseSuccess(async () => {
    // Cache-then-refresh: a same-day cache satisfies this without a fetch, and
    // a failed fetch keeps whatever cache was already good. Awaited only once,
    // and never fatal -- unpriced turns are a reporting problem.
    await backendRouter!.refreshPricing(catalogueStore(state.db));
    await backendRouter!.preflight();
  });

  const ensureBackendReady = async (): Promise<void> => {
    if (backendRouterError) throw new Error(`backend configuration rejected at startup: ${backendRouterError}`);
    if (!backendRouter) return;
    await backendProbe();
  };
  const effectiveBackendRoutes: EffectiveBackendRoute[] =
    backendRouter?.describe(legacyModelForRole) ??
    ROLE_NAMES.map((role) => ({
      role,
      backend: "claude-code" as const,
      provider: "anthropic",
      model: legacyModelForRole(role),
      tier: "frontier",
    }));
  const apiKeyForRole = async (role: RoleName): Promise<string | undefined> =>
    effectiveBackendRoutes.find((route) => route.role === role)?.backend === "opencode"
      ? undefined
      : anthropicApiKey();
  const postHarnessReviewComment = async (params: {
    repoFullName: string;
    pr: { number: number; updatedExisting?: boolean };
    brief: CrystallisedBrief;
    reviewReport: import("./orchestrator/adversary.js").ReviewReport;
    ghToken: string;
    apiBase: string;
    refreshCredential?: () => Promise<{ ghToken: string; apiBase?: string }>;
  }): Promise<void> => {
    try {
      const commentBody = renderReviewComment(params.reviewReport, {
        updatedExisting: !!params.pr.updatedExisting,
        operatorGuidance: params.brief.operatorGuidance,
      });
      const comment = await postPrComment({
        repoFullName: params.repoFullName,
        prNumber: params.pr.number,
        body: commentBody,
        ghToken: params.ghToken,
        apiBase: params.apiBase,
        refreshCredential: params.refreshCredential,
      });
      if (!comment.ok) {
        api.logger.warn("[harness] PR review comment post failed (non-fatal)", {
          repo: params.repoFullName,
          prNumber: params.pr.number,
          status: comment.status,
          error: comment.error,
        });
      }
    } catch (err) {
      api.logger.warn("[harness] PR review comment post threw (non-fatal)", {
        repo: params.repoFullName,
        prNumber: params.pr.number,
        err: String(err),
      });
    }
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
  const executorFor = (role: RoleName) => {
    if (backendRouterError) {
      return (async () => {
        throw new Error(`backend configuration rejected at startup: ${backendRouterError}`);
      }) as unknown as ReturnType<BackendRouter["executorFor"]>;
    }
    const inner = backendRouter?.executorFor(role);
    if (!inner) return undefined;
    return (async (params) => {
      await ensureBackendReady();
      // The watchdog windows are supplied HERE, at the one place every
      // structured role passes through, rather than at each of the six call
      // sites. A role that forgets to pass them does not get a quiet default:
      // there is nowhere to forget them.
      //
      // This is the fix for the incident. `loop.sdk_first_token_timeout_seconds`
      // reached the worker roles through `runWorker` and reached the structured
      // ones through nothing at all, so `runWorkerAcp` fell back to its own 30s
      // and the reviewer died before its first token three times against a
      // deadline no operator had chosen. An explicit caller value still wins,
      // so this sets a floor of configuration, not a ceiling.
      return inner({
        ...params,
        firstTokenTimeoutSeconds: params.firstTokenTimeoutSeconds ?? config.loop.sdk_first_token_timeout_seconds,
        streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds ?? config.loop.sdk_stream_open_timeout_seconds,
      });
    }) as typeof inner;
  };

  // Anthropic API key resolver for the embedded Claude Agent SDK.
  // Vault-first, then env fallback. Memoised (including the "not found"
  // result) so we only hit the vault once per runtime generation.
  let anthropicKeyResolved = false;
  let anthropicKeyValue: string | undefined;
  const anthropicApiKey = async (): Promise<string | undefined> => {
    if (anthropicKeyResolved) return anthropicKeyValue;
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
      } catch (err) {
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
    api.logger.warn(
      "[harness] no Anthropic API key resolved (vault + env both empty); SDK may fall back to interactive /login and fail in headless containers",
      { credentialService: auth.credential_service || "(unset)", envVar: envName },
    );
    return undefined;
  };

  // beta.34: Vercel token resolver. Vault-first (config.vercel.credential_service)
  // then env fallback (config.vercel.api_key_env, default VERCEL_TOKEN). Same
  // pattern as anthropicApiKey / resolveGitToken so the env-only Staging
  // container (no vault) can supply the token via env instead of losing it.
  // Memoised; returns undefined when neither source has it.
  let vercelTokenResolved = false;
  let vercelTokenValue: string | undefined;
  const resolveVercelToken = async (): Promise<string | undefined> => {
    if (vercelTokenResolved) return vercelTokenValue;
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
      } catch (err) {
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
    api.logger.warn(
      "[harness] no Vercel token resolved (vault + env both empty); deploy verification will be unavailable",
      { credentialService: config.vercel?.credential_service || "(unset)", envVar: envName },
    );
    return undefined;
  };

  // Git token resolver: vault-first (by the pat-router-resolved service),
  // then per-provider env fallback (resolution.apiKeyEnv, e.g. GH_TOKEN /
  // GITLAB_TOKEN). Provider-aware and per-user: the caller passes the full
  // PAT resolution, whose credentialService already reflects the requesting
  // user + provider. NOT memoised across services (different users/repos ->
  // different services), but the CredentialAdapter caches per service.
  const resolveGitToken = async (
    r: { credentialService: string; apiKeyEnv: string; provider: string; tokenPointer?: TokenPointer; person?: string },
  ): Promise<string> => {
    // beta.25: hierarchical routing supplies a direct token pointer
    // (value | env | vault). This takes precedence over the legacy
    // vault-service-name path and does NOT silently fall back to a
    // per-provider env var — if the pointer can't resolve, fail loud so a
    // misconfigured user's request never borrows another user's token.
    if (r.tokenPointer) {
      const tp = r.tokenPointer;
      if (tp.value) return tp.value;
      if (tp.env) {
        const v = process.env[tp.env];
        if (v) {
          api.logger.info("[harness] git token resolved from hierarchy env pointer", { envVar: tp.env, provider: r.provider, person: r.person });
          return v;
        }
        throw new Error(
          `no ${r.provider} token: hierarchy env pointer '${tp.env}' is unset (person '${r.person ?? "?"}', service '${r.credentialService}')`,
        );
      }
      if (tp.vault) {
        try {
          const v = await creds.getToken(tp.vault, "token");
          if (v) return v;
        } catch (err) {
          throw new Error(
            `no ${r.provider} token: hierarchy vault pointer '${tp.vault}' lookup failed (${String(err)}). ` +
              `Store it with 'node scripts/vault.mjs set ${tp.vault}', or switch this person's token pointer to env/value.`,
          );
        }
        throw new Error(
          `no ${r.provider} token: hierarchy vault pointer '${tp.vault}' returned empty (person '${r.person ?? "?"}')`,
        );
      }
      throw new Error(
        `no ${r.provider} token: hierarchy person '${r.person ?? "?"}' has an empty token pointer (need one of value|env|vault)`,
      );
    }
    try {
      const v = await creds.getToken(r.credentialService, "token");
      if (v) return v;
    } catch (err) {
      // beta.110: the old "is there a vault adapter at all?" branch is gone --
      // the vault is ours and always constructed, so a miss means exactly one
      // thing: no entry under this service name. A BROKEN vault is a different
      // message and comes from the sealed stub. Inline the error + service name
      // in the message string so the log survives meta-stripping (see
      // pr-watcher / crystallise comments).
      const reason = String(err);
      if (vaultOpenError) {
        api.logger.warn(
          `[harness] git token '${r.credentialService}': vault is unavailable (${vaultOpenError}); trying env fallback`,
          { service: r.credentialService, provider: r.provider, envVar: r.apiKeyEnv },
        );
      } else {
        api.logger.info(
          `[harness] git token '${r.credentialService}' not in the vault (${reason}); trying env fallback`,
          { service: r.credentialService, provider: r.provider, envVar: r.apiKeyEnv },
        );
      }
    }
    const envVal = process.env[r.apiKeyEnv];
    if (envVal) {
      api.logger.info("[harness] git token resolved from env", { envVar: r.apiKeyEnv, service: r.credentialService, provider: r.provider });
      return envVal;
    }
    throw new Error(
      `no ${r.provider} token resolved for service '${r.credentialService}' (vault empty/failed and env '${r.apiKeyEnv}' unset)`,
    );
  };
  // Back-compat shim: resolve by bare service name using github defaults.
  const resolveGithubToken = async (service: string): Promise<string> =>
    resolveGitToken({ credentialService: service, apiKeyEnv: config.pat_routing.auth?.api_key_env || "GH_TOKEN", provider: "github" });

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
    effectiveRouteFor: (role) => effectiveBackendRoutes.find((route) => route.role === role)!,

    runLead: async (brief, ctx) => {
      const requester = ctx?.requester ?? config.slack.authorised_users[0]!;
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
        requireConventionsBeforePlanning: config.brief?.ingest_repo_conventions !== false,
        // beta.67 (P0a): callLeadModel genuinely (re-)invokes the lead SDK so
        // the ONE bounded re-ask actually re-plans with the corrective note.
        callLeadModel: async (b, _repos, correctiveNote) =>
          runLeadSdk({
            execute: executorFor("lead"),
            model: config.models.lead,
            brief: b,
            reposAllowed: config.repos.allowed,
            // beta.99: the lead ran on `worker_timeout_seconds` (1800s) while
            // `lead_timeout_seconds` (900s) -- the knob documented and audited
            // for exactly this call -- was ignored, so operators tuning the
            // lead timeout changed nothing.
            timeoutSeconds: config.loop.lead_timeout_seconds ?? config.loop.worker_timeout_seconds,
            apiKey: await apiKeyForRole("lead"),
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
        callWorkerContextModel: async (b, plan, missingSeqs) =>
          runLeadWorkerContextSdk({
            execute: executorFor("worker_context"),
            model: config.models.lead,
            brief: b,
            subTasks: plan.subTasks,
            missingSeqs,
            timeoutSeconds: config.loop.lead_timeout_seconds ?? config.loop.worker_timeout_seconds,
            apiKey: await apiKeyForRole("worker_context"),
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
        scoutRepo: async ({ brief: scoutBrief, repoFullName, runModel = true }) => {
          const [owner] = repoFullName.split("/");
          const resolution = pat.resolve({
            slackUserId: requester,
            gitHubUser: owner!,
            repoFullName,
          });
          const ghToken = await resolveGitToken(resolution);
          let scoutWorktree: string | undefined;
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
            const conventions =
              config.brief?.ingest_repo_conventions !== false
                ? ingestRepoConventions(scoutWorktree, config.brief?.convention_char_budget ?? 10000)
                : [];
            if (!runModel) return { report: "", conventions };
            try {
              if (backendRouterError) await ensureBackendReady();
              if (backendRouter?.backendFor("scout").backend === "opencode") {
                await ensureBackendReady();
                const s = await runWorkerAcp({
                agent: backendRouter.agentSpecFor("scout"),
                worktreePath: scoutWorktree,
                systemPrompt: buildScoutSystemPrompt(),
                userMessage: buildScoutUserMessage(scoutBrief),
                model: backendRouter.backendFor("scout").model ?? config.models.lead,
                effort: backendRouter.backendFor("scout").effort,
                timeoutSeconds: config.loop.lead_scout_timeout_seconds ?? 420,
                acpGuard: buildAcpGuard({
                  bash_whitelist: config.safety.bash_whitelist,
                  bash_denylist_tokens: config.safety.bash_denylist_tokens,
                  // The scout only reads. It gets the worker's path denylist
                  // and no write path at all. rc.9: no template exception --
                  // that authorises an EDIT to a template, and the scout does
                  // not edit anything.
                  path_denylist: config.safety.path_denylist,
                  repoRoot: scoutWorktree,
                  realpath: (p) => realpathSync(p),
                  allow_git_push: false,
                  allow_network_commands: false,
                }),
                secretToken: ghToken,
                logger: api.logger,
              });
                const pricedScout = backendRouter.priceTurn("scout", s);
                return {
                  report: s.finalMessage,
                  conventions,
                  costUsd: pricedScout.costUsd ?? 0,
                  usageMeasured: pricedScout.costUsd !== undefined,
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
                apiKey: await apiKeyForRole("scout"),
                maxOutputTokens: config.models.max_output_tokens,
                allowedTools: SCOUT_ALLOWED_TOOLS,
                deniedTools: SCOUT_DENIED_TOOLS,
                logger: api.logger,
              });
              return {
                report: r.report,
                conventions,
                costUsd: r.costUsd,
                usageMeasured: r.usageMeasured,
                tokensIn: r.tokensIn,
                tokensOut: r.tokensOut,
                timedOut: r.timedOut,
              };
            } catch (err) {
              api.logger.warn("[lead] model scout failed after conventions were loaded; planning retains convention context", { repo: repoFullName, err: String(err) });
              return { report: "", conventions };
            }
          } finally {
            if (scoutWorktree) {
              await git
                .releaseByPath(scoutWorktree, repoFullName)
                .catch((err: unknown) =>
                  api.logger.warn("[lead] beta.104: scout worktree release failed (non-fatal)", {
                    path: scoutWorktree, err: String(err),
                  }),
                );
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
            gitHubUser: owner!,
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
        remoteBranchExists: async (repoFullName: string, branch: string) => {
          try {
            const [owner] = repoFullName.split("/");
            const resolution = pat.resolve({ slackUserId: requester, gitHubUser: owner!, repoFullName });
            const ghToken = await resolveGitToken(resolution);
            return await git.remoteBranchExistsByUrl(repoFullName, branch, ghToken);
          } catch {
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
        apiKey: await apiKeyForRole("revise_spec"),
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


    // Qualified with the backend when it is not the default, so the ledger says
    // which engine served the turn and not merely which model was asked for.
    // `claude-code` rows stay bare, so v1 history and v1 installs read exactly
    // as they always did.
    describeWorkerModel: (plannedModel) => {
      const route = backendRouter?.backendFor("worker");
      if (!route || route.backend !== "opencode") return plannedModel;
      return `opencode:${route.model ?? plannedModel}`;
    },
    runWorker: async ({ brief, subTask, plan, worktreePath, resumeSessionId, requester, dispatchHint, modelOverride, onStreamSlow, onActivity, firstTokenTimeoutSecondsOverride }) => {
      const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
      const canUseTool = buildBashGuard(config.safety);
      const resolution = pat.resolve({
        slackUserId: requester ?? config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      });
      return runWorkerCore(
        // beta.117: the loop states which checkout this worker owns. Under
        // parallelism it is a leased slot, and using plan.worktreePath here
        // would silently put every worker back in the shared session worktree
        // -- the exact cross-contamination b117 exists to prevent. The fallback
        // covers the serial path, where the two are the same.
        worktreePath ?? plan.worktreePath,
        brief,
        subTask,
        resolution.commitIdentity,
        {
          config,
          logger: api.logger,
          buildCanUseTool: () => canUseTool,
          runWorkerModel: async (params) => {
            // Throws when the configuration was rejected, so a moved role
            // fails loudly instead of quietly running on the default backend.
            if (backendRouterError) await ensureBackendReady();
            if (backendRouter?.backendFor("worker").backend !== "opencode") {
              return runWorkerSdk({ ...params, apiKey: await apiKeyForRole("worker"), maxOutputTokens: config.models.max_output_tokens });
            }
            // The guard is proven live before the first turn, not assumed from
            // the config we wrote: an agent that has stopped routing tool calls
            // through `session/request_permission` looks identical from its own
            // configuration file.
            await ensureBackendReady();
            const workerGuard = buildAcpGuard({
              bash_whitelist: config.safety.bash_whitelist,
              bash_denylist_tokens: config.safety.bash_denylist_tokens,
              path_denylist: config.safety.path_denylist,
              // rc.9: the worktree root and a real symlink resolver, so an
              // absolute path and a symlink target are judged by the same rules
              // as a repo-relative one. Without these the guard can only reason
              // about the string it was handed.
              path_denylist_exceptions: config.safety.path_denylist_exceptions,
              repoRoot: params.worktreePath,
              realpath: (p) => realpathSync(p),
              allow_git_push: config.safety.allow_git_push,
              allow_network_commands: config.safety.allow_network_commands,
            });
            const r = await runWorkerAcp({
              agent: backendRouter.agentSpecFor("worker"),
              worktreePath: params.worktreePath,
              systemPrompt: params.systemPrompt,
              userMessage: params.userMessage,
              model: backendRouter.backendFor("worker").model ?? params.model,
              effort: backendRouter.backendFor("worker").effort,
              resumeSessionId: params.resumeSessionId,
              resumeCumulativeCostUsd: params.resumeSessionId
                ? (state.db.prepare(
                    `SELECT cumulative_cost_usd FROM provider_session_usage
                      WHERE backend = 'opencode' AND provider_session_id = ?`,
                  ).get(params.resumeSessionId) as { cumulative_cost_usd?: number } | undefined)?.cumulative_cost_usd
                : undefined,
              timeoutSeconds: params.timeoutSeconds,
              streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
              firstTokenTimeoutSeconds: params.firstTokenTimeoutSeconds,
              streamIdleWarnSeconds: params.streamIdleWarnSeconds,
              onStreamSlow: params.onStreamSlow,
              onActivity: params.onActivity,
              // NOT params.canUseTool: that guard keys on Claude Code tool
              // names and would fall through to allow on every ACP call.
              acpGuard: focusedWorkerAcpGuard(workerGuard),
              // Parity with the scout, which has always passed this. Without
              // it `scrub()` is a no-op for worker logs -- and the worker is
              // the role whose logs carry command lines, so it is the one that
              // most needs scrubbing. The token is not in the child's filtered
              // env, so this is defence in depth rather than the only cover.
              secretToken: await resolveGitToken(resolution).catch(() => ""),
              logger: api.logger,
            });
            // Priced through the router so a provider that reports tokens
            // without a cost is billed off the catalogue rather than recorded
            // as a free turn.
            const priced = backendRouter.priceTurn("worker", r);
            return {
              ...r,
              costUsd: priced.costUsd ?? 0,
              usageMeasured: priced.costUsd !== undefined && r.usageSource !== "unavailable",
              usageSource: r.usageSource,
              providerCumulativeCostUsd: r.cumulativeCostUsd,
              providerCostBaselineUsd: r.costBaselineUsd,
              providerCostCurrency: r.costCurrency,
            };
          },
          gitBaseSha: (wt) => git.baseSha(wt),
          gitListChangedFiles: (wt, base) => git.listChangedFiles(wt, base),
          gitCommit: (wt, msg, id, authorizedPaths) => git.commit(wt, msg, id, authorizedPaths ?? []),
          // beta.47: reconcile commit sha when the worker self-commits.
          gitHeadSha: (wt) => git.baseSha(wt),
          gitListCommittedFiles: (wt, base) => git.listCommittedFiles(wt, base),
          // beta.53 (P2): capture uncommitted working-tree changes for the audit
          // + retry logic (wrote-but-didn't-commit vs zero-work).
          gitStatusPorcelain: (wt) => git.statusPorcelain(wt),
        },
        resumeSessionId,
        dispatchHint,
        onStreamSlow,
        modelOverride,
        firstTokenTimeoutSecondsOverride,
        onActivity,
      );
    },

    runAdversary: async ({ brief, plan, sessionId, runtime, requester, baseSha, priorFindings, revision }) => {
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
      let adversaryGhToken: string | undefined;
      try {
        const [owner] = plan.repo.split("/");
        const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner!, repoFullName: plan.repo });
        adversaryGhToken = await resolveGitToken(resolution);
      } catch (err) {
        api.logger.warn("[harness] adversary diff: could not resolve GitHub token (promisor fetch may fail on a private repo)", { repo: plan.repo, err: String(err) });
      }
      let diffText = await git.diff(plan.worktreePath, diffBase, adversaryGhToken);
      // rc.7: fold declared generated output down to a manifest.
      //
      // Off unless a deployment asks for it, and inert until ownership has been
      // declared. The files are still NAMED, with line counts and owning
      // script -- what goes is the content of files whose content is derived.
      // Audited with the exact saving, because "the reviewer read less" is a
      // thing an operator must be able to see having happened.
      if (config.verify?.summarise_generated_for_review === true) {
        const generators = resolveGenerators(config.verify?.generators);
        if (!generators.empty) {
          const before = diffText.length;
          const { diff, folded } = foldGeneratedFiles(diffText, (f: string) => generators.ownerOf(f)?.script ?? null);
          if (folded.length > 0) {
            diffText = diff;
            state.audit(
              "adversary.generated_output_folded",
              {
                fileCount: folded.length,
                scripts: [...new Set(folded.map((f) => f.script))],
                bytesBefore: before,
                bytesAfter: diffText.length,
                sample: folded.slice(0, 20).map((f) => f.path),
              },
              sessionId,
            );
          }
        }
      }
      const diffFile = resolve(config.storage.worktree_root.replace(/^~/, process.env.HOME ?? ""), `${Date.now()}.diff`);
      await mkdir(dirname(diffFile), { recursive: true });
      await writeFile(diffFile, diffText, "utf8");
      // beta.57 (P3): the diff file was written into worktree_root and never
      // deleted -- one leaked <ts>.diff per review cycle, forever.
      try {
        return await runAdversaryCore(
        {
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
          // rc.3: present only on a revise. Replaces the flattened brief above
          // with labelled sections, so a revision-only exclusion is not read as
          // an indictment of the feature it is revising.
          revision,
          // beta.69 (F1): a "no tests" finding is only diff-addressable when the
          // repo actually declares a `test` script. Detect it from the worktree
          // package.json so the classifier treats its absence as a process
          // concern (the repo has no test script by design), not a diff defect.
          repoHasTestScript: (() => {
            try {
              return discoverCheckScripts(plan.worktreePath).some((s) => s.name === "test");
            } catch {
              return false;
            }
          })(),
          // rc.5: only demote a "the bundle is stale" finding when something
          // actually owns regenerating it. Without a declared generator the
          // complaint is unanswered, so it keeps its weight.
          hasDeclaredGenerators: !resolveGenerators(config.verify?.generators).empty,
        },
        {
          logger: api.logger,
          readDiff: async (p) => (await readFile(p, "utf8")),
          // beta.91 (Staging pass-2 nit): surface file-attribution retry
          // before/after counts so a WORSE retry (rejected by the guard, e.g.
          // the priorFindings-conflation edge) is visible in prod logs.
          onFileAttributionRetry: (info) =>
            api.logger.info("[adversary] loop.file_attribution_retry", {
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
              // Belt and braces with the `executorFor` wrapper: the adversary
              // is the role the incident happened to, and it is also the only
              // one that drives its own ladder, so it states the deadline it
              // expects rather than relying on a layer below to remember.
              firstTokenTimeoutSeconds: config.loop.sdk_first_token_timeout_seconds,
              apiKey: await apiKeyForRole("adversary"),
              logger: api.logger,
            });
            return {
              parsed: {
                verdict: r.parsed.verdict,
                findings: (r.parsed.findings as any[]).map((f) => ({
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
                    ? f.relatedFiles.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0)
                    : undefined,
                })),
                summary: r.parsed.summary,
              },
              sdkSessionId: r.sdkSessionId,
              costUsd: r.costUsd,
              usageMeasured: r.usageMeasured,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
            };
          },
        },
        );
      } finally {
        await rm(diffFile, { force: true }).catch(() => undefined);
      }
    },

    previewVerificationEnabled: config.vercel?.enabled === true,
    fetchRuntime: async ({ plan, sessionId, waitForPreview = false, commitSha }) => {
      // Prefer a manual upload if one exists (most recent wins). This lets
      // non-Vercel deploys hand-supply logs via the harness_upload_logs tool.
      const upload = state.db
        .prepare(
          `SELECT status, source, logs_excerpt, error_count, deployment_url, uploaded_at, uploaded_by
             FROM runtime_uploads
            WHERE session_id = ?
         ORDER BY uploaded_at DESC
            LIMIT 1`,
        )
        .get(sessionId) as
          | { status: string; source: string | null; logs_excerpt: string; error_count: number | null; deployment_url: string | null; uploaded_at: number; uploaded_by: string }
          | undefined;
      if (upload && !waitForPreview) {
        return {
          provider: "manual" as const,
          status: upload.status as "ok" | "build_failed" | "no_deploy_yet" | "unavailable",
          deploymentUrl: upload.deployment_url ?? undefined,
          logsExcerpt: upload.logs_excerpt,
          errorCount: upload.error_count ?? undefined,
          uploadedAt: upload.uploaded_at,
          uploadedBy: upload.uploaded_by,
          source: upload.source ?? undefined,
        };
      }
      // Otherwise fall back to Vercel bridge, only if explicitly enabled.
      if (!config.vercel?.enabled) return undefined;
      // Stage one is a static review. Polling before the branch has been
      // pushed can never find a deployment and wastes the full wait window.
      if (!waitForPreview) return undefined;
      if (!commitSha) {
        return {
          provider: "vercel" as const,
          status: "unavailable" as const,
          logsExcerpt: "Exact candidate SHA was not supplied; refusing branch-based preview lookup.",
        };
      }
      // beta.34: vault-first + env fallback (was vault-only, which lost the
      // token on the vault-less Staging container).
      const token = await resolveVercelToken();
      if (!token) {
        // No token from vault or env -> deploy verification unavailable.
        // Surface it explicitly rather than calling the API unauthenticated.
        return {
          provider: "vercel" as const,
          status: "unavailable" as const,
          logsExcerpt: "Vercel token unavailable (no vault entry and env fallback unset). Set VERCEL_TOKEN or the vault service.",
          errorCount: undefined,
        };
      }
      {
        const result = await verifyDeploymentForSha({
          vercelToken: token,
          teamId: config.vercel.team_id,
          projectId: config.vercel.project_id,
          sha: commitSha,
          waitSeconds: config.vercel.preview_wait_seconds,
          logger: api.logger,
        });
        return {
          provider: "vercel" as const,
          status:
            result.status === "ready"
              ? "ok" as const
              : result.status === "error"
                ? "build_failed" as const
                : result.status === "pending"
                  ? "no_deploy_yet" as const
                  : "unavailable" as const,
          deploymentUrl: result.deploymentUrl
            ? (result.deploymentUrl.startsWith("http") ? result.deploymentUrl : `https://${result.deploymentUrl}`)
            : undefined,
          logsExcerpt: result.logsExcerpt ?? result.detail,
          errorCount: result.status === "error" ? 1 : 0,
        };
      }
    },

    pushBranchForPreview: async ({ plan, requester, commitSha, resolveCredentialForMutation }) => {
      const resolution = resolveCredentialForMutation
        ? await resolveCredentialForMutation("push_feature_branch")
        : await (async () => { const route = pat.resolve({
        slackUserId: requester ?? config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      }); return { ...route, token: await resolveGitToken(route) }; })();
      await git.pushBranch(plan.worktreePath, "origin", plan.branch, resolution.token);
      const remoteSha = await git.remoteBranchSha(plan.worktreePath, "origin", plan.branch, resolution.token);
      if (remoteSha !== commitSha) {
        throw new Error(`preview push did not publish expected SHA ${commitSha}; remote is ${remoteSha ?? "(missing)"}`);
      }
      return { remoteSha };
    },

    /**
     * rc.5 (#2): the ground truth for publication -- `git ls-remote` against
     * the real remote, through the SAME requester credential routing as every
     * other provider call (never a borrowed token, never a logged secret).
     *
     * Returns undefined for "no such branch". Throws only when the remote could
     * not be READ, which the loop classifies as `verification_unavailable` and
     * refuses to treat as publication. This is what StitchGuard PR #1168 had no
     * equivalent of: nothing in the ship path ever asked GitHub what was
     * actually on the branch.
     */
    remoteBranchSha: async ({ plan, branch, requester }) => {
      const resolution = pat.resolve({
        slackUserId: requester ?? config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      });
      const gitToken = await resolveGitToken(resolution);
      return await git.remoteBranchSha(plan.worktreePath, "origin", branch, gitToken);
    },

    openPullRequest: async ({ plan, brief, reviewReport, requester, resolveCredentialForMutation }) => {
      const resolution = resolveCredentialForMutation
        ? await resolveCredentialForMutation("open_pull_request")
        : await (async () => { const route = pat.resolve({
        slackUserId: requester ?? config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      }); return { ...route, token: await resolveGitToken(route) }; })();
      const ghToken = resolution.token;
      if (resolution.provider !== "github") {
        throw new Error(
          `provider '${resolution.provider}' branch was pushed but automated MR/PR creation is not implemented (see issue #25); open the merge request manually for branch '${plan.branch}'`,
        );
      }
      const pr = await createPullRequest({
        repoFullName: plan.repo,
        head: plan.branch,
        base: config.repos.default_base_branch,
        title: `harness: ${brief.title}`,
        body: renderPrBody(brief, reviewReport),
        ghToken,
        apiBase: resolution.apiBase,
        draft: (config.repos.draft_pr_on_nonpass ?? false) && reviewReport.verdict !== "pass",
        labels: prLabelsFor(reviewReport),
        logger: api.logger,
        refreshCredential: resolveCredentialForMutation ? async () => { const c = await resolveCredentialForMutation("open_pull_request"); return { ghToken: c.token, apiBase: c.apiBase }; } : undefined,
      });
      await postHarnessReviewComment({
        repoFullName: plan.repo, pr, brief, reviewReport, ghToken, apiBase: resolution.apiBase ?? "https://api.github.com",
        refreshCredential: resolveCredentialForMutation ? async () => { const c = await resolveCredentialForMutation("update_pull_request"); return { ghToken: c.token, apiBase: c.apiBase }; } : undefined,
      });
      return pr.htmlUrl;
    },

    pushBranchAndOpenPr: async ({ plan, brief, reviewReport, requester, resolveCredentialForMutation }) => {
      const pushResolution = resolveCredentialForMutation
        ? await resolveCredentialForMutation("push_feature_branch")
        : await (async () => { const route = pat.resolve({
        slackUserId: requester ?? config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      }); return { ...route, token: await resolveGitToken(route) }; })();
      await git.pushBranch(plan.worktreePath, "origin", plan.branch, pushResolution.token);
      const resolution = resolveCredentialForMutation
        ? await resolveCredentialForMutation("open_pull_request")
        : await (async () => { const route = pat.resolve({ slackUserId: requester ?? config.slack.authorised_users[0]!, gitHubUser: plan.repo.split("/")[0]!, repoFullName: plan.repo }); return { ...route, token: await resolveGitToken(route) }; })();
      const ghToken = resolution.token;
      if (resolution.provider !== "github") {
        // GitLab merge-request creation is a separate adapter (tracked in
        // issue #25). Token resolution + push work for GitLab; MR open does
        // not yet. Fail loud rather than silently mis-calling the GitHub API.
        throw new Error(
          `provider '${resolution.provider}' push succeeded but automated MR/PR creation is not yet implemented (see issue #25); open the merge request manually for branch '${plan.branch}'`,
        );
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
        refreshCredential: resolveCredentialForMutation ? async () => { const c = await resolveCredentialForMutation("open_pull_request"); return { ghToken: c.token, apiBase: c.apiBase }; } : undefined,
      });
      // beta.75 (#1): post the review verdict + findings as a PR COMMENT on
      // EVERY review -- not just at PR creation. createPullRequest writes the
      // review into the PR body only on the first open; when the PR already
      // exists (updatedExisting: a revise, or a harness_run D2-promoted onto an
      // open-PR branch) the body is NOT rewritten, so the new verdict/findings
      // were invisible on the PR (Carel on #876). A fresh comment per review
      // surfaces the current verdict/findings on the PR timeline. Best-effort:
      // NEVER fail the run on a comment error -- the code + PR already landed.
      await postHarnessReviewComment({
        repoFullName: plan.repo, pr, brief, reviewReport, ghToken, apiBase: resolution.apiBase ?? "https://api.github.com",
        refreshCredential: resolveCredentialForMutation ? async () => { const c = await resolveCredentialForMutation("update_pull_request"); return { ghToken: c.token, apiBase: c.apiBase }; } : undefined,
      });
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
    worktreeHeadSha: async (worktreePath: string) => git.baseSha(worktreePath),
    // rc.3: no `.catch(() => [])` here on purpose. The loop has to be able to
    // tell a clean tree from an unanswerable probe before it declares a
    // no-change exit or releases a worktree.
    worktreeStatusPorcelain: async (worktreePath: string) => git.statusPorcelain(worktreePath),
    // beta.67 (Bug B): fork-point + branch commit-count probes for the
    // plan_base_sha capture (at plan_ready) and the adversary diff-base sanity
    // log. The adversary review then diffs against the branch's own
    // fork-point, not against main-at-review-time.
    worktreeMergeBase: async (worktreePath: string, baseBranch: string) => git.mergeBase(worktreePath, baseBranch).catch(() => ""),
    worktreeCommitCount: async (worktreePath: string, base: string) => git.commitCount(worktreePath, base).catch(() => -1),
    // beta.101: ledger-reachability probe. Returns [] on failure so the guard
    // fails OPEN -- a broken probe must never block an otherwise sound run.
    unreachableCommits: async (worktreePath: string, from: string, shas: string[]) =>
      git.unreachableCommits(worktreePath, from, shas).catch(() => [] as string[]),
    // beta.101: tracked-file listing for plan-time fictional-path detection.
    // rc.10 also feeds this to contract re-derivation as the authoritative
    // answer to "does the declared path exist?" (audit 5591).
    listRepoFiles: async (worktreePath: string) => git.listTrackedFiles(worktreePath).catch(() => [] as string[]),
    /*
     * rc.10 (F1, audits 5602/5628): credentials for the checkpoint's promisor
     * fetch, routed exactly like a push or a remote read -- same `pat.resolve`,
     * same `resolveGitToken`, no parallel vault and no global fallback.
     *
     * The token reaches git only through the child environment the adapter
     * builds, and the runner is disposed by the loop as soon as the checkpoint
     * finishes.
     */
    checkpointGitRunner: async ({ repo, requester }) => {
      const resolution = pat.resolve({
        slackUserId: requester || config.slack.authorised_users[0]!,
        gitHubUser: repo.split("/")[0]!,
        repoFullName: repo,
      });
      const gitToken = await resolveGitToken(resolution);
      return git.authenticatedRunner(gitToken);
    },
    // beta.64 (P0-3/P0-4): diff-stat + scripted tsc for the best-effort-verify
    // clean-diff gate and the scripted verifier fallback of a timed-out LLM
    // VERIFY sub-task. A "run tsc/diff/check-scripts" verify step needs no model.
    gitDiffStat: async (worktreePath: string, base: string) => git.diffStat(worktreePath, base).catch(() => ""),
    // beta.94 (Feature 1b): committed files in <base>..HEAD for the deterministic
    // final-scope check (out-of-scope commit -> fit/medium review finding).
    worktreeCommittedFiles: async (worktreePath: string, base: string) => git.listCommittedFiles(worktreePath, base).catch(() => [] as string[]),
    // beta.115: the typecheck gate's escape hatch when `npm run typecheck` is
    // unrunnable, plus the evidence needed to explain why it was.
    runTypecheckDirect: (worktreePath: string, timeoutMs: number) => runTypecheckDirect(worktreePath, timeoutMs),
    diagnoseCheckEnv: (worktreePath: string) => diagnoseCheckEnv(worktreePath) as unknown as Record<string, unknown>,
    runScriptedTsc: async (worktreePath: string, timeoutMs: number) => {
      const result = runTypecheckDirect(worktreePath, timeoutMs);
      if (!result) {
        return { ok: false, output: "TypeScript compiler unavailable: node_modules/.bin/tsc is missing or unusable." };
      }
      const output = `${result.stdout}${result.stderr}`;
      return { ok: result.status === 0 && !result.timedOut, output: output.slice(-4000) };
    },

    // beta.81 (Track B / B2): post-push CI verification. Poll the combined
    // GitHub status/check-runs for the pushed head SHA (getCombinedStatus is
    // the existing beta.34 primitive). Token resolved via the same pat.resolve
    // path as the push; a token-less read still works for public repos.
    ciCombinedStatus: async ({ repoFullName, sha, requester }) => {
      const [owner] = repoFullName.split("/");
      const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner!, repoFullName });
      const ghToken = await resolveGitToken(resolution).catch(() => "");
      return getCombinedStatus({ repoFullName, sha, ghToken, apiBase: resolution.apiBase });
    },
    // beta.119: the structured read behind the verdict. The polling loop needs
    // the check-run COUNT (not just the state) to reject a stale, shrunken
    // check list that would otherwise read as green.
    ciSnapshot: async ({ repoFullName, sha, requester }) => {
      const [owner] = repoFullName.split("/");
      const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner!, repoFullName });
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
      const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner!, repoFullName });
      const ghToken = await resolveGitToken(resolution).catch(() => "");
      if (!ghToken) return null;
      return canPushWorkflows(await getTokenScopes({ ghToken, apiBase: resolution.apiBase }));
    },
    // beta.81 (Track B / B2): on CI failure, fetch the failing check-run logs
    // (names + output summaries) as the revise finding source. Best-effort.
    ciFailingLogs: async ({ repoFullName, sha, requester }) => {
      const [owner] = repoFullName.split("/");
      const resolution = pat.resolve({ slackUserId: requester ?? "", gitHubUser: owner!, repoFullName });
      const ghToken = await resolveGitToken(resolution).catch(() => "");
      return getFailingCheckLogs({ repoFullName, sha, ghToken, apiBase: resolution.apiBase });
    },
    // beta.81 (Track B / B3): when a repo has no CI, author + commit a GitHub
    // Actions workflow running its declared check scripts so CI runs on GitHub
    // (never a local fallback). Committed with the harness commit identity.
    ciAuthorWorkflow: async ({ worktreePath, assertMutationAuthorized }) => {
      // The commit is a CI-config file; identity is cosmetic. Use the first
      // configured commit identity when present, else a stable harness default.
      const anyIdentity = Object.values(config.pat_routing.commit_identity ?? {})[0];
      return authorCiWorkflow({
        worktreePath,
        assertMutationAuthorized,
        gitCommit: (wt, msg) =>
          git.commit(wt, msg, {
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

    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),

    reportProgress: async (sessionId, status, meta) => {
      try {
        state.audit("loop.progress", { status, ...(meta && typeof meta === "object" ? meta : { meta }) }, sessionId);
      } catch (err) {
        api.logger.warn("[harness] reportProgress audit failed", { sessionId, status, err: String(err) });
      }
    },
    deliverProgress: () => undefined,
    postWarning: () => undefined,

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

  const runtime: HarnessRuntime = {
    config, state, budget, pat, loop, interactionLog, listener, dispatcher, slack, git, creds,
    effectiveBackendRoutes, ensureBackendReady,
    vault, vaultError: vaultOpenError,
    crystallise,
    anthropicApiKey,
    githubToken: resolveGithubToken,
    gitToken: resolveGitToken,
    githubServiceFor: (repoFullName?: string) => {
      const repo = repoFullName ?? config.repos.allowed.find((r) => !r.includes("*")) ?? config.repos.allowed[0];
      if (!repo) return undefined;
      // A glob like "owner/<star>" can't resolve a concrete service; require
      // a concrete owner/repo. Replace a trailing glob segment to at least
      // resolve the owner. (Built without a literal slash-star regex so the
      // sdk-compliance comment stripper doesn't mis-parse it.)
      const glob = "/" + "*"; // avoid a literal slash-star token in source
      const concrete = repo.endsWith(glob) ? repo.slice(0, -1) + "_probe" : repo;
      try {
        return pat.resolve({
          slackUserId: config.slack.authorised_users[0] ?? "unknown",
          gitHubUser: concrete.split("/")[0]!,
          repoFullName: concrete,
        }).credentialService;
      } catch {
        return undefined;
      }
    },
    routeOverlay,
    gitResolutionFor: (repoFullName?: string, slackUserId?: string) => {
      const repo = repoFullName ?? config.repos.allowed.find((r) => !r.includes("*")) ?? config.repos.allowed[0];
      if (!repo) return undefined;
      const glob = "/" + "*";
      const concrete = repo.endsWith(glob) ? repo.slice(0, -1) + "_probe" : repo;
      try {
        const r = pat.resolve({
          // beta.133: onboarding needs the name THIS requester resolves to, not
          // whatever the first authorised user would get. With a {userid} or
          // {requester} pattern those differ, which is exactly the case the
          // onboard consistency check exists to catch.
          slackUserId: slackUserId ?? config.slack.authorised_users[0] ?? "unknown",
          gitHubUser: concrete.split("/")[0]!,
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
      } catch {
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
          gitHubUser: repoFullName.split("/")[0]!,
          repoFullName,
        });
      } catch (err) {
        return {
          ok: false,
          missing: ["routing"],
          message:
            `I don't have credentials set up for you to work in ${repoFullName}. ` +
            `${String(err instanceof Error ? err.message : err)} ` +
            `Tell me your git email and a token for this repo and I'll store it, ` +
            `or ask your OpenClaw operator to add you.`,
        };
      }

      // 2) Commit identity completeness (name + email). Email is the one
      //    Carel flagged: fail up front, not mid-run.
      const missing: string[] = [];
      const idName = resolution.commitIdentity?.name?.trim();
      const idEmail = resolution.commitIdentity?.email?.trim();
      // A synthesised default identity (owner + noreply) is the legacy
      // fallback; only treat email as genuinely present when it looks real.
      if (!idName) missing.push("name");
      if (!idEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(idEmail)) missing.push("email");

      // 3) Token resolvability. Try to resolve without leaking the value.
      let tokenOk = false;
      let tokenErr = "";
      try {
        const t = await resolveGitToken(resolution);
        tokenOk = !!t;
      } catch (err) {
        tokenErr = String(err instanceof Error ? err.message : err);
      }
      if (!tokenOk) missing.push("token");

      if (missing.length === 0) {
        // beta.57 (P3): GitLab MR creation is not implemented yet (issue #25).
        // Say so at PREFLIGHT, before any spend, instead of letting the run
        // burn its whole budget and fail at the final push-and-open-MR step.
        const gitlabNote =
          resolution.provider === "gitlab"
            ? "Note: automated merge-request creation for GitLab is not yet implemented (issue #25). The run will complete and push its branch, but you will need to open the MR manually."
            : "";
        return { ok: true, missing: [], message: gitlabNote, provenance: resolution.provenance };
      }

      const parts: string[] = [];
      if (missing.includes("email")) parts.push("a git commit email address");
      if (missing.includes("name")) parts.push("a git commit name");
      if (missing.includes("token")) parts.push(`a ${resolution.provider} token${tokenErr ? ` (${tokenErr})` : ""}`);
      return {
        ok: false,
        missing,
        provenance: resolution.provenance,
        message:
          `Before I run this on ${repoFullName} I need ${parts.join(" and ")}. ` +
          `Please provide ${missing.includes("token") ? "the token" : "it"} and I'll ` +
          `store it under your identity (${resolution.person ?? requester}) so future runs just work.`,
      };
    },
    mergePr: async ({ sessionId }) => ({
      ok: false,
      refused: true,
      message: `Legacy session merge is disabled for ${sessionId}. Use the attested control-plane merge operation.`,
    }),

    // ---- rc.4: recover a lost PR association ----
    //
    // StitchGuard session 112673df pushed nine commits and opened PR #1168,
    // then failed before `pr_number` was written. `a new confirmed change` refuses a row
    // with no PR, so the PR was unreachable by the one workflow built to change
    // it, and the documented alternative was to build the feature again.
    //
    // The temptation is to write the column by hand. That is the thing this
    // exists to prevent: a hand-written association is unverified, unaudited,
    // and indistinguishable afterwards from one the loop made itself.
    linkPr: async (args) =>
      linkPullRequest(
        {
          db: state.db,
          audit: (event, payload, sessionId) => state.audit(event, payload, sessionId),
          authorisedUsers: config.slack.authorised_users,
          defaultBaseBranch: config.repos.default_base_branch,
          // The requester on the session row owns the credential route, not the
          // operator doing the linking: the link is read against the same access
          // the run itself had, so recovering a PR cannot reach a repository the
          // session could not.
          fetchPr: async ({ repo, prNumber, requester }) => {
            const resolution = pat.resolve({
              slackUserId: requester,
              gitHubUser: repo.split("/")[0]!,
              repoFullName: repo,
            });
            const ghToken = await resolveGitToken(resolution);
            const pr = await getPullRequest({ repoFullName: repo, prNumber, ghToken, apiBase: resolution.apiBase });
            const commits = await listPullRequestCommits({ repoFullName: repo, prNumber, ghToken, apiBase: resolution.apiBase });
            const mergeBaseSha = await getMergeBase({
              repoFullName: repo,
              base: pr.baseBranch,
              head: pr.headSha,
              ghToken,
              apiBase: resolution.apiBase,
            });
            return {
              headRepo: pr.headRepoFullName,
              headRef: pr.headRef,
              headSha: pr.headSha,
              baseRef: pr.baseBranch,
              state: pr.state,
              merged: pr.merged,
              draft: pr.draft,
              htmlUrl: pr.htmlUrl,
              commitShas: commits.shas,
              commitsTruncated: commits.truncated,
              mergeBaseSha,
            };
          },
        },
        args,
      ),
    disposers: [],
  };

  // Ordinary-user control plane. Preparation is read-only; session/worktree
  // allocation starts only after a one-use host-attested confirmation.
  const controlRepository = new ControlRepository(state.db);
  const autonomousEngine = new AutonomousControlEngine({
    repository: controlRepository,
    ownerId: `runtime:${process.pid}:${Date.now()}`,
    leaseTtlMs: 5 * 60_000,
  });
  const controlMergeProvider = {
    inspect: async ({ repository, prNumber }: { repository: string; prNumber: number }) => {
      const run = state.db.prepare(`SELECT requester_id FROM control_runs WHERE id = (
        SELECT run_id FROM control_proposals WHERE pr_number = ? AND run_id IN (SELECT id FROM control_runs WHERE repository = ?)
      )`).get(prNumber, repository) as { requester_id?: string } | undefined;
      if (!run?.requester_id) throw new Error("Control requester is unavailable");
      const { route, token: ghToken } = await resolveBoundControlCredential(repository, prNumber, run.requester_id);
      const pr = await getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
      const ci = await getCiSnapshot({ repoFullName: repository, sha: pr.headSha, ghToken, apiBase: route.apiBase });
      const proposal = state.db.prepare(`SELECT p.*, r.base_ref, r.policy_digest, r.authority_envelope_json, s.published_at
        FROM control_proposals p JOIN control_runs r ON r.id=p.run_id LEFT JOIN sessions s ON s.id=p.run_id WHERE p.pr_number=? AND r.repository=?`).get(prNumber, repository) as Record<string, unknown>;
      const latest = state.db.prepare(`SELECT input_json FROM control_readiness_attestations WHERE run_id=? ORDER BY generation DESC LIMIT 1`).get(String(proposal.run_id)) as { input_json: string };
      const prior = JSON.parse(latest.input_json) as import("./control/readiness.js").PrReadinessInput;
      return {
        repository,
        baseRef: pr.baseBranch,
        prNumber,
        headSha: pr.headSha,
        open: pr.state === "open" && !pr.merged,
        merged: pr.merged,
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
            status: (ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : ci.state === "pending" ? "pending" : "indeterminate") as "success" | "failure" | "pending" | "indeterminate",
          },
        },
      };
    },
    merge: async ({ repository, prNumber, expectedHeadSha }: { repository: string; prNumber: number; expectedHeadSha: string; idempotencyKey: string }) => {
      const run = state.db.prepare(`SELECT requester_id FROM control_runs WHERE id = (
        SELECT run_id FROM control_proposals WHERE pr_number = ? AND run_id IN (SELECT id FROM control_runs WHERE repository = ?)
      )`).get(prNumber, repository) as { requester_id?: string } | undefined;
      if (!run?.requester_id) throw new Error("Control requester is unavailable");
      const { token: ghToken } = await resolveBoundControlCredential(repository, prNumber, run.requester_id);
      const merged = await mergePullRequest({ repoFullName: repository, prNumber, ghToken, method: "squash", expectedHeadSha });
      if (!merged.merged || !merged.sha) throw new Error(merged.message || "Provider did not merge the pull request");
      return { mergeSha: merged.sha };
    },
    verifyMerged: async ({ repository, prNumber, mergeSha }: { repository: string; prNumber: number; mergeSha: string }) => {
      const run = state.db.prepare(`SELECT requester_id FROM control_runs WHERE id = (
        SELECT run_id FROM control_proposals WHERE pr_number = ? AND run_id IN (SELECT id FROM control_runs WHERE repository = ?)
      )`).get(prNumber, repository) as { requester_id?: string } | undefined;
      if (!run?.requester_id) return false;
      const { route, token: ghToken } = await resolveBoundControlCredential(repository, prNumber, run.requester_id);
      const pr = await getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
      return pr.merged && mergeSha.length >= 40;
    },
  };
  const internalMergeService = new InternalMergeService(state.db, controlRepository, controlMergeProvider);
  const controlCredentialRoute = (route: ReturnType<typeof pat.resolve>): string => JSON.stringify({
    provider: route.provider,
    credentialService: route.credentialService,
    apiBase: route.apiBase,
    provenance: route.provenance,
    person: route.person ?? null,
    commitIdentity: route.commitIdentity,
    tokenPointer: route.tokenPointer?.env ? { env: route.tokenPointer.env }
      : route.tokenPointer?.vault ? { vault: route.tokenPointer.vault }
      : route.tokenPointer?.value ? { inlineDigest: createHash("sha256").update(route.tokenPointer.value).digest("hex") }
      : null,
  });
  const controlCredentialRouteDigest = (route: ReturnType<typeof pat.resolve>): string =>
    createHash("sha256").update(JSON.stringify(controlCredentialRoute(route))).digest("hex");
  const resolveBoundControlCredential = async (repository: string, prNumber: number, requesterId: string) => {
    const proposal = state.db.prepare(`SELECT p.credential_route_digest FROM control_proposals p JOIN control_runs r ON r.id=p.run_id WHERE p.pr_number=? AND r.repository=? AND r.requester_id=?`).get(prNumber, repository, requesterId) as { credential_route_digest?: string } | undefined;
    if (!proposal?.credential_route_digest) throw new Error("credential_route_binding_missing");
    const route = pat.resolve({ slackUserId: requesterId, gitHubUser: repository.split("/")[0]!, repoFullName: repository });
    if (controlCredentialRouteDigest(route) !== proposal.credential_route_digest) {
      const run = state.db.prepare(`SELECT r.id,r.state,r.version FROM control_runs r JOIN control_proposals p ON p.run_id=r.id WHERE p.pr_number=? AND r.repository=?`).get(prNumber, repository) as { id:string;state:string;version:number } | undefined;
      if (run && (run.state === "pr_ready" || run.state === "awaiting_merge")) controlRepository.transition({ runId: run.id, expectedVersion: run.version, to: "failed", actor: "credential_guard", reason: "credential_route_changed", terminalCode: "credential_escalation", at: Date.now() });
      throw new Error("credential_route_changed");
    }
    return { route, token: await resolveGitToken(route) };
  };
  runtime.controlPlane = new ControlPlaneService({
    db: state.db,
    repository: controlRepository,
    engine: autonomousEngine,
    mergeService: internalMergeService,
    crystallise: runtime.crystallise,
    maximumBudgetUsd: config.budgets?.session_hard_ceiling_usd,
    maximumTimeSeconds: config.loop?.session_hard_timeout_seconds,
    maximumCycles: config.loop?.max_cycles,
    maximumRetries: Math.max(1, config.loop?.worker_protocol_max_attempts ?? 1) + (config.loop?.worker_timeout_retry_enabled === false ? 0 : 1),
    resolveRepository: async ({ repository, baseRef, actorIdentity }) => {
      const ref = baseRef?.trim() || config.repos?.default_base_branch || "main";
      const route = pat.resolve({ slackUserId: actorIdentity, gitHubUser: repository.split("/")[0]!, repoFullName: repository });
      const token = await resolveGitToken(route);
      const apiBase = route.apiBase ?? "https://api.github.com";
      const response = await fetch(`${apiBase}/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "openclaw-agent-harness/control-plane" },
      });
      if (!response.ok) throw new Error(`Unable to resolve ${repository}@${ref} (${response.status})`);
      const payload = await response.json() as { sha?: string };
      if (!payload.sha || !/^[a-f0-9]{40,64}$/i.test(payload.sha)) throw new Error("Repository base revision was not returned by the provider");
      return { repositoryIdentity: repository.toLowerCase(), baseRef: ref, baseRevision: payload.sha.toLowerCase(), credentialRoute: controlCredentialRoute(route),
        policyDigest: createHash("sha256").update(JSON.stringify({ contract: "control-plane-contract/v2", allowedRepos: config.repos?.allowed ?? [], baseRef: ref })).digest("hex"), securityClass: "medium" as const };
    },
    executeEngine: async (change) => {
      change.assertCurrent();
      let route = pat.resolve({ slackUserId: change.actorIdentity, gitHubUser: change.repositoryIdentity.split("/")[0]!, repoFullName: change.repositoryIdentity });
      const currentRouteDigest = controlCredentialRouteDigest(route);
      if (currentRouteDigest !== change.credentialRouteDigest) {
        const run = controlRepository.getRun(change.changeId);
        if (!run) throw new Error("credential_escalation");
        autonomousEngine.decide(change.changeId, change.lease, {
          kind: "implementation_choice",
          request: {
            requesterId: run.requesterId,
            conversationId: run.conversationId,
            repository: run.repository,
            baseRef: run.baseRef,
            briefDigest: run.briefDigest,
            policyDigest: run.policyDigest,
            nonce: run.authorityEnvelope.nonce,
            action: "implement",
            projectedBudgetUsd: 0,
            projectedActiveTimeMs: 0,
            projectedCycles: 0,
            projectedRetries: 0,
            credentialChange: true,
            now: Date.now(),
          },
        });
        throw new Error("credential_escalation");
      }
      const controlRun = controlRepository.getRun(change.changeId);
      if (!controlRun) throw new Error("authority_violation");
      const authorize = (check: import("./orchestrator/legacy-loop.js").ConfirmedControlAuthorityCheck): void => {
        change.assertCurrent();
        route = pat.resolve({ slackUserId: change.actorIdentity, gitHubUser: change.repositoryIdentity.split("/")[0]!, repoFullName: change.repositoryIdentity });
        const observedRouteDigest = controlCredentialRouteDigest(route);
        const credentialChange = observedRouteDigest !== change.credentialRouteDigest;
        const decision = autonomousEngine.decide(change.changeId, change.lease, {
          kind: check.kind,
          request: {
            requesterId: controlRun.requesterId,
            conversationId: controlRun.conversationId,
            repository: controlRun.repository,
            baseRef: controlRun.baseRef,
            briefDigest: controlRun.briefDigest,
            policyDigest: controlRun.policyDigest,
            nonce: controlRun.authorityEnvelope.nonce,
            action: check.action,
            paths: check.paths ?? [],
            projectedBudgetUsd: check.projectedBudgetUsd,
            projectedActiveTimeMs: check.projectedActiveTimeMs,
            projectedCycles: check.projectedCycles,
            projectedRetries: check.projectedRetries,
            credentialChange,
            now: Date.now(),
          },
        });
        if (decision.outcome === "terminate") throw new Error(decision.code);
      };
      const boundProviderCredential = async (action: "test"|"push_feature_branch"|"open_pull_request"|"update_pull_request", kind: import("./orchestrator/legacy-loop.js").ConfirmedControlAuthorityCheck["kind"] = "verification_retry") => {
        authorize({ kind, action, paths: [], projectedBudgetUsd: Number((state.db.prepare(`SELECT cost_usd FROM sessions WHERE id=?`).get(change.changeId) as {cost_usd?:number}|undefined)?.cost_usd ?? 0), projectedActiveTimeMs: Math.max(0,Date.now()-controlRun.createdAt), projectedCycles: Number((state.db.prepare(`SELECT cycles_ran FROM sessions WHERE id=?`).get(change.changeId) as {cycles_ran?:number}|undefined)?.cycles_ran ?? 0), projectedRetries: 0 });
        const boundRoute = pat.resolve({ slackUserId: change.actorIdentity, gitHubUser: change.repositoryIdentity.split("/")[0]!, repoFullName: change.repositoryIdentity });
        if (controlCredentialRouteDigest(boundRoute) !== change.credentialRouteDigest) throw new Error("credential_escalation");
        route = boundRoute;
        return { route: boundRoute, token: await resolveGitToken(boundRoute) };
      };
      authorize({ kind: "implementation_choice", action: "implement", paths: [], projectedBudgetUsd: 0, projectedActiveTimeMs: 0, projectedCycles: 0, projectedRetries: 0 });
      const now = Date.now();
      const controlledBrief: CrystallisedBrief = { ...change.brief, repoHint: change.repositoryIdentity, filesLikelyTouched: [...change.scope], outOfScope: [...change.excludedScope],
        acceptanceCriteria: [...change.brief.acceptanceCriteria, `Immutable base revision: ${change.baseRevision}`, `Maximum active time: ${change.timeLimitSeconds} seconds`] };
      state.db.prepare(`INSERT OR IGNORE INTO sessions (id,slack_thread,slack_channel,requester,requester_gh,repo,branch,worktree_path,status,crystallised_prompt,created_at,updated_at,budget_usd,cost_usd,cycles_ran,estimated_usd,hard_timeout_seconds,plan_base_sha,minimum_runtime_version) VALUES (?,?,'',?,?,?,'','','planning',?,?,?,?,0,0,?,?,?,?,?)`)
        .run(change.changeId, `control:${change.changeId}`, change.actorIdentity, change.actorIdentity, change.repositoryIdentity, JSON.stringify(controlledBrief), now, now, change.budgetUsd, change.budgetUsd, change.timeLimitSeconds, change.baseRevision, PLUGIN_VERSION.pluginVersion);
      change.assertCurrent();
      const existingSession = state.db.prepare(`SELECT status,pr_number,final_pr_url,published_sha,published_at FROM sessions WHERE id=?`).get(change.changeId) as
        { status: string; pr_number: number | null; final_pr_url: string | null; published_sha: string | null; published_at:number|null } | undefined;
      const terminalLegacyPublication = existingSession && ["done","failed","aborted","accounting_incomplete"].includes(existingSession.status) && existingSession.pr_number && existingSession.final_pr_url && existingSession.published_sha && existingSession.published_at;
      const outcome = terminalLegacyPublication
        ? { status: "shipped" as const, sessionId: change.changeId, prUrl: existingSession.final_pr_url ?? undefined, cycles: 0, totalCostUsd: 0 }
        : await runtime.loop.runConfirmedControl(change.changeId, controlledBrief, authorize, async (action) => {
          authorize({ kind: "implementation_choice", action, paths: [], projectedBudgetUsd: Number((state.db.prepare(`SELECT cost_usd FROM sessions WHERE id=?`).get(change.changeId) as {cost_usd?:number}|undefined)?.cost_usd ?? 0), projectedActiveTimeMs: Math.max(0, Date.now()-controlRun.createdAt), projectedCycles: Number((state.db.prepare(`SELECT cycles_ran FROM sessions WHERE id=?`).get(change.changeId) as {cycles_ran?:number}|undefined)?.cycles_ran ?? 0), projectedRetries: 0 });
          const freshRoute = pat.resolve({ slackUserId: change.actorIdentity, gitHubUser: change.repositoryIdentity.split("/")[0]!, repoFullName: change.repositoryIdentity });
          if (controlCredentialRouteDigest(freshRoute) !== change.credentialRouteDigest) throw new Error("credential_escalation");
          return { provider: freshRoute.provider, apiBase: freshRoute.apiBase, token: await resolveGitToken(freshRoute) };
        });
      change.assertCurrent();
      if (outcome.status !== "shipped") throw new Error(`autonomous_terminal:${outcome.status}`);
      const row = state.db.prepare(`SELECT pr_number,final_pr_url,published_sha,published_at,cost_usd,created_at,updated_at,merge_recommendation,deploy_status FROM sessions WHERE id=?`).get(change.changeId) as Record<string, unknown>;
      const review = state.db.prepare(`SELECT verdict,findings FROM reviews WHERE session_id=? ORDER BY cycle DESC LIMIT 1`).get(change.changeId) as { verdict?: string; findings?: string } | undefined;
      if (!row.pr_number || !row.published_sha) throw new Error("publication_evidence_missing");
      authorize({
        kind: "verification_retry",
        action: "test",
        paths: [],
        projectedBudgetUsd: Number(row.cost_usd),
        projectedActiveTimeMs: Number(row.updated_at)-Number(row.created_at),
        projectedCycles: Number((state.db.prepare(`SELECT cycles_ran FROM sessions WHERE id=?`).get(change.changeId) as { cycles_ran?: number } | undefined)?.cycles_ran ?? 0),
        projectedRetries: 0,
      });
      const prCredential = await boundProviderCredential("test");
      const pr = await getPullRequest({ repoFullName: change.repositoryIdentity, prNumber: Number(row.pr_number), ghToken: prCredential.token, apiBase: prCredential.route.apiBase });
      const ciCredential = await boundProviderCredential("test");
      const ci = await getCiSnapshot({ repoFullName: change.repositoryIdentity, sha: pr.headSha, ghToken: ciCredential.token, apiBase: ciCredential.route.apiBase });
      const findings = review?.findings ? JSON.parse(review.findings) as ReviewFinding[] : [];
      const pullRequestFiles: Array<{ filename: string; status: string; patch?: string }> = [];
      const apiBase = route.apiBase ?? "https://api.github.com";
      for (let page = 1; page <= 30; page += 1) {
        const filesCredential = await boundProviderCredential("test");
        const response = await fetch(`${apiBase}/repos/${change.repositoryIdentity}/pulls/${Number(row.pr_number)}/files?per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${filesCredential.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "openclaw-agent-harness/control-plane" },
        });
        if (!response.ok) throw new Error(`pull_request_files_unavailable:${response.status}`);
        const pageFiles = await response.json() as Array<{ filename?: string; status?: string; patch?: string }>;
        if (!Array.isArray(pageFiles)) throw new Error("pull_request_files_invalid");
        for (const file of pageFiles) {
          if (!file.filename || !file.status) throw new Error("pull_request_file_evidence_incomplete");
          pullRequestFiles.push({ filename: file.filename, status: file.status, ...(typeof file.patch === "string" ? { patch: file.patch } : {}) });
        }
        if (pageFiles.length < 100) break;
        if (page === 30) throw new Error("pull_request_files_pagination_exceeded");
      }
      const changedPaths = [...new Set(pullRequestFiles.map((file) => file.filename))];
      const probeRows = state.db.prepare(`WITH ranked AS (
        SELECT verification_status,commit_sha,ended_at,ROW_NUMBER() OVER (PARTITION BY cycle,seq ORDER BY attempt DESC) AS rank
        FROM sub_task_attempts WHERE session_id=?
      ) SELECT verification_status,commit_sha,ended_at FROM ranked WHERE rank=1`).all(change.changeId) as Array<{ verification_status: string | null; commit_sha: string | null; ended_at:number }>;
      const completedProbes = probeRows.filter((item) => item.verification_status === "passed").length;
      const indeterminateProbes = probeRows.filter((item) => item.verification_status !== "passed" && item.verification_status !== "failed").length;
      const hasSecurityFinding = findings.some((finding) => /secret|credential|security/i.test(JSON.stringify(finding)));
      const secretScanComplete = pullRequestFiles.every((file) => file.status === "removed" || typeof file.patch === "string");
      const secretScan = scanPatchForSecrets(pullRequestFiles.map((file) => file.patch ?? "").join("\n"));
      const publicationObservedAt = Number(row.published_at);
      state.audit("control.pr_diff_observed", { sessionId: change.changeId, sha: pr.headSha, paths: changedPaths, prNumber: Number(row.pr_number) }, change.changeId);
      const securityReceipt = state.db.prepare(`INSERT INTO control_security_receipts (run_id,sha,complete,detected,observed_at) VALUES (?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)) RETURNING sha,complete,detected,observed_at`).get(change.changeId,pr.headSha,secretScanComplete?1:0,secretScan.found?1:0) as {sha:string;complete:number;detected:number;observed_at:number}|undefined;
      const securityReceiptExact = !!securityReceipt && securityReceipt.sha === pr.headSha && Boolean(securityReceipt.complete) === secretScanComplete && Boolean(securityReceipt.detected) === secretScan.found;
      state.audit("control.secret_scan_observed", { sessionId: change.changeId, sha: pr.headSha, complete: secretScanComplete, detected: secretScan.found, observedAt: securityReceipt?.observed_at }, change.changeId);
      const providerReceipt = state.db.prepare(`SELECT role,MAX(ended_at) AS observed_at FROM provider_calls WHERE session_id=? AND status='completed' AND ended_at IS NOT NULL GROUP BY role`).all(change.changeId) as Array<{role:string;observed_at:number}>;
      const shippedReceipt = state.db.prepare(`SELECT created_at,payload FROM audit_log WHERE session_id=? AND event='loop.shipped' ORDER BY id DESC LIMIT 1`).get(change.changeId) as {created_at:number;payload:string}|undefined;
      const operationReceipts: import("./control/readiness.js").OperationReceipt[] = [];
      const workerReceipt = providerReceipt.find((receipt) => receipt.role === "worker");
      if (changedPaths.length > 0 && workerReceipt) operationReceipts.push({ operation: "implement", observedAt: workerReceipt.observed_at, source: "provider_calls:worker" });
      const testReceipt = providerReceipt.filter((receipt) => receipt.role === "adversary").sort((a,b)=>b.observed_at-a.observed_at)[0];
      if (completedProbes > 0 && testReceipt) operationReceipts.push({ operation: "test", observedAt: Math.max(testReceipt.observed_at,...probeRows.filter((item)=>item.verification_status==="passed").map((item)=>item.ended_at)), source: "provider_calls+sub_task_attempts" });
      const exactCommitReceipt = probeRows.filter((item)=>item.commit_sha===String(row.published_sha)).sort((a,b)=>b.ended_at-a.ended_at)[0];
      if (row.published_sha && Number.isFinite(publicationObservedAt) && publicationObservedAt > 0) {
        operationReceipts.push({ operation: "commit", observedAt: exactCommitReceipt?.ended_at ?? publicationObservedAt, sha: String(row.published_sha), source: exactCommitReceipt ? "sub_task_attempts" : "sessions.publication" });
        operationReceipts.push({ operation: "push_feature_branch", observedAt: publicationObservedAt, sha: String(row.published_sha), source: "sessions.publication" });
      }
      if (row.pr_number && row.final_pr_url && shippedReceipt) operationReceipts.push({ operation: "open_pull_request", observedAt: shippedReceipt.created_at, sha: String(row.published_sha), source: "audit_log:loop.shipped" });
      const runtimeReceipt = state.db.prepare(`SELECT created_at,payload FROM audit_log WHERE session_id=? AND event='loop.preview_runtime' ORDER BY id DESC LIMIT 1`).get(change.changeId) as {created_at:number;payload:string}|undefined;
      let runtimeEvidence: import("./control/readiness.js").DeterminateEvidence = { status: config.vercel?.enabled ? "indeterminate" : "not_required" };
      if (config.vercel?.enabled && runtimeReceipt) { try { const measured=JSON.parse(runtimeReceipt.payload) as {headSha?:string;status?:string}; runtimeEvidence=measured.status==="ok"&&measured.headSha===String(row.published_sha)?{status:"pass",sha:measured.headSha,observedAt:runtimeReceipt.created_at}:{status:measured.status==="build_failed"?"fail":"indeterminate",sha:measured.headSha,observedAt:runtimeReceipt.created_at}; } catch { runtimeEvidence={status:"indeterminate"}; } }
      const operationsPerformed = operationReceipts.map((receipt)=>receipt.operation);
      return {
        finalVerdict: review?.verdict === "pass" && row.merge_recommendation === "merge" ? "pass" : review?.verdict === "block" ? "block" : "revise",
        blockingFindings: findings.filter((f) => blocksMerge(f, classifyFinding(f, { repoHasTestScript: true, hasDeclaredGenerators: !resolveGenerators(config.verify?.generators).empty }))).length,
        reviewCompleted: !!review,
        verificationProbes: { completed: completedProbes, required: probeRows.length, indeterminate: indeterminateProbes },
        candidateSha: String(row.published_sha), publication: { sha: String(row.published_sha), observedAt: publicationObservedAt },
        pullRequest: { repository: change.repositoryIdentity, baseRef: pr.baseBranch, headSha: pr.headSha, open: pr.state === "open" && !pr.merged, number: Number(row.pr_number), url: String(row.final_pr_url) },
        expectedRepository: change.repositoryIdentity, expectedBaseRef: change.baseRef,
        requiredCi: { registered: ci.statusReadable && ci.checksReadable && ci.checkNames.length > 0, requiredChecks: ci.checkNames, successfulChecks: ci.state === "success" ? ci.checkNames : [], sha: pr.headSha,
          status: ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : ci.state === "pending" ? "pending" : "indeterminate" },
        runtimeEvidence,
        securityEvidence: { status: !securityReceiptExact || !secretScanComplete ? "indeterminate" : review?.verdict === "pass" && !hasSecurityFinding && !secretScan.found ? "pass" : "fail", sha: String(row.published_sha), ...(securityReceiptExact ? { observedAt: securityReceipt!.observed_at } : {}) }, elapsedTimeMs: Number(row.updated_at)-Number(row.created_at), timeLimitMs: change.timeLimitSeconds*1000, readinessTimeoutMs: config.control.readiness_timeout_seconds*1000,
        changedPaths, allowedScope: change.scope, excludedScope: change.excludedScope,
        operationsPerformed, operationReceipts, allowedOperations: ["implement","retry","repair","test","commit","push_feature_branch","open_pull_request","update_pull_request","deploy"],
        credentialRouteDigest: controlCredentialRouteDigest(route), expectedCredentialRouteDigest: change.credentialRouteDigest,
        secretExposure: { detected: secretScan.found, evidence: !secretScanComplete ? "indeterminate" : secretScan.found ? "fail" : "pass" }, spendUsd: Number(row.cost_usd), budgetUsd: change.budgetUsd,
      };
    },
  });
  runtime.disposers.push(() => runtime.controlPlane?.dispose());

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
    for (const d of disposeOkfHooks) runtime.disposers.push(d);
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
  const messageHandler = async (event: unknown) => {
    const slackEvt = event as { channel?: { provider?: string }; payload?: SlackMessageEvent } | undefined;
    if (!slackEvt?.payload) return;
    if (slackEvt.channel?.provider !== "slack") return;
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
    api.logger.warn(
      "[harness] slack.listener_enabled was removed in beta.133 and has been IGNORED since beta.34, " +
        "when the Slack listener was deleted. The harness is tool-driven only (drive it via " +
        "harness_run / harness_start_session / harness_merge_pr). Remove this config key.",
    );
  } else {
    api.logger.info(
      "[harness] tool-driven mode -- the harness does NOT listen to Slack. " +
        "Drive it via harness_run / harness_start_session / harness_merge_pr tools.",
    );
  }

  // v2.0.0: parallel sub-task dispatch is gone. Warn rather than refuse: a
  // config naming these keys is not wrong, it is old, and refusing it would
  // take the plugin offline over a setting that no longer does anything.
  const removedParallelKeys = declaresRemovedParallelKeys(rawConfig);
  if (removedParallelKeys.length > 0) {
    api.logger.warn(
      `[harness] loop.${removedParallelKeys.join(", loop.")} ` +
        `${removedParallelKeys.length === 1 ? "was" : "were"} removed in v2.0.0 and ${removedParallelKeys.length === 1 ? "is" : "are"} now IGNORED. ` +
        "Sub-tasks run one at a time, in the session worktree. " +
        `Remove ${removedParallelKeys.length === 1 ? "this key" : "these keys"} from your config.`,
    );
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
  } catch (err) {
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
          gitHubUser: owner!,
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
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
    } else {
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
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      try {
        const r = pruneRetention(state, {
          auditRetentionDays: config.storage.audit_retention_days,
          pruneTerminalSessions: config.storage.prune_terminal_sessions,
          pruneTerminalSessionsDays: config.storage.prune_terminal_sessions_days,
        });
        api.logger.info("[harness] retention nightly prune", r);
      } catch (err) {
        api.logger.warn("[harness] retention nightly prune failed", { err: String(err) });
      }
    };
    if (api.registerService) {
      const dispose = api.registerService({
        id: `${PLUGIN_ID}:retention-nightly`,
        start: () => { timer = setInterval(tick, dayMs); },
        stop: () => { if (timer) clearInterval(timer); timer = undefined; },
      });
      runtime.disposers.push(async () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
    } else {
      timer = setInterval(tick, dayMs);
      runtime.disposers.push(() => { if (timer) clearInterval(timer); timer = undefined; });
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
    let timer: NodeJS.Timeout | undefined;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return; // never overlap sweeps
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
        stop: () => { if (timer) clearInterval(timer); timer = undefined; },
      });
      runtime.disposers.push(async () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
    } else {
      timer = setInterval(tick, sweepMs);
      runtime.disposers.push(() => { if (timer) clearInterval(timer); timer = undefined; });
    }
  }

  currentRuntime = runtime;
  setCurrentRuntime(runtime as unknown as import("./runtime-registry.js").RuntimeLike);
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
export async function bootstrapHarnessAsync(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void> {
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
  } catch (err) {
    api.logger.warn("[harness] budget coherence check threw (non-fatal)", { err: String(err) });
  }

  // Legacy reaction polling and native progress delivery are retired.

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
    // rc.2: only the roles that actually run on Anthropic. This used to read
    // `config.models.*` for all four roles unconditionally, so an install with
    // every role moved to OpenCode/OpenRouter still got startup warnings and a
    // `harness.model_pricing_unpriced` audit naming Claude ids that nothing was
    // going to call. Operators reasonably read that as "the harness is still on
    // Claude". The check is about Anthropic pricing; ask it only about roles
    // priced against Anthropic.
    const routes = runtime.effectiveBackendRoutes ?? [];
    const anthropicRoutes = routes.filter((r) => r.backend === "claude-code");
    const configuredModels = [...new Set(anthropicRoutes.map((r) => r.model).filter((m): m is string => Boolean(m)))];
    if (configuredModels.length === 0) {
      // Deliberately not an early `return`: this runs inline in bootstrap, and
      // returning here would skip every step below it.
      api.logger.info("[harness] model pricing health: no role runs on Anthropic; skipping the Anthropic price check.", {
        roles: routes.map((r) => `${r.role}=${r.backend}:${r.model ?? "(default)"}`),
      });
    } else {
      const apiKey = await runtime.anthropicApiKey();
      const liveIds = apiKey ? await fetchLiveModelIds(apiKey) : null;
      const health = assessModelPricingHealth(configuredModels, liveIds, config.models.price_overrides);
      const unpriced = health.filter((h) => h.unpriced).map((h) => h.model);
      const notLive = health.filter((h) => h.notLive === true).map((h) => h.model);
      if (unpriced.length > 0) {
        api.logger.warn(
          "[harness] model pricing health: configured model(s) have NO price-table entry; budget projections fall back to the most-expensive tier. Add harness.models.price_overrides for accurate budgeting.",
          { unpriced },
        );
        // rc.2: name the roles, so "which model is this about" does not require
        // cross-referencing the config by hand.
        state.audit("harness.model_pricing_unpriced", {
          unpriced,
          notLive,
          anthropicRoles: anthropicRoutes.map((r) => `${r.role}=${r.model ?? "(default)"}`),
        }, "");
      }
      if (notLive.length > 0) {
        api.logger.warn(
          "[harness] model pricing health: configured model(s) not found in the live Anthropic /v1/models list; the id may be renamed or deprecated.",
          { notLive },
        );
      }
      if (liveIds === null) {
        api.logger.info("[harness] model pricing health: /v1/models unreachable (no key or network); using static price table.");
      }
    }
  } catch (err) {
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
        } catch {
          return false;
        }
      },
      getuid: () => (typeof process.getuid === "function" ? process.getuid() : null),
    });
    if (pf.ok) {
      if (pf.created) {
        api.logger.info("[harness] worktrees root created (node-owned)", { worktreesRoot: pf.worktreesRoot });
      }
      /*
       * rc.9: say what was actually checked, and what was NOT.
       *
       * The rc.8 event was `{ok:true, created:false}` on a tmpfs root that had
       * just lost nine commits. It was not lying -- it means "I wrote a probe
       * file here and it worked" -- but `ok` reads as a verdict on the storage,
       * and an operator scanning startup evidence took it as one. So the field
       * now says what it measured, and durability is reported separately, with
       * `undefined` meaning UNKNOWN rather than fine.
       */
      const { probeStorage, checkpointRootIsSafe } = await import("./state/storage-health.js");
      const probe = probeStorage(pf.worktreesRoot);
      state.audit("harness.worktrees_preflight", {
        writable: true,
        ok: true, // retained: existing dashboards and tests key off it
        created: pf.created,
        worktreesRoot: pf.worktreesRoot,
        fsType: probe.fsType ?? "unknown",
        volatile: probe.volatile ?? null, // null = could not determine, NOT "durable"
        separateMount: probe.separateMount ?? null,
        note: probe.note ?? null,
      });
      if (probe.volatile) {
        api.logger.warn(
          `[harness] worktrees root is on ${probe.fsType}, which does not survive a restart -- ` +
            `worktrees AND the bare object cache nested under it are lost on every container bounce`,
          { worktreesRoot: pf.worktreesRoot },
        );
        state.audit("harness.worktrees_root_volatile", {
          worktreesRoot: pf.worktreesRoot,
          fsType: probe.fsType,
          detail: probe.note,
        });
      }
      const ckRoot = (config.storage.checkpoint_root ?? "").replace(/^~/, process.env.HOME ?? "");
      const ckSafe = checkpointRootIsSafe(ckRoot, pf.worktreesRoot);
      if (!ckSafe.ok) {
        // Not fatal -- a deployment may legitimately choose to run without
        // durable checkpoints -- but it is never silent, because "nobody
        // configured it" and "it is working" looked identical in rc.8.
        api.logger.warn(`[harness] durable checkpointing is NOT active: ${ckSafe.reason}`);
        state.audit("harness.checkpoint_root_unusable", { checkpointRoot: ckRoot || null, reason: ckSafe.reason });
      } else {
        state.audit("harness.checkpoint_root_ready", { checkpointRoot: ckRoot });
      }
    } else {
      // BLOCKING diagnostic: a run WILL die with EACCES until this is fixed.
      api.logger.error(`[harness] ${pf.message}`, { worktreesRoot: pf.worktreesRoot, uid: pf.uid, chownCommand: pf.chownCommand });
      state.audit("harness.worktrees_root_not_writable", {
        worktreesRoot: pf.worktreesRoot,
        uid: pf.uid,
        chownCommand: pf.chownCommand,
      });
    }
  } catch (err) {
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
    const protectedWorktreePaths: string[] = [];
    if (liveSessionIds.length > 0) {
      try {
        const placeholders = liveSessionIds.map(() => "?").join(",");
        const liveRows = state.db
          .prepare(`SELECT worktree_path FROM sessions WHERE id IN (${placeholders})`)
          .all(...liveSessionIds) as Array<{ worktree_path: string | null }>;
        // NOTE: worktree_path is '' (empty) at session INSERT and only gets the
        // real pending-<ts> path at loop.ts:481 AFTER the lead plan completes.
        // During that planning window Guard 1 (path) can't match -- Guard 2
        // (mtime grace window) is the primary protection then. Skip empties.
        for (const r of liveRows) if (r.worktree_path && r.worktree_path.trim()) protectedWorktreePaths.push(r.worktree_path);
      } catch (err) {
        api.logger.warn("[harness] worktree-heal: failed to resolve live session worktrees", { err: String(err) });
      }
    }
    // beta.55 (B2): a session paused in `awaiting_clarification` is NOT running
    // (its loop returned), so runningSessionIds() misses it -- but its worktree
    // MUST survive so a trusted host confirmation can re-drive in place. Add those paths to
    // the protect set explicitly.
    try {
      const pausedRows = state.db
        .prepare(`SELECT worktree_path FROM sessions WHERE status = 'awaiting_clarification'`)
        .all() as Array<{ worktree_path: string | null }>;
      for (const r of pausedRows) if (r.worktree_path && r.worktree_path.trim()) protectedWorktreePaths.push(r.worktree_path);
    } catch (err) {
      api.logger.warn("[harness] worktree-heal: failed to resolve awaiting_clarification worktrees", { err: String(err) });
    }
    // beta.57 (P3): paths with an allocation IN FLIGHT in this process. These
    // have no session row / worktree_path yet; before this the only shield
    // was the 2-minute mtime grace window, which a slow `npm ci` bootstrap
    // could outlive -- letting a concurrent heal reap a mid-allocation dir.
    try {
      const { inFlightWorktreePaths } = await import("./adapters/git-worktree.js");
      protectedWorktreePaths.push(...inFlightWorktreePaths());
    } catch (err) {
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
        } catch {
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
    } catch (err) {
      api.logger.warn("[harness] worktree heal audit emit failed", { err: String(err) });
    }
  } catch (err) {
    api.logger.warn("[harness] worktree self-heal on start failed", { err: String(err) });
    try {
      state.audit("harness.worktree_heal_failed", { error: String(err) });
    } catch {
      // If audit itself is broken, log-only was already best-effort above.
    }
  }

  /*
   * rc.9: the OTHER direction.
   *
   * The self-heal above walks disk -> database and asks "should this directory
   * be reaped?". On an empty tmpfs root after a restart it scans nothing,
   * reports `{scanned:0, removed:0, errors:[]}`, and that reads as health.
   *
   * This walks database -> disk and asks the question that was never asked:
   * every row that CLAIMS live local work, does that work still exist? In the
   * incident the answer for f7c4e585 was no, for a paused session, a missing
   * worktree, a missing object store and nine missing commits -- and startup
   * finished without a word. It only ever diagnoses; it deletes nothing.
   */
  try {
    const { reconcileSessionsToDisk } = await import("./state/storage-health.js");
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const worktreesRoot = config.storage.worktree_root.replace(/^~/, process.env.HOME ?? "");
    const rows = state.db
      .prepare(
        `SELECT s.id, s.status, s.repo, s.branch, s.worktree_path,
                (SELECT group_concat(t.commit_sha) FROM sub_tasks t
                  WHERE t.session_id = s.id AND t.commit_sha IS NOT NULL AND t.commit_sha != '') AS commits
           FROM sessions s
          WHERE s.status NOT IN ('done','failed','aborted','cancelled')`,
      )
      .all() as Array<{
      id: string;
      status: string;
      repo: string;
      branch: string | null;
      worktree_path: string | null;
      commits: string | null;
    }>;

    const findings = await reconcileSessionsToDisk(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        repo: r.repo,
        branch: r.branch,
        worktreePath: r.worktree_path,
        recordedCommits: (r.commits ?? "").split(",").map((c) => c.trim()).filter(Boolean),
      })),
      {
        worktreesRoot,
        readText: (p) => readFileSync(p, "utf8"),
        unreachableCommits: async (wt, shas) =>
          shas.filter((sha) => {
            try {
              execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: wt, stdio: "ignore" });
              return false;
            } catch {
              return true;
            }
          }),
      },
    );

    const checkedAt = Date.now();
    const upd = state.db.prepare(
      `UPDATE sessions SET storage_state = ?, storage_reason = ?, storage_checked_at = ?, updated_at = ? WHERE id = ?`,
    );
    const byId = new Map(findings.map((f) => [f.sessionId, f]));
    for (const r of rows) {
      const f = byId.get(r.id);
      // Rows with no finding that were in scope are `ok`; rows out of scope
      // (terminal-ish statuses the reconciler skips) are left untouched rather
      // than being stamped with a verdict nobody computed.
      const { claimsLocalStorage } = await import("./state/storage-health.js");
      if (!claimsLocalStorage(r.status)) continue;
      upd.run(f ? f.state : "ok", f ? f.reason : null, checkedAt, checkedAt, r.id);
    }

    state.audit("harness.storage_reconcile", {
      sessionsChecked: rows.filter((r) => r.worktree_path !== null).length,
      findings: findings.length,
      states: findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.state] = (acc[f.state] ?? 0) + 1;
        return acc;
      }, {}),
    });
    for (const f of findings) {
      api.logger.error(`[harness] session ${f.sessionId}: ${f.reason}`);
      state.audit(
        "harness.session_storage_missing",
        {
          sessionId: f.sessionId,
          state: f.state,
          reason: f.reason,
          missingCommits: f.missingCommits.slice(0, 20),
          missingCommitCount: f.missingCommits.length,
        },
        f.sessionId,
      );
    }
  } catch (err) {
    // A reconciliation that cannot run must not take the harness down with it,
    // but it also must not pass as a clean result.
    api.logger.warn("[harness] storage reconciliation failed (non-fatal)", { err: String(err) });
    try {
      state.audit("harness.storage_reconcile_failed", { error: String(err) });
    } catch {
      /* audit itself broken; the log line above is the record */
    }
  }

  // Legacy session auto-resume is disabled. Canonical control dispatch recovery is owned by ControlPlaneService.

}

/**
 * Backwards-compat facade. New code should prefer
 * `bootstrapHarnessSync` + `bootstrapHarnessAsync`. Tests still call this.
 */
export async function bootstrapHarness(api: HarnessPluginApi): Promise<HarnessRuntime> {
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
function registerOkfAutoForwardHooks(
  api: HarnessPluginApi,
  runtime: HarnessRuntime,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  const cache = new OkfConceptCache();
  // Store on the runtime so tests + observability can inspect the cache.
  (runtime as unknown as { okfConceptCache?: OkfConceptCache }).okfConceptCache = cache;

  const promptBuildHandler = async (event: unknown) => {
    try {
      const evt = (event ?? {}) as {
        systemPrompt?: unknown;
        prompt?: unknown;
        messages?: unknown;
        context?: unknown;
      };
      // Aggregate all plausible text sources into one blob. Cheap; the
      // parser is regex-bounded to the OKF section header.
      const parts: string[] = [];
      if (typeof evt.systemPrompt === "string") parts.push(evt.systemPrompt);
      if (typeof evt.prompt === "string") parts.push(evt.prompt);
      if (Array.isArray(evt.messages)) {
        for (const m of evt.messages) {
          const mm = m as { content?: unknown } | undefined;
          if (mm && typeof mm.content === "string") parts.push(mm.content);
        }
      }
      const text = parts.join("\n\n");
      const concepts = parseOkfBlocksFromContext(text);
      if (concepts.length === 0) return;
      const key = cacheKeyForCtx((evt.context ?? evt) as unknown);
      if (!key) return;
      cache.set(key, concepts);
    } catch (err) {
      api.logger.warn("[harness] okf-auto-forward: prompt observer failed", { err: String(err) });
    }
  };

  const toolCallHandler = async (event: unknown) => {
    try {
      const evt = (event ?? {}) as {
        toolName?: string;
        params?: unknown;
        context?: unknown;
        ctx?: unknown;
      };
      const toolName = evt.toolName ?? "";
      if (toolName !== "harness_run" && toolName !== "harness_start_session") return;
      const key = cacheKeyForCtx((evt.context ?? evt.ctx ?? {}) as unknown);
      if (!key) return;
      const cached = cache.get(key);
      const decision = decideAutoForward({ toolName, params: evt.params, cached });
      if (!decision.inject) return;
      const rewritten = buildRewrittenParams(toolName, evt.params, decision.concepts);
      api.logger.info("[harness] okf-auto-forward: injected concepts into tool params", {
        toolName,
        sessionKey: key,
        conceptCount: decision.concepts.length,
        injectionSite: decision.injectionSite,
      });
      // eslint-disable-next-line consistent-return
      return { params: rewritten };
    } catch (err) {
      api.logger.warn("[harness] okf-auto-forward: tool-call rewriter failed", { err: String(err) });
      // Fall through: do not block the tool call on a hook bug.
    }
  };

  const on = (event: string, handler: (evt: unknown) => unknown) => {
    if (typeof api.on === "function") {
      const dispose = api.on(event, handler as (event: unknown) => unknown);
      if (typeof dispose === "function") disposers.push(dispose);
      return true;
    }
    if (typeof api.registerHook === "function") {
      const dispose = api.registerHook([event], handler as (event: unknown) => unknown, {
        name: `${PLUGIN_ID}:${event}`,
        description: `OKF auto-forward ${event} observer/rewriter`,
      });
      disposers.push(() => {
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
      return true;
    }
    return false;
  };

  const promptOk = on("before_prompt_build", promptBuildHandler);
  const toolOk = on("before_tool_call", toolCallHandler);

  if (!promptOk && !toolOk) {
    api.logger.warn(
      "[harness] okf-auto-forward: neither api.on nor api.registerHook available; auto-forward disabled",
    );
  } else if (!promptOk) {
    api.logger.warn(
      "[harness] okf-auto-forward: prompt observer could not register; auto-forward will only fire if a caller pre-populates the cache",
    );
  } else if (!toolOk) {
    api.logger.warn(
      "[harness] okf-auto-forward: tool-call rewriter could not register; parsing OKF blocks but will not inject",
    );
  } else {
    api.logger.info("[harness] okf-auto-forward: hooks registered");
  }

  return disposers;
}

/** beta.36: extract a PR/MR number from a GitHub/GitLab PR URL. */

function parsePrNumber(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)/.exec(prUrl) ?? /\/merge_requests\/(\d+)/.exec(prUrl);
  return m ? Number(m[1]) : undefined;
}

/**
 * beta.36: build the deps bundle for the post-merge deploy-repair state
 * machine. All I/O the machine needs (run a repair pipeline, verify a deploy,
 * revert merges, persist) is closed over the runtime's adapters here.
 */
function renderReviewComment(
  review: { verdict: string; findings: any[]; summary: string; costUsd?: number },
  opts: { updatedExisting: boolean; operatorGuidance?: string } = { updatedExisting: false },
): string {
  const verdict = String(review.verdict ?? "").toLowerCase();
  const emoji = verdict === "pass" ? "\u2705" : verdict === "block" ? "\u26d4" : "\u{1f501}";
  const gate =
    verdict === "pass"
      ? "No blocking findings from this review. The `harness_merge_pr` gate still applies."
      : "This review did NOT sign off (`" + verdict + "`). Address the findings below; `harness_merge_pr` will refuse a non-pass verdict.";
  const findings = review.findings ?? [];
  // The operator's steer for this revise, above the verdict it was reviewed
  // against. A revise updates an existing PR and createPullRequest only writes a
  // body on first open (beta.75), so the PR body -- which does render guidance,
  // via acceptanceCriteria -- is never rewritten for the case guidance exists
  // for. Without this the steer would be invisible on the only PR it applies to.
  const guidanceLines = opts.operatorGuidance ? ["### Operator direction", opts.operatorGuidance] : [];
  const lines = [
    `## ${emoji} Harness adversarial review \u2014 verdict: \`${review.verdict}\`${opts.updatedExisting ? " (updated PR)" : ""}`,
    ``,
    gate,
    ``,
    ...guidanceLines,
    review.summary ? review.summary : "",
    ``,
    findings.length ? `### Findings (${findings.length})` : "_No findings._",
    ...findings.map(
      (f: any) =>
        `- **${String(f.severity ?? "info").toUpperCase()}** [${f.dimension ?? "?"}] ${f.title ?? ""}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}${f.detail ? `\n  ${f.detail}` : ""}`,
    ),
    ``,
    `---`,
    `_Posted by openclaw-agent-harness${typeof review.costUsd === "number" ? ` \u2014 review cost $${review.costUsd.toFixed(2)}` : ""}. This comment is auto-generated on every review._`,
  ];
  return lines.filter((l) => l !== "" || true).join("\n");
}

function renderPrBody(
  brief: { title: string; motivation: string; acceptanceCriteria: string[] },
  review: { verdict: string; findings: any[]; summary: string },
): string {
  // beta.35 fix #3: when the run ships WITHOUT a clean adversary pass
  // (verdict !== 'pass'), the reviewer's outstanding findings -- typically
  // "no runtime evidence" ones the loop structurally cannot satisfy (no
  // in-loop preview deploy) -- become an explicit, honest PR annotation
  // instead of silently killing the run. The runtime-dimension findings in
  // particular are exactly what the post-merge Vercel deploy verification
  // (harness_merge_pr) checks for real, so we call that out: the loop
  // couldn't render it, but the merge step will verify the actual deploy.
  const shippedWithoutCleanPass = review.verdict !== "pass";
  const runtimeFindings = (review.findings ?? []).filter(
    (f: any) =>
      f?.dimension === "runtime" ||
      /runtime|preview|deploy|render/i.test(String(f?.title ?? "") + " " + String(f?.detail ?? "")),
  );
  // rc.3: a `pass` the gate manufactured from a `revise` is not the same thing
  // as a `pass` the adversary gave, and it lands on the PR looking identical.
  // Say so, because this one is auto-mergeable.
  const downgradedAnnotation = (review as { verdictDowngraded?: boolean }).verdictDowngraded
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
        ...runtimeFindings.map(
          (f: any) => `- **${(f.severity ?? "info").toUpperCase()}** [${f.dimension}] ${f.title}`,
        ),
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
    ...review.findings.map((f: any) => `- **${(f.severity ?? "info").toUpperCase()}** [${f.dimension}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  ${f.detail}`),
    ``,
    `---`,
    `_Opened by openclaw-agent-harness ${PLUGIN_VERSION.pluginVersion}._`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function teardown(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void> {
  // Wait for the async bootstrap phase to complete before tearing things
  // down. Otherwise the reactions poller could try to start after we've
  // closed the DB, or recovery could try to notify after `slack` is gone.
  if (runtime.asyncBootstrap) {
    try {
      await runtime.asyncBootstrap;
    } catch (err) {
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
  const ownedRunning = (): string[] =>
    typeof runtime.loop?.ownedRunningSessionIds === "function"
      ? runtime.loop.ownedRunningSessionIds()
      : runningSessionIds();
  // beta.82: read the freshest progress marker across the owned running
  // sessions so we can tell a LIVE-but-long loop from a WEDGED one. Best-effort
  // -- if the DB is already closed or the query throws, treat progress as
  // unknown (0), which errs toward the wedged classification (safe: a truly
  // live loop keeps advancing `updated_at`, so it will read fresh).
  const sampleProgress = (): DrainProgressSample => {
    const running = ownedRunning();
    if (running.length === 0 || !runtime.state.isOpen()) return { running, lastProgressMs: 0 };
    let lastProgressMs = 0;
    try {
      const placeholders = running.map(() => "?").join(",");
      const rows = runtime.state.db
        .prepare(
          `SELECT last_checkpoint_at, updated_at FROM sessions WHERE id IN (${placeholders})`,
        )
        .all(...running) as Array<{ last_checkpoint_at: number | null; updated_at: number | null }>;
      for (const r of rows) {
        lastProgressMs = Math.max(lastProgressMs, r.last_checkpoint_at ?? 0, r.updated_at ?? 0);
      }
    } catch {
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
    if (action.kind === "drain-complete") break;
    if (action.kind === "force-teardown") {
      forcedWedged = true;
      api.logger.warn(
        "[harness] teardown drain deadline exceeded AND owned loop(s) wedged (no progress past stuck_loop_seconds); proceeding with teardown",
        { running: sample.running, drainSeconds, stuckThresholdMs, lastProgressMs: sample.lastProgressMs },
      );
      // Observability: a wedged loop is about to have its DB closed out from
      // under it; emit a clean terminal audit per session so it does not just
      // hang in `executing` with no terminal event. Best-effort (DB may race).
      for (const sid of sample.running) {
        try {
          runtime.state.audit(
            "loop.torn_down_while_running",
            {
              sessionId: sid,
              reason: "runtime torn down (re-register churn) while loop was wedged past stuck_loop_seconds",
              drainSeconds,
              stuckThresholdMs,
            },
            sid,
          );
        } catch {
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
    } else if (action.reason === "loop-still-progressing") {
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
    } catch (err) {
      api.logger.warn("[harness] disposer failed", { err: String(err) });
    }
  }
  try {
    runtime.state.close();
  } catch (err) {
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
  register(api: unknown): void {
    // Bridge the OpenClaw SDK API to our internal HarnessPluginApi shape.
    // The SDK exposes a superset of what we consume; the fields we use
    // (`logger`, `registerTool`, `registerHook`, `registerService`,
    // `pluginConfig`, `workspaceDir`, `sendMessage`, `addReaction`,
    // `callTool`) are all present on the runtime `api` object.
    const pluginApi = api as HarnessPluginApi;
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
    let runtime: HarnessRuntime;
    try {
      runtime = bootstrapHarnessSync(pluginApi);
    } catch (err) {
      pluginApi.logger.error("[harness] sync bootstrap failed", { err: String(err) });
      throw err;
    }
    // Kick off async bootstrap; do NOT await. Store the promise so teardown
    // can await it before closing the DB.
    runtime.asyncBootstrap = bootstrapHarnessAsync(runtime, pluginApi).then(
      () => pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} async bootstrap complete`),
      (err) => {
        pluginApi.logger.error("[harness] async bootstrap failed", { err: String(err) });
      },
    );
    pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} registered (async bootstrap in flight)`);
  },
});
