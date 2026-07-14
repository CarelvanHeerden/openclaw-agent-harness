/**
 * openclaw-agent-harness plugin entry.
 *
 * Exports the OpenClaw plugin descriptor. The runtime calls `register(api)`
 * once per lifecycle. We use that hook to:
 *   1. Parse plugin config (from OpenClaw config store)
 *   2. Open the state store (SQLite)
 *   3. Wire real subsystems (SDK, git, github, vercel, slack)
 *   4. Register runtime tools (harness_* namespace)
 *   5. Register Slack message hook (message.received)
 *   6. Register cron / service (retention prune, recovery, reaction poller)
 *
 * Shape mirrors memory-hybrid.
 */
import type { HarnessConfig } from "./config.js";
import { openStateStore } from "./state/store.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { SlackChannelListener } from "./slack/channel-listener.js";
import { Dispatcher } from "./slack/dispatcher.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import { SlackAdapter } from "./adapters/slack.js";
/** Minimal shape of the OpenClaw plugin API surface that we use. */
export interface HarnessPluginApi {
    registrationMode?: "cli-metadata" | "runtime";
    logger: {
        info: (msg: string, meta?: unknown) => void;
        warn: (msg: string, meta?: unknown) => void;
        error: (msg: string, meta?: unknown) => void;
        debug?: (msg: string, meta?: unknown) => void;
    };
    registerTool: (definition: {
        name: string;
        description: string;
        parameters?: unknown;
        inputSchema?: unknown;
        execute: (callIdOrInput: unknown, paramsOrCtx?: unknown, context?: unknown) => Promise<unknown> | unknown;
    }, options?: unknown) => (() => void) | {
        dispose?: () => void;
        unregister?: () => void;
    };
    registerHook?: (name: string, handler: (event: unknown) => unknown) => (() => void) | {
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
    addReaction?: (input: {
        channel: string;
        ts: string;
        name: string;
    }) => Promise<void>;
    /** Optional -- lookup for calling another plugin's tool (e.g. hybrid-memory's credential_get). */
    callTool?: (name: string, input: unknown) => Promise<unknown>;
}
export interface HarnessRuntime {
    config: HarnessConfig;
    state: Awaited<ReturnType<typeof openStateStore>>;
    budget: BudgetEnforcer;
    pat: PatRouter;
    loop: OrchestratorLoop;
    listener: SlackChannelListener;
    dispatcher: Dispatcher;
    slack: SlackAdapter;
    git: GitAdapter;
    creds: CredentialAdapter;
    disposers: Array<() => void | Promise<void>>;
    /**
     * Promise for the async bootstrap phase (reactions poller start,
     * session recovery). Populated by `register()` once it has kicked off
     * `bootstrapHarnessAsync`. Teardown awaits this to ensure recovery
     * notifications have flushed before closing the state DB.
     */
    asyncBootstrap?: Promise<void>;
}
/**
 * Synchronous phase of plugin bootstrap.
 *
 * OpenClaw's plugin loader requires `register()` to be synchronous, so all
 * tool/hook/service registration must complete before we hand control back.
 * Anything that requires I/O that CAN be sync (SQLite via better-sqlite3,
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
 *   - fetching the Slack bot token from the credential vault and starting
 *     the reactions poller
 *   - session recovery (mark stale sessions as interrupted, notify Slack)
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