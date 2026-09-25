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
import { type CredentialRecord } from "./adapters/credential-vault.js";
/** Minimal shape of the OpenClaw plugin API surface that we use. */
export interface HarnessToolContext {
    /** Authenticated identities supplied by OpenClaw, never tool arguments. */
    requesterSenderId?: string;
    /** Host-trusted active platform conversation identifier. */
    nativeChannelId?: string;
    /** Legacy/test projection retained for compatible hosts. */
    conversationId?: string;
    workspaceId?: string;
    /** Optional on hosts that project the exact inbound event id to tools. */
    hostEventId?: string;
    receivedAt?: number;
    senderIsOwner?: boolean;
    sessionKey?: string;
    sessionId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
    };
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
    registerTool: (definition: HarnessToolDefinition | ((context: HarnessToolContext) => HarnessToolDefinition), options?: {
        name?: string;
        names?: string[];
        optional?: boolean;
    }) => (() => void) | {
        dispose?: () => void;
        unregister?: () => void;
    };
    /**
     * Subscribe to a lifecycle event on the OpenClaw event bus. Same shape as
     * a Node EventEmitter; hybrid-memory uses this for `message_received`,
     * `agent_end`, etc. Returns an unsubscribe function.
     */
    on?: (event: string, handler: (event: unknown, context?: unknown) => unknown) => (() => void) | {
        dispose?: () => void;
    } | undefined;
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
declare const _default: any;
export default _default;
//# sourceMappingURL=index.d.ts.map