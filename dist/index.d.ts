/**
 * openclaw-agent-harness plugin entry.
 *
 * Exports the OpenClaw plugin descriptor. The runtime calls `register(api)`
 * once per lifecycle. We use that hook to:
 *   1. Parse plugin config (from OpenClaw config store)
 *   2. Open the state store (SQLite)
 *   3. Wire real subsystems (SDK, git, github, vercel, slack)
 *   4. Register runtime tools (harness_* namespace)
 *   5. Register cron / service (retention prune and recovery)
 *
 * Shape mirrors memory-hybrid.
 */
import type { HarnessConfig, TokenPointer } from "./config.js";
import { openStateStore } from "./state/store.js";
import { InteractionLog } from "./state/interaction-log.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { RouteOverlay } from "./auth/route-overlay.js";
import { ControlPlaneService } from "./control/service.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { type CredentialRecord } from "./adapters/credential-vault.js";
import { type EffectiveBackendRoute } from "./adapters/backend-router.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import { SlackAdapter } from "./adapters/slack.js";
import { type CrystallisedBrief } from "./crystallise/prompt-refiner.js";
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
    registerTool: (definition: HarnessToolDefinition | ((context: HarnessToolContext) => HarnessToolDefinition), options?: unknown) => (() => void) | {
        dispose?: () => void;
        unregister?: () => void;
    };
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
    registerHook?: (events: string | string[], handler: (event: unknown) => unknown, opts?: {
        name: string;
        description?: string;
    }) => (() => void) | {
        dispose?: () => void;
    };
    registerService?: (svc: {
        id: string;
        start?: () => Promise<void> | void;
        stop?: () => Promise<void> | void;
    }) => (() => void) | {
        dispose?: () => void;
    };
    /** Deprecated: retained for backwards-compat with older mock APIs. Prefer `pluginConfig`. */
    getConfig?: () => unknown;
    /** OpenClaw plugin-SDK config surface (JSON parsed from `plugins.entries[<id>].config`). */
    pluginConfig?: unknown;
    workspaceDir?: string;
    /** Optional -- for sending Slack messages. Different runtimes wire this differently. */
    sendMessage?: (input: {
        channel: string;
        threadTs?: string;
        text: string;
        blocks?: unknown[];
    }) => Promise<{
        ts: string;
    }>;
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
    set: (service: string, value: string, opts?: {
        type?: string;
        notes?: string;
    }) => void;
    delete: (service: string) => boolean;
    list: () => CredentialRecord[];
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
     * that survives worktree release + container restart. Read through operator diagnostics.
     */
    interactionLog: InteractionLog;
    slack: SlackAdapter;
    git: GitAdapter;
    creds: CredentialAdapter;
    /** beta.110: the harness-owned vault. Used by operator credential administration to store tokens. */
    vault: CredentialStore;
    /** beta.110: set when the vault could not be opened; surfaced by operator diagnostics. */
    vaultError?: string;
    /**
     * Classify + crystallise a raw request into a structured brief for the
     * internal execution path.
     * Returns a discriminated union: one confirmable `brief`, or a terminal
     * `reject` for a non-change or unsafe request. Ambiguity is resolved internally.
     */
    crystallise: (userText: string, 
    /**
     * beta.21: optional OKF concept refs pre-attached by the caller
     * (typically the OpenClaw agent's context enrichment). Pass-through
     * only; the harness does not crawl OKF itself. Concepts propagate
     * into the crystallised brief so the lead planner and workers see
     * them downstream.
     */
    concepts?: import("./crystallise/prompt-refiner.js").OkfConceptRef[]) => Promise<{
        kind: "brief";
        brief: CrystallisedBrief;
        costUsd: number;
    } | {
        kind: "reject";
        intent: "not_dev" | "unsafe";
        reason: string;
        costUsd: number;
    }>;
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
    gitToken: (r: {
        credentialService: string;
        apiKeyEnv: string;
        provider: string;
        tokenPointer?: TokenPointer;
        person?: string;
    }) => Promise<string>;
    /**
     * beta.25: preflight completeness check. Given a requester + concrete
     * repo, verify EVERYTHING the harness will need to commit + push on that
     * requester's behalf is present up front: routing entry, commit identity
     * (name + email), and a resolvable token. Returns { ok:true } or
     * { ok:false, missing:[...], message } describing exactly what to ask the
     * user for BEFORE a run starts. Never throws.
     */
    preflight: (args: {
        requester: string;
        repoFullName: string;
    }) => Promise<PreflightResult>;
    /**
     * beta.34: hard-gated PR merge + post-merge Vercel deploy verification.
     * Enforces the merge recommendation: if the session's recommendation is
     * `do_not_merge`, it REFUSES (no override; the escape hatch is the GitHub
     * UI). Otherwise re-checks CI, merges (squash), records the merge, and
     * verifies the Vercel deployment for the merge commit. Never force-merges.
     */
    mergePr: (args: {
        sessionId: string;
        authenticatedActor?: string;
        repairBudgetUsd?: number;
    }) => Promise<MergePrResult>;
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
     * Routes written by operator credential administration. The same instance the router reads,
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
         * for logging and never looks a token up by it. Operator-side credential
         * administration must use the resolved vault pointer rather than this
         * display-only name.
         */
        tokenSource?: "vault" | "env" | "value";
        vaultPointer?: string;
    } | undefined;
    disposers: Array<() => void | Promise<void>>;
    /**
     * Promise for the async bootstrap phase. Populated by `register()` once it
     * has kicked off `bootstrapHarnessAsync`; teardown awaits it before closing
     * the state DB.
     */
    asyncBootstrap?: Promise<void>;
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
/** beta.34: result of a harness_merge_change invocation. */
export interface MergePrResult {
    ok: boolean;
    /** True when the hard gate refused the merge (recommendation = do_not_merge / needs_human_review). */
    refused?: boolean;
    merged?: boolean;
    mergeSha?: string;
    recommendation?: "merge" | "do_not_merge" | "needs_human_review";
    /** Deploy verification outcome (when Vercel enabled + a merge happened). */
    deploy?: {
        status: "ready" | "error" | "pending" | "unavailable";
        detail: string;
        deploymentUrl?: string;
        logsExcerpt?: string;
    };
    /** Human-facing message summarising the outcome. */
    message: string;
}
/** rc.4: result of an operator PR-association recovery (dry run or apply). */
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
    blockers?: {
        kind: string;
        message: string;
    }[];
    /** Human-facing message summarising the outcome. */
    message: string;
}
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
export declare function bootstrapHarnessSync(api: HarnessPluginApi): HarnessRuntime;
/**
 * Asynchronous phase of plugin bootstrap. Runs as a fire-and-forget promise
 * after {@link bootstrapHarnessSync} has returned control to the OpenClaw
 * loader. Handles anything that requires network / vault I/O:
 *
 *   - session recovery and provider readiness checks
 *
 * The returned promise is stored on `runtime.asyncBootstrap` so teardown
 * can await it if it needs to (e.g. to ensure recovery notifies have
 * flushed before closing the state DB).
 */
export declare function bootstrapHarnessAsync(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void>;
/**
 * Backwards-compat facade. New code should prefer
 * `bootstrapHarnessSync` + `bootstrapHarnessAsync`. Tests still call this.
 */
export declare function bootstrapHarness(api: HarnessPluginApi): Promise<HarnessRuntime>;
declare const _default: any;
export default _default;
//# sourceMappingURL=index.d.ts.map